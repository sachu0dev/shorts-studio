"""WhisperX transcription — the only transcript source.

Three models run in sequence and each is freed before the next loads, because on
a 6 GB card they do not fit together:

  faster-whisper  ->  wav2vec2 forced alignment  ->  pyannote diarization

Platform subtitles are deliberately not used anywhere. Their timings are
sentence-level, which is what produced the caption desync this stage removes.
"""

import gc
import os
import re
import subprocess
import sys
from pathlib import Path

from _base import read_json, run_stage, write_json

SAMPLE_RATE = 16000

# Tried in order; each entry is (model, compute_type, batch_size).
# Recorded in the artifact as `modelTier` so the corpus tells us what 6 GB needs.
MODEL_LADDER = [
    ("large-v3", "int8_float16", 8),
    ("distil-large-v3", "int8_float16", 8),
    ("medium", "int8", 4),
    ("small", "int8", 4),
    ("base", "int8", 4),
]

DEVANAGARI = re.compile(r"[ऀ-ॿ]+")


def _free() -> None:
    """Between-model teardown. The finally block in _base only covers exit."""
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _is_oom(e: Exception) -> bool:
    text = f"{type(e).__name__}: {e}".lower()
    return "out of memory" in text or "cuda error" in text or "cublas" in text


def extract_audio(src: Path, dst: Path) -> None:
    """16 kHz mono PCM — what every model downstream expects."""
    if dst.exists():
        return
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(dst)],
        check=True,
    )


def load_audio(path: Path):
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32")
    if sr != SAMPLE_RATE:
        raise RuntimeError(f"expected {SAMPLE_RATE} Hz, got {sr}")
    if data.ndim > 1:
        data = data.mean(axis=1)
    return np.ascontiguousarray(data)


def romanize(text: str) -> str:
    """Devanagari -> Latin, leaving Latin runs untouched.

    Transliterating the whole string would mangle the English half of Hinglish,
    so only Devanagari runs are converted.
    """
    if not DEVANAGARI.search(text):
        return text
    from indic_transliteration import sanscript

    return DEVANAGARI.sub(
        lambda m: sanscript.transliterate(m.group(0), sanscript.DEVANAGARI, sanscript.ITRANS).lower(),
        text,
    )


#  whisperx's own `detect_language()` always reads `audio[:N_SAMPLES]` — the
#  FIRST 30 seconds, hardcoded (see whisperx/asr.py). A huge share of Indian
#  YouTube videos open with an English sponsor read or a cold-open intro line,
#  so that single window locks the WHOLE transcript to English even when the
#  rest of the video is Hinglish — wrong decoding throughout, and phase 2's
#  wav2vec2 alignment model gets picked for the wrong language too.
#
#  Fix: sample at 30 %, 55 %, and 70 % of the clip duration. 0.30 reliably
#  skips a typical 30–60 s English intro; 0.55 and 0.70 land in the main body
#  of the video where the real language lives. We deliberately skip both the
#  cold-open (<30 %) and the outro/CTA (>80 %) zones.
LANG_SAMPLE_SECONDS = 30
LANG_SAMPLE_FRACTIONS = (0.30, 0.55, 0.70)  # past intro → mid-body → late-body


def _detect_language(model, audio) -> str:
    """Vote across three points spread through the real duration, deliberately
    skipping the first 30 % (cold-open / English intro) and last 20 % (outro).
    `detect_language` only runs the encoder on one mel-spectrogram chunk, so
    sampling three of them is cheap next to a full transcription.

    Sampling positions (fraction of total length):
      • 30 % — just past any English intro / sponsor segment
      • 55 % — mid-body, typically the main content language
      • 70 % — late-body, confirms the dominant language

    Majority vote wins; a perfect 3-way split falls back to the middle (55 %)
    sample as the most representative single point.
    """
    window = LANG_SAMPLE_SECONDS * SAMPLE_RATE
    if len(audio) <= window:
        # Short clip — can't skip the intro; sample the whole thing as-is.
        return model.detect_language(audio)

    votes = []
    for frac in LANG_SAMPLE_FRACTIONS:
        # Centre the 30-second window on `frac`, clamped so it never overruns.
        start = min(len(audio) - window, max(0, int(len(audio) * frac) - window // 2))
        lang = model.detect_language(audio[start : start + window])
        print(
            f"[transcribe] language sample @ {frac:.0%} of clip → {lang}",
            flush=True,
        )
        votes.append(lang)
    print(f"[transcribe] language votes across the clip: {votes}", flush=True)
    # majority; an even 3-way split falls back to the middle sample as the
    # most representative single point rather than an arbitrary pick
    return max(set(votes), key=votes.count) if len(set(votes)) < len(votes) else votes[len(votes) // 2]


def transcribe(audio, device: str):
    """Walks the VRAM ladder. Returns (result, tier).

    Language is detected once with the first model that loads successfully —
    even if that model later OOMs during transcription. The detected language
    is then reused for every fallback tier, because a weaker model's language
    probe is less reliable than the stronger model's measured result.

    Why this matters: large-v3 (7 GB) often correctly identifies Hinglish as
    `hi` before running out of VRAM for the full transcription. distil-large-v3
    (3 GB) loads fine but its language probe is less accurate and can flip to
    `en` for the same audio — the OOM was in the *transcription*, not the probe.
    We trust the stronger model's language measurement and carry it forward.
    """
    import whisperx

    # ── Step 1: detect language with the best model we can load ──────────────
    # Walk the ladder just for the probe; stop as soon as one succeeds.
    detected_language: str | None = None
    for name, compute_type, _batch_size in MODEL_LADDER:
        try:
            print(f"[transcribe] probing language with {name} ({compute_type})", flush=True)
            probe_model = whisperx.load_model(name, device, compute_type=compute_type)
            detected_language = _detect_language(probe_model, audio)
            del probe_model
            _free()
            print(f"[transcribe] language locked to '{detected_language}' (from {name})", flush=True)
            break
        except Exception as probe_err:  # noqa: BLE001
            _free()
            if _is_oom(probe_err):
                print(f"[transcribe] {name} OOM during language probe; trying next tier", flush=True)
                continue
            # Non-OOM during probe — re-raise immediately, something is wrong.
            raise

    if detected_language is None and device == "cuda":
        print("[transcribe] GPU VRAM full for all tiers; trying CPU for language probe", flush=True)
        for name in ["medium", "small", "base"]:
            try:
                print(f"[transcribe] probing language on CPU with {name}", flush=True)
                probe_model = whisperx.load_model(name, "cpu", compute_type="int8")
                detected_language = _detect_language(probe_model, audio)
                del probe_model
                _free()
                print(f"[transcribe] language locked to '{detected_language}' (from {name} on CPU)", flush=True)
                device = "cpu"
                break
            except Exception as cpu_err:  # noqa: BLE001
                _free()
                print(f"[transcribe] CPU probe with {name} failed: {cpu_err}", flush=True)

    if detected_language is None:
        raise RuntimeError("no model fit in VRAM or CPU even for language detection")

    # ── Step 2: transcribe with the best model that can handle the full audio ─
    last = None
    for name, compute_type, batch_size in MODEL_LADDER:
        try:
            print(f"[transcribe] loading {name} ({compute_type})", flush=True)
            model = whisperx.load_model(name, device, compute_type=compute_type)
            # Reuse the language we already measured — do NOT re-probe here.
            result = model.transcribe(audio, batch_size=batch_size, language=detected_language)
            del model
            _free()
            return result, f"{name}/{compute_type}"
        except Exception as e:  # noqa: BLE001 - want the ladder to survive any load failure
            last = e
            _free()
            if not _is_oom(e):
                raise
            print(f"[transcribe] {name} did not fit ({e}); trying next tier", flush=True)

    # ── Step 3: CPU fallback if GPU ladder completely failed ──────────────────
    print("[transcribe] GPU ladder exhausted; attempting CPU transcription fallback", flush=True)
    for name in ["medium", "small", "base"]:
        try:
            print(f"[transcribe] loading {name} on CPU", flush=True)
            model = whisperx.load_model(name, "cpu", compute_type="int8")
            result = model.transcribe(audio, batch_size=4, language=detected_language)
            del model
            _free()
            return result, f"{name}/cpu-int8"
        except Exception as cpu_e:  # noqa: BLE001
            _free()
            print(f"[transcribe] CPU fallback {name} failed: {cpu_e}", flush=True)

    raise RuntimeError(f"no model fit in VRAM or CPU; last error: {last}")


def diarize(audio, aligned: dict, device: str) -> tuple:
    """Speaker labels. Fails soft: a transcript without speakers still renders."""
    token = os.environ.get("HF_TOKEN") or None
    if not token:
        return aligned, None, "HF_TOKEN not set — no speaker labels"

    # Pinned: whisperx's default has already moved once (3.1 -> community-1) and a
    # silent change means a differently-gated repo and a confusing 403.
    model_name = os.environ.get("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")

    try:
        from whisperx.diarize import DiarizationPipeline, assign_word_speakers

        pipeline = DiarizationPipeline(model_name=model_name, token=token, device=device)
        segments = pipeline(audio)
        out = assign_word_speakers(segments, aligned)
        del pipeline
        _free()
        return out, None, None
    except Exception as e:  # noqa: BLE001
        _free()
        text = str(e)
        hint = ""
        if any(k in text for k in ("401", "403", "gated", "restricted", "authoriz")):
            hint = (f" — accept the terms at hf.co/{model_name} while signed in as the"
                    " account that owns HF_TOKEN, then re-run")
        return aligned, None, f"diarization failed ({model_name}): {text.splitlines()[0]}{hint}"


def main(d: Path) -> dict:
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"

    ingest = read_json(d, "ingest.json")
    if not ingest or not ingest.get("video"):
        raise SystemExit("ingest.json missing or has no video — run the ingest stage first")
    src = d / ingest["video"]

    wav = d / "audio.wav"
    extract_audio(src, wav)
    audio = load_audio(wav)

    result, tier = transcribe(audio, device)
    language = result.get("language") or "en"
    print(f"[transcribe] language={language} tier={tier}", flush=True)

    # ── forced alignment: the whole reason word timings become real ──────────
    align_warning = None
    try:
        align_model, meta = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(result["segments"], align_model, meta, audio, device,
                                return_char_alignments=False)
        del align_model
        _free()
    except Exception as e:  # noqa: BLE001
        # No alignment model for this language: keep segment timings rather than
        # failing the job, but say so loudly — captions will be less precise.
        align_warning = f"alignment unavailable for '{language}': {e}"
        print(f"[transcribe] WARNING {align_warning}", flush=True)
        _free()

    result, _, diar_warning = diarize(audio, result, device)
    if diar_warning:
        print(f"[transcribe] WARNING {diar_warning}", flush=True)

    # ── flatten to the word contract ────────────────────────────────────────
    words = []
    unaligned = 0
    low_conf = 0
    for seg in result.get("segments", []):
        seg_speaker = seg.get("speaker")
        for w in seg.get("words", []) or []:
            text = (w.get("word") or "").strip()
            if not text:
                continue
            start, end = w.get("start"), w.get("end")
            if start is None or end is None:
                unaligned += 1
                continue  # never fabricate a timestamp
            score = w.get("score")
            conf = float(score) if isinstance(score, (int, float)) else None
            if conf is not None and conf < 0.5:
                low_conf += 1
            words.append({
                "w": romanize(text),
                "wNative": text,
                "start": round(float(start), 3),
                "end": round(float(end), 3),
                "speaker": w.get("speaker") or seg_speaker,
                "confidence": round(conf, 3) if conf is not None else None,
            })

    speakers = sorted({w["speaker"] for w in words if w["speaker"]})
    warnings = [x for x in (align_warning, diar_warning) if x]

    print(f"[transcribe] {len(words)} words, {len(speakers)} speaker(s), "
          f"{unaligned} unaligned, {low_conf} low-confidence", flush=True)

    return {
        "language": language,
        "romanized": bool(DEVANAGARI.search("".join(w["wNative"] for w in words[:400]))),
        "modelTier": tier,
        "words": words,
        "speakers": speakers,
        "unalignedWords": unaligned,
        "lowConfidenceRatio": round(low_conf / len(words), 4) if words else 0.0,
        "warnings": warnings,
    }


def _self_test() -> None:
    import numpy as np

    class FakeModel:
        def __init__(self, answers):
            self.answers = answers
            self.calls = 0

        def detect_language(self, audio):
            lang = self.answers[self.calls % len(self.answers)]
            self.calls += 1
            return lang

    # 200 s audio → well past the 3-sample split at 30/55/70 %
    long_audio = np.zeros(200 * SAMPLE_RATE, dtype="float32")

    # English intro (30 %) is outvoted by Hinglish mid/late body
    assert _detect_language(FakeModel(["en", "hi", "hi"]), long_audio) == "hi"
    # unanimous Hinglish
    assert _detect_language(FakeModel(["hi", "hi", "hi"]), long_audio) == "hi"
    # 3-way split → falls back to the middle (55 %) sample, not vote order
    assert _detect_language(FakeModel(["en", "hi", "ta"]), long_audio) == "hi"

    # audio no longer than one window (≤30 s) is never split
    short_audio = np.zeros(10 * SAMPLE_RATE, dtype="float32")
    m = FakeModel(["en"])
    assert _detect_language(m, short_audio) == "en"
    assert m.calls == 1

    print("[transcribe] self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        d, out = run_stage("transcribe", main)
        write_json(d, "transcript.json", out)
