"""Active speaker detection for ONE clip window (Light-ASD, GPU).

Answers the one question diarization cannot: *which rectangle on screen is
talking right now*. Reference clippers assign a fixed left/right slot and break
the moment people move or the camera cuts; this measures it per face track, per
sample.

Runs as its own process invocation with the card to itself — face detection is
CPU (YuNet) and WhisperX has already exited. Model weights are 4 MB; the peak is
activations, which is why inference is chunked rather than run over the whole
clip at once.

Raw scores only. Hysteresis and speaker binding live in `binding.ts`, where they
are unit-testable without a GPU.
"""

import subprocess
import sys
from pathlib import Path

from _base import read_json, run_stage, write_json

VENDOR = Path(__file__).resolve().parents[1] / "vendor" / "lightasd"
# 4 MB, gitignored with the other weights. Fetch with:
#   curl -sL https://raw.githubusercontent.com/Junhua-Liao/Light-ASD/main/weight/finetuning_TalkSet.model \
#     -o worker/models/lightasd_finetuning_TalkSet.model
MODEL = Path(__file__).resolve().parents[1] / "models" / "lightasd_finetuning_TalkSet.model"

# Light-ASD was trained at 25 fps video / 100 Hz MFCC. These are not tunables —
# the 4:1 ratio is baked into the audio-visual backend.
VIDEO_FPS = 25
AUDIO_RATE = 16000
MFCC_PER_FRAME = 4

# The crop the model expects: the reference pipeline pads the detection box by
# 40%, resizes to 224, then keeps the middle 112. Done here in one step.
CROP_SCALE = 0.40
FACE_PX = 112

# Detection is 4 Hz, so a face's position at 25 fps is interpolated. Longer than
# this between samples is a real dropout, not a missed detection — same rule and
# same constant as camera.ts.
MAX_SAMPLE_GAP = 0.75

# Decode width. The crop is ~2.8x the face box, so a 0.12-high facecam still
# lands ~120 px before the resize to 112 — above native resolution buys nothing.
DECODE_WIDTH = 1280

# Frames per forward pass. The GRU is bidirectional over the chunk, so this
# trades a little temporal context for a bounded activation peak.
# ponytail: fixed 10 s chunk; make it VRAM-adaptive only if a longer clip OOMs.
CHUNK = 250

# Multi-camera footage re-mints a track id at every cut, so a 2-person podcast
# window can arrive with 20+ tracks. Scoring all of them is ~10x the work for
# fragments that are two seconds of one camera angle. A track has to cover this
# much of the window, and only the longest MAX_TRACKS survive.
MIN_TRACK_COVERAGE = 0.1
MAX_TRACKS = 6


def _probe_size(video: Path) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = (int(x) for x in out.split("x"))
    return w, h


def read_audio(video: Path, start: float, end: float):
    """16 kHz mono PCM for the window, as float32 in the int16 range.

    python_speech_features expects the raw integer scale, not [-1, 1].
    """
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(video),
         "-vn", "-ac", "1", "-ar", str(AUDIO_RATE), "-f", "s16le", "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


def read_gray_frames(video: Path, start: float, end: float, width: int, height: int):
    """Yields grayscale frames at VIDEO_FPS. One sequential decode, no seeking."""
    import numpy as np

    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(video),
         "-vf", f"fps={VIDEO_FPS},scale={width}:{height}",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    n = width * height
    try:
        while True:
            buf = proc.stdout.read(n)
            if len(buf) < n:
                return
            yield np.frombuffer(buf, dtype=np.uint8).reshape(height, width)
    finally:
        proc.stdout.close()
        proc.wait()


def box_at(samples: list[dict], t: float):
    """Interpolated (cx, cy, w, h) in normalized coords, or None when absent."""
    if not samples or t < samples[0]["t"] or t > samples[-1]["t"]:
        return None
    for i in range(1, len(samples)):
        b = samples[i]
        if b["t"] < t:
            continue
        a = samples[i - 1]
        if b["t"] - a["t"] > MAX_SAMPLE_GAP:
            return None
        span = b["t"] - a["t"]
        f = 0.0 if span <= 0 else (t - a["t"]) / span
        return tuple(a[k] + f * (b[k] - a[k]) for k in ("cx", "cy", "w", "h"))
    last = samples[-1]
    return (last["cx"], last["cy"], last["w"], last["h"])


def crop_face(frame, box, out_px: int = FACE_PX):
    """The model's expected face crop, padded where the box runs off frame."""
    import cv2
    import numpy as np

    h, w = frame.shape[:2]
    cx, cy, bw, bh = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    bs = max(bw, bh) / 2
    if bs <= 1:
        return None
    half = 0.7 * bs  # centre half of the 2.8*bs reference region
    x0, x1 = round(cx - half), round(cx + half)
    y0, y1 = round(cy - 0.3 * bs), round(cy + 1.1 * bs)

    pad = max(0, -x0, -y0, x1 - w, y1 - h)
    if pad:
        frame = np.pad(frame, pad, mode="constant", constant_values=110)
        x0, x1, y0, y1 = x0 + pad, x1 + pad, y0 + pad, y1 + pad
    patch = frame[y0:y1, x0:x1]
    if patch.size == 0:
        return None
    return cv2.resize(patch, (out_px, out_px), interpolation=cv2.INTER_AREA)


def load_model(device):
    """Light-ASD (MIT, Liao 2023) plus the audio-visual classifier head.

    The head lives in the training loss module upstream, so it is rebuilt here
    from the same checkpoint rather than pulling in `loss.py` and its optimizer.
    """
    import torch

    if not MODEL.exists():
        raise SystemExit(f"ASD weights missing: {MODEL}")
    sys.path.insert(0, str(VENDOR))
    from model.Model import ASD_Model  # noqa: E402  (vendored, path set above)

    state = torch.load(MODEL, map_location="cpu")
    state = {k.replace("module.", ""): v for k, v in state.items()}

    net = ASD_Model()
    net.load_state_dict({k[len("model."):]: v for k, v in state.items() if k.startswith("model.")})
    head = torch.nn.Linear(128, 2)
    head.load_state_dict({"weight": state["lossAV.FC.weight"], "bias": state["lossAV.FC.bias"]})
    return net.to(device).eval(), head.to(device).eval()


def score_track(net, head, device, faces, mfcc, present):
    """P(speaking) per 25 fps frame for one track. Absent frames stay None."""
    import numpy as np
    import torch

    out: list = [None] * len(present)
    idx = [i for i, p in enumerate(present) if p]
    if not idx:
        return out

    with torch.no_grad():
        for c0 in range(0, len(idx), CHUNK):
            block = idx[c0 : c0 + CHUNK]
            v = torch.from_numpy(np.stack([faces[i] for i in block])).float().unsqueeze(0).to(device)
            # The audio window follows the frames, so a track that appears late
            # is scored against the audio of the moment it is on screen.
            a = np.concatenate([mfcc[i * MFCC_PER_FRAME : (i + 1) * MFCC_PER_FRAME] for i in block])
            a = torch.from_numpy(a).float().unsqueeze(0).to(device)

            emb = net.forward_audio_visual_backend(
                net.forward_audio_frontend(a), net.forward_visual_frontend(v)
            )
            p = torch.softmax(head(emb), dim=-1)[:, 1].cpu().numpy()
            for j, i in enumerate(block):
                out[i] = round(float(p[j]), 4)
    return out


def to_samples(per_frame: list, n_samples: int, step: float) -> list:
    """25 fps scores → the 4 Hz grid every other artifact is on.

    Mean over the bin, not a point sample: a single frame is noise, and the
    hysteresis downstream is cheaper if what it consumes is already smooth.
    """
    out = []
    for k in range(n_samples):
        lo = int(k * step * VIDEO_FPS)
        hi = max(lo + 1, int((k + 1) * step * VIDEO_FPS))
        vals = [v for v in per_frame[lo:hi] if v is not None]
        out.append(round(sum(vals) / len(vals), 4) if vals else None)
    return out


def main(d: Path) -> dict:
    import argparse

    import numpy as np
    import torch
    from python_speech_features import mfcc as mfcc_fn

    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--clip-id", required=True)
    args, _ = ap.parse_known_args()

    ingest = read_json(d, "ingest.json")
    analysis = read_json(d, f"analysis/{args.clip_id}.json")
    if not ingest or not ingest.get("video"):
        raise SystemExit("ingest.json missing or has no video")
    if not analysis:
        raise SystemExit(f"analysis/{args.clip_id}.json missing — run analyze_clip first")

    video = d / ingest["video"]
    start, end = float(analysis["start"]), float(analysis["end"])
    step = float(analysis.get("sampleStep", 0.25))
    tracks = analysis.get("faceTracks") or []
    n_samples = max(1, round((end - start) / step))

    window = end - start
    scored = sorted(
        (t for t in tracks if (t["lastSeen"] - t["firstSeen"] + step) >= MIN_TRACK_COVERAGE * window),
        key=lambda t: -len(t["samples"]),
    )[:MAX_TRACKS]
    if len(scored) < len(tracks):
        print(f"[asd] {args.clip_id}: scoring {len(scored)} of {len(tracks)} tracks "
              f"(rest are sub-{MIN_TRACK_COVERAGE:.0%} cut fragments)", flush=True)
    tracks = scored

    if not tracks:
        print(f"[asd] {args.clip_id}: no face tracks — nothing to score", flush=True)
        return {"clipId": args.clip_id, "sampleStep": step, "scores": {}, "frames": 0}

    audio = read_audio(video, start, end)
    feats = mfcc_fn(audio, AUDIO_RATE, numcep=13, winlen=0.025, winstep=0.010)

    src_w, src_h = _probe_size(video)
    dec_w = min(DECODE_WIDTH, src_w)
    dec_h = max(2, round(src_h * dec_w / src_w / 2) * 2)

    # Crops for every track are taken in ONE decode pass — the alternative is
    # re-decoding the window per track, which is what makes naive ASD slow.
    crops: dict[int, list] = {t["id"]: [] for t in tracks}
    present: dict[int, list] = {t["id"]: [] for t in tracks}
    n_frames = 0
    for i, frame in enumerate(read_gray_frames(video, start, end, dec_w, dec_h)):
        t = i / VIDEO_FPS
        for tr in tracks:
            box = box_at(tr["samples"], t)
            patch = crop_face(frame, box) if box else None
            crops[tr["id"]].append(patch if patch is not None else np.full((FACE_PX, FACE_PX), 110, np.uint8))
            present[tr["id"]].append(patch is not None)
        n_frames = i + 1

    # Audio and video must agree on length or the backend adds mismatched tensors.
    n_frames = min(n_frames, len(feats) // MFCC_PER_FRAME)
    if n_frames <= 0:
        raise SystemExit("no decodable frames or audio in the clip window")
    for k in crops:
        crops[k] = crops[k][:n_frames]
        present[k] = present[k][:n_frames]

    device = "cuda" if torch.cuda.is_available() else "cpu"
    net, head = load_model(device)

    scores = {}
    for tr in tracks:
        per_frame = score_track(net, head, device, crops[tr["id"]], feats, present[tr["id"]])
        scores[str(tr["id"])] = to_samples(per_frame, n_samples, step)

    speaking = {k: sum(1 for v in s if v is not None and v >= 0.5) for k, s in scores.items()}
    print(f"[asd] {args.clip_id}: {len(tracks)} track(s), {n_frames} frames on {device}, "
          f"speaking samples {speaking}", flush=True)

    return {
        "clipId": args.clip_id,
        "sampleStep": step,
        "frames": n_frames,
        "device": device,
        "scores": scores,
    }


def self_test() -> None:
    """No GPU, no video — just the geometry and resampling that silently rot."""
    import numpy as np

    s = [{"t": 0.0, "cx": 0.2, "cy": 0.5, "w": 0.1, "h": 0.2},
         {"t": 0.25, "cx": 0.4, "cy": 0.5, "w": 0.1, "h": 0.2},
         {"t": 2.0, "cx": 0.4, "cy": 0.5, "w": 0.1, "h": 0.2}]
    assert box_at(s, -1) is None and box_at(s, 5) is None, "outside the track"
    assert abs(box_at(s, 0.125)[0] - 0.3) < 1e-9, "midpoint not interpolated"
    assert box_at(s, 1.0) is None, "a 1.75s dropout was treated as a face"

    # A face at the centre: the crop is 1.4*bs square, offset down onto the mouth.
    frame = np.zeros((200, 400), np.uint8)
    frame[100:130, 190:210] = 255
    p = crop_face(frame, (0.5, 0.5, 0.05, 0.15))
    assert p.shape == (FACE_PX, FACE_PX), p.shape
    # Off the left edge still returns a full crop rather than a truncated one.
    assert crop_face(frame, (0.0, 0.0, 0.05, 0.15)).shape == (FACE_PX, FACE_PX)
    assert crop_face(frame, (0.5, 0.5, 0.0, 0.0)) is None, "a zero-size box made a crop"

    # 25 fps -> 4 Hz: bins of 6-7 frames, absent frames do not poison the mean.
    per_frame = [1.0] * 25 + [None] * 25
    out = to_samples(per_frame, 8, 0.25)
    assert out[:4] == [1.0, 1.0, 1.0, 1.0], out
    assert out[4:] == [None, None, None, None], out
    assert to_samples([], 2, 0.25) == [None, None]
    print("[asd] self-test ok", flush=True)


if __name__ == "__main__":
    import argparse as _a

    _p = _a.ArgumentParser()
    _p.add_argument("--clip-id")
    _p.add_argument("--self-test", action="store_true")
    _args = _p.parse_known_args()[0]
    if _args.self_test:
        self_test()
    else:
        _d, _out = run_stage("asd", main)
        write_json(_d, f"asd/{_args.clip_id}.json", _out)
