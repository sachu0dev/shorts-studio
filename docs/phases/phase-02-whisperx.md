# Phase 2 — WhisperX transcription

**Goal:** real word-level timestamps and speaker labels, replacing VTT parsing
and the whisper fallback.

> **Status: built 2026-08-01.** Decision changed by the operator: **WhisperX runs
> on every job and subtitles are never downloaded at all** — `parseVtt` and the
> whisper fallback are deleted, not demoted. Gates 1, 4 and 5 pass. Gate 3
> (speaker labels) is blocked on accepting a gated Hugging Face repo. See
> *What actually happened*.

## Why now

This is the highest-visibility fix in the plan. Today `splitWordsWithTiming`
([captions.ts:35](../../server/pipeline/captions.ts#L35)) takes a caption group
and divides its duration **evenly across the words**. That is the caption desync
you can see in current output — a five-word group where one word is long and four
are short gets four wrong timings out of five.

WhisperX also collapses three stages into one call: transcription
(faster-whisper), **wav2vec2 forced alignment** for true word timings, and
pyannote diarization with word-to-speaker assignment. That last output —
"word X, at time T, spoken by SPEAKER_01" — is exactly what the router needs
in phase 7.

## Scope

One Python stage producing `transcript.json`. Deletion of the interpolation.

## Out of scope

Using speaker labels for composition — that's phase 7 onward. This phase just
*produces* them. Boundary snapping is phase 3.

## Changes

### `worker/stages/transcribe.py` (new)

```python
model = whisperx.load_model("large-v3", device="cuda", compute_type="int8_float16")
result = model.transcribe(audio, batch_size=8)
align_model, meta = whisperx.load_align_model(result["language"], device="cuda")
result = whisperx.align(result["segments"], align_model, meta, audio, device="cuda")
diarize = whisperx.DiarizationPipeline(use_auth_token=HF_TOKEN, device="cuda")
result = whisperx.assign_word_speakers(diarize(audio), result)
```

**VRAM ladder for 6 GB** — try in order, record which one the corpus needs:

| Model | `compute_type` | Approx VRAM |
|---|---|---|
| `large-v3` | `int8_float16` | ~4.5 GB |
| `distil-large-v3` | `int8_float16` | ~2.5 GB |
| `medium` | `int8` | ~1.5 GB |

`batch_size=8` is the starting point; drop to 4 on OOM. Each of the three models
(whisper, align, diarize) is loaded and **freed** before the next — the teardown
from `_base.py` runs between them, not just at exit.

### Hinglish handling — decision 3

Captions render in **romanized Latin script**, so:

- Do **not** pin `language="hi"`. Let WhisperX detect. Hinglish sources usually
  detect as `hi` or `en` depending on the mix, and the alignment model differs.
- If detection returns `hi`, WhisperX outputs Devanagari. **Romanize it** before
  writing `transcript.json` — a transliteration pass (`indic-transliteration`
  or equivalent) converts देवनागरी → Latin.
- Keep both: `text` (romanized, what renders) and `textNative` (original, for
  the LLM, which reads Devanagari fine and will pick better clips from it).

This is the only place the Hinglish decision costs anything. Because captions
are Latin, **no font work is needed anywhere** — Anton and the Google Fonts
picker in `fonts.ts` work unchanged.

### Alignment quality guards

Master plan §1.2 warns wav2vec2 alignment is *less* noise-robust than the
transcription itself, and unplaceable words silently inherit a neighbour's
timestamp — worst on numbers and proper nouns.

1. Run an ffmpeg denoise pass (`afftdn`) into `audio.wav` when input loudness
   variance suggests a noisy source.
2. Write `confidence` per word. Where WhisperX reports no score, mark
   `confidence: null` — **do not fabricate a value**.
3. Log the fraction of words below threshold. If it's high on a corpus source,
   that's a data point for phase 13, not a silent failure.

### `server/pipeline/transcribe.ts`

Replace `whisperFallback` with a `python.ts` call. **Keep `parseVtt`** — it's
still the fastest path for a quick draft and costs nothing to retain, but it is
no longer the default.

### `server/pipeline/captions.ts` — delete `splitWordsWithTiming`

Real timings supersede it. `buildAss` in `edit.ts:23` reads `plan.captions[].text`
and splits; it now reads words with real `start`/`end` straight from the
transcript. `parseEmphasis` stays — `**punch**` marking is still LLM-supplied.

### `server/systemCheck.ts`

Drop the `whisper` binary check. Add a WhisperX import check with a readable
error when `HF_TOKEN` is missing or the pyannote terms weren't accepted —
master plan §7 calls for a clear error, not a stack trace.

## Contracts

`transcript.json`:

```jsonc
{
  "schemaVersion": 1,
  "language": "hi",
  "romanized": true,
  "words": [
    { "w": "insane", "wNative": "insane", "start": 143.12, "end": 143.44,
      "speaker": "SPEAKER_01", "confidence": 0.91 }
  ],
  "speakers": ["SPEAKER_00", "SPEAKER_01"],
  "lowConfidenceRatio": 0.04
}
```

## Gate

1. Side-by-side against the phase-0 baseline on all four corpus sources:
   **captions land on the word.** This is judged by eye and it is the point of
   the phase.
2. Hinglish source produces readable romanized captions, no boxes, no Devanagari.
3. Podcast source produces ≥2 distinct speakers in `speakers[]`.
4. Peak VRAM from `job.json` stays under ~5 GB. Record which model tier was needed.
5. `npm test` green after `splitWordsWithTiming` is deleted.

## Tests

- `transcribe.test.ts` — parse a fixture `transcript.json` into `Segment[]`;
  romanization is applied when `language === "hi"`.
- `captions.test.ts` — update: assert word timings come from the transcript
  and are **not** evenly spaced. Delete the interpolation tests.
- `edit.test.ts` — `buildAss` emits one Dialogue per transcript word with its
  real timing.

## What actually happened

### The plan said keep `parseVtt`; the operator said always WhisperX

The plan kept VTT as "the fastest path for a quick draft". That was overruled:
subtitles are no longer downloaded at all. Consequences, all good ones:

- `downloadVideo` lost its entire second yt-dlp pass — **ingest dropped from
  ~12s to ~5s** on the solo source.
- `parseVtt`, `whisperFallback` and `pickSubtitle` are deleted along with their
  tests. The `en.*` translated-subtitle bug class from phase 0 no longer exists.
- WhisperX is now **core, not optional**, so `systemCheck` reports a missing
  import as `error` rather than a warning.

### Measured on the solo corpus source

| | |
|---|---|
| Model tier | `large-v3` / `int8_float16` — the top of the ladder fits |
| Peak VRAM | **4748 MiB** (device-wide) |
| Transcribe time | 24–28s for a 226s video, models warm |
| Words | 536, **0 unaligned**, 2.6% low-confidence |

### Two bugs found while building

**1. Reported VRAM was wrong by 6.5×.** `torch.cuda.max_memory_allocated()` only
sees torch's own allocator, and faster-whisper runs on **CTranslate2**, which
allocates outside it. The first run reported **731 MiB** for a job actually using
**4748 MiB**. On a 6 GB budget that is the difference between "plenty of room"
and "nearly full". `_base.py` now samples `torch.cuda.mem_get_info()` device-wide
on a background thread; both numbers are written (`peakVramMb`,
`peakVramTorchMb`) so the discrepancy stays visible.

**2. Real timings introduced caption flicker.** Speech has 40–120 ms of silence
between words. Ending each caption at the word's true end blanked the screen for
2–3 frames every word — worse-looking than the desync it replaced. `wordsForClip`
now holds a word until the next one starts when the gap is ≤0.5s. **Only the
start drives sync**, so this costs no accuracy, and genuine pauses stay pauses.

### Diarization: whisperx changed the default model

The plan's snippet used `use_auth_token=` and implied
`pyannote/speaker-diarization-3.1`. In whisperx 3.8.6 the kwarg is `token=` and
the default model is **`pyannote/speaker-diarization-community-1`** — a
differently-gated repo, so accepting the 3.1 terms does nothing. The model is now
pinned explicitly (overridable via `DIARIZE_MODEL`) and the error names the exact
repo to accept.

**Diarization fails soft**: a 403 costs speaker labels, never the transcript.

### Hinglish is detected, not assumed

Locked decision 3 said "India / Hinglish". Running the Hinglish corpus source
(Raj Shamani × Nikhil Kamath) showed the assumption was too strong: it
transcribed as **7228 words of pure English, zero Devanagari**. Indian creators
publish in English constantly.

The prompt used to hardwire *"viral shorts editor for the Indian market"* and
*"hashtags: mix of English + Hindi/Hinglish"*, which would have stamped Hinglish
onto English content. It now takes the **detected** language and romanization
flag and emits one of two binding rules:

- **Hinglish** (`language=hi` or Devanagari was transliterated) — write in the
  same romanized Hinglish register the speaker uses, never Devanagari.
- **Anything else** — write in that language and *"do NOT sprinkle in Hindi or
  Hinglish words"*, because forced code-switching reads as inauthentic.

Audience stays India; the *language* follows the source. Verified on the real
English transcript: titles, hooks and hashtags came back fully English
(`#StockMarketIndia`, `#BangaloreLife`) with no forced Hindi.

### A pre-existing render bug this surfaced

`renderThumbnail` interpolated AI text straight into ffmpeg's `drawtext`. Clip 6
of that run was titled **"80% Traders Lose"** — `drawtext` reads `%` as a format
sequence, so ffmpeg exited 234 and killed the job after five clips had already
rendered. Clip 10 ("0.1%") would have failed next.

Fixed with `expansion=none` plus an `escapeDrawtext()` helper that strips the
characters which would close the quoted argument. **The reason it took so long to
find is that `renderClip`/`renderThumbnail` were called with `() => {}`**, so
ffmpeg's stderr was discarded and the error read only `exited with code 234`.
The render stage now keeps the last 15 lines and attaches them to the failure.

### Also changed (operator request, outside the phase plan)

**Clip count is now decided by the model.** The UI default is `Auto`; the prompt
asks how many clips the video *genuinely* supports between 1 and
`floor(duration/90)` capped at 10, and explicitly says a weak clip costs more
than a missing one. On the 226s solo source it chose **2**, not the old static 3.
A fixed count is still selectable.

## Risks

| Risk | Mitigation |
|---|---|
| `large-v3` OOMs on 6 GB | Documented model ladder; fall to `distil-large-v3` |
| Alignment degrades on noisy audio | Denoise pass; `confidence` written, never invented |
| Transliteration mangles English words inside Hindi text | Only romanize tokens actually in Devanagari; leave Latin runs alone |
| pyannote licence restricts commercial use | Master plan §7 flags this — **verify before Block C**, it does not block local use |
| Diarization splits one speaker into two | Phase 8's ASD binding corrects it; log speaker count against the corpus now |
