"""Face detection + CV signals for ONE selected clip window.

Master plan §4.1's biggest optimization lives here: this runs only on the
windows the LLM actually chose, not the whole source. A 25-minute video at
3 clips x 40s means CV on ~2 minutes instead of 25.

Deliberately CPU-only (OpenCV YuNet). The 6 GB card stays free for Whisper and,
later, active-speaker detection — the CPU has cores to spare.
"""

import statistics
import subprocess
from pathlib import Path

from _base import read_json, run_stage, write_json

# 4 Hz. At 30fps, per-frame detection is 120x the work for no measurable gain
# on talking-head footage.
SAMPLE_STEP = 0.25
SAMPLE_FPS = 1.0 / SAMPLE_STEP

# Detection runs on a downscaled frame — BlazeFace resamples to 128x128 anyway,
# so decoding at full 1080p is pure waste.
DETECT_WIDTH = 640

# 0.85 measured on the corpus: YuNet's real faces score 0.90-0.93, while
# everything below ~0.85 was texture/UI noise (h=0.03-0.05 boxes).
MIN_CONFIDENCE = 0.85
NMS_THRESHOLD = 0.3
# A track must survive this long to be real rather than a flicker.
MIN_TRACK_SECONDS = 0.5
# How many consecutive missed samples a track tolerates (0.75s) before it dies.
MAX_TRACK_GAP = 3
IOU_MATCH = 0.3
CENTROID_MATCH = 0.15
# Cosine similarity of two face signatures required to carry a track ACROSS a
# scene cut. 0.78 is the Youden-optimal split of the two measured populations
# in face_signature's note — see build_tracks for why this exists at all.
RE_ID_MATCH = 0.78

MODEL = Path(__file__).resolve().parents[1] / "models" / "face_detection_yunet_2023mar.onnx"


def read_frames(video: Path, start: float, end: float):
    """Yields downscaled RGB frames at SAMPLE_FPS.

    One ffmpeg decode, sequential — never seek repeatedly inside a long source
    (master plan §4.3). Frames come over a pipe so nothing hits disk.
    """
    import numpy as np

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(video)],
        capture_output=True, text=True, check=True,
    )
    src_w, src_h = (int(x) for x in probe.stdout.strip().split("x"))
    w = DETECT_WIDTH
    h = int(round(src_h * (w / src_w) / 2)) * 2

    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error",
         "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(video),
         "-vf", f"fps={SAMPLE_FPS},scale={w}:{h}",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    frame_bytes = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3), src_w, src_h
    finally:
        proc.stdout.close()
        proc.wait()


def detect_faces(video: Path, start: float, end: float) -> tuple[list[list[dict]], int, int]:
    """Returns (per-sample detections in NORMALIZED coords, source width, height).

    YuNet, not MediaPipe. Measured on the corpus, BlazeFace short-range is built
    for ~2m selfie distance and failed on real footage: it missed the gaming
    facecam entirely, then emitted 0.4-confidence boxes covering head+torso and a
    background monitor. YuNet found the facecam at h=0.12 with 0.90 confidence
    and both podcast faces at 0.92+.

    It also avoids a licensing problem: the documented YOLOv8n-face fallback
    pulls in AGPL ultralytics, which phase 23 would have to unpick before selling
    anything. YuNet ships with the already-installed OpenCV under Apache-2.0.
    """
    import cv2

    if not MODEL.exists():
        raise SystemExit(f"face model missing: {MODEL}")

    detector = cv2.FaceDetectorYN.create(str(MODEL), "", (320, 320), MIN_CONFIDENCE, NMS_THRESHOLD, 5000)

    per_sample: list[list[dict]] = []
    src_w = src_h = 0
    for frame, src_w, src_h in read_frames(video, start, end):
        h, w = frame.shape[:2]
        detector.setInputSize((w, h))
        # YuNet wants BGR; read_frames yields RGB
        _, faces = detector.detect(frame[:, :, ::-1].copy())
        dets = []
        for f in faces if faces is not None else []:
            x, y, bw, bh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[14])
            # normalized 0-1: resolution changes, ratios don't
            dets.append({
                "cx": round((x + bw / 2) / w, 4),
                "cy": round((y + bh / 2) / h, 4),
                "w": round(bw / w, 4),
                "h": round(bh / h, 4),
                "conf": round(score, 3),
                # Underscore keys never reach the artifact — stripped in build_tracks.
                "_look": face_signature(frame, x, y, bw, bh),
            })
        per_sample.append(dets)
    return per_sample, src_w, src_h


# A 6x6 RGB thumbnail of the face box padded 2x, mean-removed and L2-normalized.
# Crude on purpose: this is not recognition, it is "did the thing at this
# position stop being the same thing" (see RE_ID_MATCH).
#
# The padding is what makes it work. Scored against 862 same-face pairs and 395
# definitely-different pairs (two faces in one frame), three candidates:
#
#   6x6 RGB, 2x pad   J=0.82   <- this one
#   10x10 grey, tight J=0.76
#   8x8 hue/sat hist  J=0.73
#
# A tight grey crop of a face is mostly pose; hair, clothing and the bit of
# background beside someone's head are what actually differ between two people
# in the same room.
SIG_PX = 6
SIG_PAD = 0.5


def face_signature(frame, x: float, y: float, bw: float, bh: float):
    import cv2
    import numpy as np

    h, w = frame.shape[:2]
    cx, cy = x + bw / 2, y + bh / 2
    bw, bh = bw * (1 + 2 * SIG_PAD), bh * (1 + 2 * SIG_PAD)
    x0, y0 = max(0, int(cx - bw / 2)), max(0, int(cy - bh / 2))
    x1, y1 = min(w, int(cx + bw / 2)), min(h, int(cy + bh / 2))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    patch = cv2.resize(frame[y0:y1, x0:x1], (SIG_PX, SIG_PX), interpolation=cv2.INTER_AREA)
    patch = patch.astype(np.float32).ravel()
    patch -= patch.mean()
    n = float(np.linalg.norm(patch))
    return patch / n if n > 1e-6 else None


def looks_like(a, b) -> float:
    """Cosine similarity of two face signatures; 0 when either is missing."""
    if a is None or b is None:
        return 0.0
    return float(a @ b)


def _iou(a: dict, b: dict) -> float:
    ax1, ay1 = a["cx"] - a["w"] / 2, a["cy"] - a["h"] / 2
    ax2, ay2 = a["cx"] + a["w"] / 2, a["cy"] + a["h"] / 2
    bx1, by1 = b["cx"] - b["w"] / 2, b["cy"] - b["h"] / 2
    bx2, by2 = b["cx"] + b["w"] / 2, b["cy"] + b["h"] / 2
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = a["w"] * a["h"] + b["w"] * b["h"] - inter
    return inter / union if union > 0 else 0.0


def _dist(a: dict, b: dict) -> float:
    return ((a["cx"] - b["cx"]) ** 2 + (a["cy"] - b["cy"]) ** 2) ** 0.5


def build_tracks(per_sample: list[list[dict]], cuts: list[float] | None = None) -> list[dict]:
    """IoU + centroid matching at 4 Hz, with appearance checked across cuts.

    Boring on purpose: ByteTrack/Kalman is available if the corpus demands it,
    but this has no failure mode anyone has to debug at 3am.

    **Position alone cannot carry identity across a scene cut.** Measured on a
    multi-cam window, 13 of 22 tracks spanned a cut and one covered two
    different people — the tracker matched them because they happened to sit in
    the same part of frame either side of the cut. Phase 9 then cuts to "that
    speaker" and lands on someone else.

    Retiring every track at every cut fixes that and breaks phase 7: a solo
    window with 6 cuts in 25 s shatters into 7 fragments and the camera path
    gets 4 s of track for a 25 s clip. So the cut only *gates* the match — a
    track survives it when the face still looks like the same face.
    """
    tracks: list[dict] = []
    active: list[dict] = []
    next_id = 1
    cuts = cuts or []

    for i, dets in enumerate(per_sample):
        # Only samples that straddle a cut pay for the appearance check; inside
        # a shot the tracker behaves exactly as it did in phase 4.
        across_cut = any((i - 1) * SAMPLE_STEP < c <= i * SAMPLE_STEP for c in cuts)
        unmatched = list(dets)
        for tr in active:
            best, best_score = None, 0.0
            for d in unmatched:
                last = tr["samples"][-1]
                score = _iou(last, d)
                if score < IOU_MATCH and _dist(last, d) < CENTROID_MATCH:
                    score = IOU_MATCH  # close enough in space to count as the same face
                if score > best_score:
                    best, best_score = d, score
            if best is not None and best_score >= IOU_MATCH and across_cut and \
                    looks_like(tr["samples"][-1].get("_look"), best.get("_look")) < RE_ID_MATCH:
                # A different face in the same place. Retire rather than let the
                # gap tolerance grab the newcomer two samples later.
                best, tr["missed"] = None, MAX_TRACK_GAP + 1
            if best is not None and best_score >= IOU_MATCH:
                tr["samples"].append({"t": round(i * SAMPLE_STEP, 3), **best})
                tr["missed"] = 0
                unmatched.remove(best)
            else:
                tr["missed"] += 1

        # a gap tolerance keeps one track alive through a brief occlusion or a
        # single missed detection, instead of splitting it into two
        still_active = []
        for tr in active:
            (still_active if tr["missed"] <= MAX_TRACK_GAP else tracks).append(tr)
        active = still_active

        for d in unmatched:
            active.append({"id": next_id, "missed": 0, "samples": [{"t": round(i * SAMPLE_STEP, 3), **d}]})
            next_id += 1

    tracks.extend(active)

    out = []
    for tr in tracks:
        first, last = tr["samples"][0]["t"], tr["samples"][-1]["t"]
        if last - first + SAMPLE_STEP < MIN_TRACK_SECONDS:
            continue  # flicker, not a face
        samples = [{k: v for k, v in s.items() if not k.startswith("_")} for s in tr["samples"]]
        out.append({"id": tr["id"], "firstSeen": first, "lastSeen": last, "samples": samples})
    return sorted(out, key=lambda t: t["firstSeen"])


# A track must cover this share of the clip to count as "a person in this clip".
# Multi-camera footage re-mints a track ID at every cut, so the raw count on a
# 2-person podcast came out as 11. Raw count is still reported for debugging.
#
# NOTE for phase 5: even filtered, this OVER-COUNTS on multi-cam (the podcast
# measures 3 because one camera angle survives the filter as a fourth fragment).
# `medianConcurrentFaces` is the trustworthy "how many people" signal — it is
# computed from raw simultaneous detections and cannot be fooled by cuts.
SIGNIFICANT_TRACK_RATIO = 0.2


def compute_signals(per_sample, tracks, src_w, src_h) -> dict:
    total = len(per_sample) or 1
    with_face = sum(1 for s in per_sample if s)

    # motion of the most-present track: low means no camera work is needed
    subject_motion = 0.0
    if tracks:
        primary = max(tracks, key=lambda t: len(t["samples"]))
        xs = [s["cx"] for s in primary["samples"]]
        ys = [s["cy"] for s in primary["samples"]]
        if len(xs) > 1:
            subject_motion = round((statistics.pvariance(xs) + statistics.pvariance(ys)) ** 0.5, 4)

    heights = [d["h"] for s in per_sample for d in s]
    face_size_ratio = round(statistics.median(heights), 4) if heights else 0.0

    significant = [t for t in tracks if len(t["samples"]) >= total * SIGNIFICANT_TRACK_RATIO]

    # a 9:16 window is this wide, as a fraction of the frame's width
    aspect = (src_w / src_h) if src_h else 16 / 9
    window_w = (9 / 16) / aspect
    fits = False
    # Use the significant tracks only: fragments from other camera angles sit
    # elsewhere in frame and would inflate the span into a false "doesn't fit".
    considered = significant or tracks
    if considered:
        lefts = [min(s["cx"] - s["w"] / 2 for s in t["samples"]) for t in considered]
        rights = [max(s["cx"] + s["w"] / 2 for s in t["samples"]) for t in considered]
        span = max(rights) - min(lefts)
        fits = span <= window_w * 0.9  # >=5% margin each side

    # Independent of tracking entirely: how many faces are on screen at once.
    # Immune to cut-fragmentation, so it cross-checks distinctFaceTracks.
    counts = [len(s) for s in per_sample if s]
    median_concurrent = int(statistics.median(counts)) if counts else 0

    return {
        "faceCoverage": round(with_face / total, 4),
        "distinctFaceTracks": len(significant),
        "rawTrackCount": len(tracks),
        "medianConcurrentFaces": median_concurrent,
        "maxConcurrentFaces": max(counts) if counts else 0,
        "subjectMotion": subject_motion,
        "facesFitOneCrop": bool(fits),
        "faceSizeRatio": face_size_ratio,
    }


def main(d: Path) -> dict:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--clip-id", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    args, _ = ap.parse_known_args()

    ingest = read_json(d, "ingest.json")
    if not ingest or not ingest.get("video"):
        raise SystemExit("ingest.json missing or has no video")
    video = d / ingest["video"]

    # Scene cuts gate cross-cut track identity. Read here rather than passed in
    # from Node so the stage stays runnable on its own, like every other one.
    scenes = read_json(d, "scenes.json") or {}
    cuts = [c - args.start for c in scenes.get("cuts", []) if args.start < c < args.end]

    per_sample, src_w, src_h = detect_faces(video, args.start, args.end)
    tracks = build_tracks(per_sample, cuts)
    signals = compute_signals(per_sample, tracks, src_w, src_h)

    print(f"[analyze_clip] {args.clip_id}: {len(per_sample)} samples, "
          f"{signals['distinctFaceTracks']} track(s), coverage={signals['faceCoverage']}", flush=True)

    return {
        "schemaVersion": 4,
        "clipId": args.clip_id,
        "start": args.start,
        "end": args.end,
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "sampleStep": SAMPLE_STEP,
        "faceTracks": tracks,
        "signals": signals,
    }


if __name__ == "__main__":
    import argparse as _a

    _p = _a.ArgumentParser()
    _p.add_argument("--clip-id", required=True)
    _clip = _p.parse_known_args()[0].clip_id
    d, out = run_stage("analyze_clip", main)
    write_json(d, f"analysis/{_clip}.json", out)
