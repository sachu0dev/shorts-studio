"""Action-region tracking for gameplay clips (phase 11).

Where is the interesting part of a 16:9 gameplay frame? Frame-differencing on
a downscaled copy (reusing `analyze_clip`'s frame reader — same downscale,
same 4 Hz sample clock every other CV stage already uses), accumulated into a
coarse grid, biased toward the centre and damped at the edges so a flashing
HUD corner can't win. The facecam box, when one was found, is excluded
entirely — a talking commentator is the highest-motion thing in frame and
would otherwise win every time.

Output is UNSMOOTHED per-sample estimates. Node wraps them as a synthetic
FaceTrack (reserved id -1) and runs them through `camera.ts`'s existing
deadzone/EMA/snap smoothing (phase 7) — the doc's "same machinery, different
target": no second smoothing implementation lives here.
"""

import argparse
from pathlib import Path

import numpy as np

from _base import read_json, run_stage, write_json
from analyze_clip import SAMPLE_STEP, read_frames

GRID = 8  # coarse cells per axis — cheap, and the ROI itself is coarse
EDGE_MARGIN = 0.10  # outer band treated as HUD, damped rather than dropped
EDGE_DAMP = 0.15  # residual weight kept in the damped band — a real action
# moment can still legitimately touch the edge, so it is damped, not zeroed
CENTER_SIGMA = 0.6  # gaussian width (grid units) for the crosshair centre bias
MOTION_EPS = 1e-3  # total energy below this reads as "no motion", not noise
HUD_SUPPRESSED_FRACTION = 0.15  # share of raw energy in the edge band that counts as "there was a HUD to suppress"


def _center_bias() -> np.ndarray:
    ys, xs = np.mgrid[0:GRID, 0:GRID].astype(np.float32)
    cy = cx = (GRID - 1) / 2
    d2 = ((xs - cx) / GRID) ** 2 + ((ys - cy) / GRID) ** 2
    return np.exp(-d2 / (2 * CENTER_SIGMA**2))


def _edge_damp() -> np.ndarray:
    w = np.ones((GRID, GRID), np.float32)
    band = max(1, round(GRID * EDGE_MARGIN))
    w[:band, :] = EDGE_DAMP
    w[-band:, :] = EDGE_DAMP
    w[:, :band] = EDGE_DAMP
    w[:, -band:] = EDGE_DAMP
    return w


_BIAS = _center_bias()
_DAMP = _edge_damp()


def _facecam_mask(fx: float, fy: float, fw: float, fh: float) -> np.ndarray:
    """Grid cells covered by the facecam box, zeroed out."""
    mask = np.ones((GRID, GRID), np.float32)
    x0, x1 = int(fx * GRID), int((fx + fw) * GRID) + 1
    y0, y1 = int(fy * GRID), int((fy + fh) * GRID) + 1
    mask[max(0, y0) : min(GRID, y1), max(0, x0) : min(GRID, x1)] = 0.0
    return mask


def _grid_diff(gray: np.ndarray, prev_gray: np.ndarray, h: int, w: int) -> np.ndarray:
    cell_h, cell_w = h // GRID, w // GRID
    diff = np.abs(gray - prev_gray)
    return diff[: cell_h * GRID, : cell_w * GRID].reshape(GRID, cell_h, GRID, cell_w).mean(axis=(1, 3))


def track_action_frames(
    frames, facecam: tuple[float, float, float, float] | None
) -> tuple[list[dict], float, bool]:
    """Pure over an iterable of `(rgb_frame, src_w, src_h)` SAMPLE_STEP apart —
    the shape `analyze_clip.read_frames` yields. Kept separate from the ffmpeg
    read so self-tests need no subprocess, same split as `build_tracks`."""
    fmask = _facecam_mask(*facecam) if facecam else None
    weight = _BIAS * _DAMP * (fmask if fmask is not None else 1.0)

    region: list[dict] = []
    confs: list[float] = []
    edge_fracs: list[float] = []
    prev_gray = None
    t = 0.0

    for frame, _sw, _sh in frames:
        h, w = frame.shape[:2]
        gray = frame.astype(np.float32).mean(axis=2)
        if prev_gray is not None:
            grid = _grid_diff(gray, prev_gray, h, w)
            total_raw = float(grid.sum())
            band = max(1, round(GRID * EDGE_MARGIN))
            edge_energy = float(grid[:band].sum() + grid[-band:].sum() + grid[:, :band].sum() + grid[:, -band:].sum())
            edge_fracs.append(edge_energy / total_raw if total_raw > MOTION_EPS else 0.0)

            weighted = grid * weight
            total = float(weighted.sum())
            if total <= MOTION_EPS:
                cx, cy, conf = 0.5, 0.5, 0.0
            else:
                ys, xs = np.mgrid[0:GRID, 0:GRID].astype(np.float32)
                cx = float(((xs + 0.5) / GRID * weighted).sum() / total)
                cy = float(((ys + 0.5) / GRID * weighted).sum() / total)
                # Concentration, not amount: a moving object peaks one cell far
                # above uniform; diffuse motion (rain of small changes) spreads
                # evenly and should not pretend to be a confident ROI.
                uniform_share = 1.0 / (GRID * GRID)
                top1_share = float(weighted.max() / total)
                conf = max(0.0, min(1.0, (top1_share - uniform_share) / (1 - uniform_share)))
            region.append({"t": round(t, 3), "cx": round(cx, 4), "cy": round(cy, 4), "confidence": round(conf, 3)})
            confs.append(conf)
        prev_gray = gray
        t += SAMPLE_STEP

    action_confidence = round(sum(confs) / len(confs), 3) if confs else 0.0
    hud_suppressed = bool(edge_fracs) and (sum(edge_fracs) / len(edge_fracs)) > HUD_SUPPRESSED_FRACTION
    return region, action_confidence, hud_suppressed


def track_action(
    video: Path, start: float, end: float, facecam: tuple[float, float, float, float] | None
) -> tuple[list[dict], float, bool]:
    return track_action_frames(read_frames(video, start, end), facecam)


def main(d: Path) -> dict:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--clip-id", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--facecam-x", type=float, default=None)
    ap.add_argument("--facecam-y", type=float, default=None)
    ap.add_argument("--facecam-w", type=float, default=None)
    ap.add_argument("--facecam-h", type=float, default=None)
    args, _ = ap.parse_known_args()

    ingest = read_json(d, "ingest.json")
    if not ingest or not ingest.get("video"):
        raise SystemExit("ingest.json missing or has no video")
    video = d / ingest["video"]

    facecam = None
    if args.facecam_x is not None:
        facecam = (args.facecam_x, args.facecam_y, args.facecam_w, args.facecam_h)

    region, action_confidence, hud_suppressed = track_action(video, args.start, args.end, facecam)
    print(
        f"[action] {args.clip_id}: {len(region)} sample(s), actionConfidence={action_confidence}, "
        f"hudSuppressed={hud_suppressed}",
        flush=True,
    )

    return {
        "schemaVersion": 1,
        "clipId": args.clip_id,
        "sampleStep": SAMPLE_STEP,
        "actionRegion": region,
        "actionConfidence": action_confidence,
        "hudSuppressed": hud_suppressed,
    }


def _self_test() -> None:
    def moving_square_frames(n: int, box_at):
        for i in range(n):
            f = np.full((80, 80, 3), 20, np.uint8)
            bx, by = box_at(i)
            f[by : by + 10, bx : bx + 10] = 230
            yield f, 80, 80

    # A bright square sweeping left-to-right must pull the weighted centroid
    # rightward over the clip — the doc's core claim for this stage.
    region, conf, _ = track_action_frames(moving_square_frames(8, lambda i: (5 + i * 8, 35)), None)
    assert len(region) == 7  # 8 frames -> 7 diffs
    assert region[-1]["cx"] > region[0]["cx"], "weighted centroid did not move right with the moving square"
    # Frame-differencing a moving object lights up its leading AND trailing
    # edge as two separate diff blobs, so "concentration" is well under 1 even
    # for a clean single-object move — the real signal is "clearly above
    # uniform" (1/64 ~= 0.016 pre-adjustment), not "near 1".
    assert conf > 0.15, f"concentrated motion should read as more confident than uniform noise, got {conf}"

    # Motion confined entirely inside the facecam box must not move the
    # centroid there — it must default to frame centre with zero confidence.
    def facecam_only_frames(n: int):
        for i in range(n):
            f = np.full((80, 80, 3), 20, np.uint8)
            f[0:15, 0:15] = 230 if i % 2 == 0 else 20  # flicker, top-left corner only
            yield f, 80, 80

    region2, conf2, _ = track_action_frames(facecam_only_frames(6), (0.0, 0.0, 0.25, 0.25))
    assert all(r["cx"] == 0.5 and r["cy"] == 0.5 for r in region2), "masked motion leaked into the centroid"
    assert conf2 == 0.0, "fully-masked motion must read as zero confidence, not a guess"

    # Static frames -> zero confidence and a fixed centre, never a random region.
    def static_frames(n: int):
        f = np.full((80, 80, 3), 50, np.uint8)
        for _ in range(n):
            yield f.copy(), 80, 80

    region3, conf3, hud3 = track_action_frames(static_frames(5), None)
    assert conf3 == 0.0
    assert all(r["cx"] == 0.5 and r["cy"] == 0.5 and r["confidence"] == 0.0 for r in region3)
    assert hud3 is False

    # A facecam mask covers exactly its box, and nothing else.
    m = _facecam_mask(0.0, 0.0, 0.25, 0.25)
    assert m[0, 0] == 0.0
    assert m[-1, -1] == 1.0

    # Edge-only flicker (a HUD/minimap animation) must trip hud_suppressed.
    def edge_flicker_frames(n: int):
        for i in range(n):
            f = np.full((80, 80, 3), 20, np.uint8)
            f[0:8, 0:80] = 230 if i % 2 == 0 else 20  # top strip only — inside the damped edge band
            yield f, 80, 80

    _, _, hud4 = track_action_frames(edge_flicker_frames(6), None)
    assert hud4 is True, "edge-confined motion should flag hudSuppressed"

    print("[action] self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        d, out = run_stage("action", main)
        write_json(d, f"action/{out['clipId']}.json", out)
