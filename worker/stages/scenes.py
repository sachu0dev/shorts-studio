"""Scene cuts + silences for the whole source.

CPU-only and deliberately cheap: this runs over the ENTIRE video (unlike the
face work in phase 4, which only runs on selected windows) because clip
selection needs cut points before any window exists.

Both signals answer the same question from different directions — "where is a
boundary a viewer would accept?" — so they live in one artifact.
"""

import re
import subprocess
from pathlib import Path

from _base import read_json, run_stage, write_json

# -30dB / 0.35s is the starting point from the phase plan. Recorded in the
# artifact so a bad threshold on loud sources is visible rather than guessed at.
SILENCE_NOISE_DB = -30
SILENCE_MIN_DUR = 0.35

# AdaptiveDetector over-triggers on fast-cut gaming footage; anything past this
# is treated as "this source is a cut-fest", which is itself a useful signal.
MAX_CUTS_PER_MINUTE = 60

# Decode is the entire cost of this stage; skipping frames is the only real lever.
FRAME_SKIP = 2

_SIL_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SIL_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


def detect_cuts(video: Path) -> tuple[list[float], str]:
    """Returns (cut timestamps, backend used).

    PyAV is tried first because OpenCV cannot decode AV1 — and YouTube serves a
    lot of AV1. The failure mode that cost an hour: OpenCV reads ZERO frames and
    PySceneDetect cheerfully reports "0 cuts" instead of raising. So the frame
    count is checked explicitly; a decoder that read nothing is an error, never
    an answer.
    """
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    last_error = None
    for backend in ("pyav", "opencv"):
        try:
            v = open_video(str(video), backend=backend)
            sm = SceneManager()
            sm.auto_downscale = True  # decode is the whole cost; detail is not needed
            sm.add_detector(AdaptiveDetector())
            # frame_skip=2 halves the wall time and, measured on the corpus,
            # returns the identical cut list shifted by <=0.1s — far inside the
            # 1.2s snapping budget it feeds.
            sm.detect_scenes(v, show_progress=False, frame_skip=FRAME_SKIP)

            frames = v.position.frame_num
            if frames < 2:
                last_error = f"{backend} decoded {frames} frames"
                print(f"[scenes] {backend} could not decode this file; trying next backend", flush=True)
                continue

            scenes = sm.get_scene_list()
            # scenes are (start, end) pairs; cut points are the starts after the first
            return [round(s[0].seconds, 3) for s in scenes[1:]], backend
        except Exception as e:  # noqa: BLE001 - try the next backend before giving up
            last_error = f"{backend}: {e}"
            continue

    raise RuntimeError(f"no video backend could decode {video.name} ({last_error})")


def detect_silences(video: Path) -> list[dict]:
    """ffmpeg's silencedetect, rather than a second audio library."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(video),
         "-af", f"silencedetect=noise={SILENCE_NOISE_DB}dB:d={SILENCE_MIN_DUR}",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    # silencedetect reports on stderr, interleaved with normal progress output
    out: list[dict] = []
    pending: float | None = None
    for line in proc.stderr.splitlines():
        m = _SIL_START.search(line)
        if m:
            pending = float(m.group(1))
            continue
        m = _SIL_END.search(line)
        if m and pending is not None:
            end = float(m.group(1))
            if end > pending:
                out.append({"start": round(max(0.0, pending), 3), "end": round(end, 3)})
            pending = None
    return out


def main(d: Path) -> dict:
    ingest = read_json(d, "ingest.json")
    if not ingest or not ingest.get("video"):
        raise SystemExit("ingest.json missing or has no video — run the ingest stage first")
    video = d / ingest["video"]
    duration = float(ingest.get("duration") or 0)

    cuts, backend = detect_cuts(video)
    silences = detect_silences(video)

    minutes = max(duration / 60.0, 1 / 60.0)
    cuts_per_min = len(cuts) / minutes
    print(f"[scenes] {len(cuts)} cuts ({cuts_per_min:.1f}/min), {len(silences)} silences", flush=True)

    return {
        "cuts": cuts,
        "silences": silences,
        "detector": "adaptive",
        "backend": backend,
        "cutsPerMinute": round(cuts_per_min, 2),
        "fastCut": cuts_per_min > MAX_CUTS_PER_MINUTE,
        "silenceNoiseDb": SILENCE_NOISE_DB,
        "silenceMinDur": SILENCE_MIN_DUR,
        "frameSkip": FRAME_SKIP,
    }


if __name__ == "__main__":
    d, out = run_stage("scenes", main)
    write_json(d, "scenes.json", out)
