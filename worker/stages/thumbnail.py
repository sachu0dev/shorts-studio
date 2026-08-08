"""Best-frame thumbnail selection (phase 13, thumbnail half).

Scores candidate frames from the face track samples phase 4 already detected,
against real pixels: sharpness via Laplacian variance (covers both defocus and
motion blur — a separate motion-blur term would just double-count the same
high-frequency signal), weighted by face size, detector confidence, and how
centered the face is. Screen-rec clips prefer phase 11's action-tracking
samples instead — a sharp empty frame is a worse thumbnail than a blurrier one
that actually shows the play.

No faces and no action data (b-roll, or gameplay before action tracking ran)
is not an error: `thumbnailTimestamp` from the LLM plan is already a valid
choice (CLAUDE.md rule 5), so this stage reports method="none" and Node keeps
using it.
"""

import argparse
from pathlib import Path

import cv2
import numpy as np

from _base import read_json, run_stage, write_json
from analyze_clip import SAMPLE_STEP, read_frames

# Tuned by eye against the phase 30/31 corpus clips, not a measured constant —
# revisit once phase 13's gate 5 ("clear, sharp, well-framed face") is checked
# against real thumbnails.
OFFCENTER_WEIGHT = 0.3
MAX_OFFCENTER = (0.5**2 + 0.5**2) ** 0.5  # corner-to-center distance, for 0..1 normalization


def _sharpness(frame: np.ndarray) -> float:
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def score_face_frames(tracks: list[dict], sharpness_by_index: list[float]):
    """Pure scorer: tracks' samples x per-frame sharpness -> (score, sample) or None.

    ponytail: no eyesOpenBonus term — needs a facial-landmark model (MediaPipe
    FaceMesh eye-aspect-ratio) this pipeline doesn't run anywhere yet. Add it
    if a picked thumbnail is ever caught mid-blink on real corpus output.
    """
    if not sharpness_by_index:
        return None
    lo, hi = min(sharpness_by_index), max(sharpness_by_index)
    span = hi - lo or 1.0

    best = None
    for track in tracks:
        for s in track.get("samples", []):
            idx = round(s["t"] / SAMPLE_STEP)
            if idx < 0 or idx >= len(sharpness_by_index):
                continue
            sharp = (sharpness_by_index[idx] - lo) / span
            size = s["w"] * s["h"]
            offcenter = ((s["cx"] - 0.5) ** 2 + (s["cy"] - 0.5) ** 2) ** 0.5 / MAX_OFFCENTER
            score = size * s["conf"] * sharp - OFFCENTER_WEIGHT * offcenter
            if best is None or score > best[0]:
                best = (score, s)
    return best


def main(d: Path) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--clip-id", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    args, _ = ap.parse_known_args()

    analysis = read_json(d, f"analysis/{args.clip_id}.json") or {}
    tracks = analysis.get("faceTracks") or []
    is_screen_rec = (analysis.get("classification") or {}).get("type") == "screen-rec"
    action = read_json(d, f"action/{args.clip_id}.json") if is_screen_rec else None
    action_region = (action or {}).get("actionRegion") or []

    if action_region:
        best = max(action_region, key=lambda r: r["confidence"])
        result = {
            "t": round(args.start + best["t"], 3),
            "score": best["confidence"],
            "method": "action-best-frame",
            "face": None,
        }
    elif not tracks:
        result = {"t": None, "score": None, "method": "none", "face": None}
    else:
        ingest = read_json(d, "ingest.json")
        if not ingest or not ingest.get("video"):
            raise SystemExit("ingest.json missing or has no video")
        video = d / ingest["video"]
        sharpness_by_index = [_sharpness(f) for f, _sw, _sh in read_frames(video, args.start, args.end)]
        picked = score_face_frames(tracks, sharpness_by_index)
        if picked is None:
            result = {"t": None, "score": None, "method": "none", "face": None}
        else:
            score, s = picked
            result = {
                "t": round(args.start + s["t"], 3),
                "score": round(score, 3),
                "method": "face-best-frame",
                "face": {"cx": s["cx"], "cy": s["cy"], "w": s["w"], "h": s["h"]},
            }

    print(f"[thumbnail] {args.clip_id}: method={result['method']} t={result['t']}", flush=True)
    return {"clipId": args.clip_id, **result}


def _self_test() -> None:
    # Sharper + larger + centered + higher-confidence must win over the
    # opposite on every axis at once.
    tracks = [{
        "samples": [
            {"t": 0.0, "cx": 0.5, "cy": 0.5, "w": 0.3, "h": 0.3, "conf": 0.95},
            {"t": 0.25, "cx": 0.1, "cy": 0.1, "w": 0.1, "h": 0.1, "conf": 0.9},
        ]
    }]
    picked = score_face_frames(tracks, [500.0, 10.0])
    assert picked is not None and picked[1]["t"] == 0.0, "sharper/larger/centered sample should win"

    assert score_face_frames([], [1.0, 2.0]) is None
    assert score_face_frames([{"samples": []}], [1.0]) is None
    assert score_face_frames(tracks, []) is None

    # A sample outside the sampled frame range is skipped, not crashed on.
    far = [{"samples": [{"t": 99.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "h": 0.2, "conf": 0.9}]}]
    assert score_face_frames(far, [1.0, 2.0]) is None

    print("[thumbnail] self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        d, out = run_stage("thumbnail", main)
        write_json(d, f"thumbnail/{out['clipId']}.json", out)
