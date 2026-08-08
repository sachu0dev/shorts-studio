"""Composite frames in OpenCV, pipe them to NVENC.

    NVDEC decode -> per-frame crop + fit-and-fill -> raw BGR pipe -> ffmpeg NVENC

Replaces the fixed ffmpeg `-vf` chain, and from phase 7 the crop window moves:
`cameraPath` in `composition/<clipId>.json` says where the window sits at every
moment. `static-center` is the degenerate case — a constant path — so there is
one code path here, not two.

**Canvas vs. window (phase 30).** The published file is always the OUT_W x
OUT_H canvas — that is what a Short is. The framing WINDOW into the source can
be any of `ASPECT_RATIO`, decided per segment in `layoutTimeline`, and does not
have to fill the canvas: `_fit_and_fill` scales it to the canvas width, centres
it vertically, and fills whatever's left with blur (default) or black. A 9:16
window fills the canvas exactly, so this is a no-op for every clip phase 10
already rendered correctly.

The pipe carries the CANVAS, not the crop — it has to, once the window's own
size varies per segment and can no longer feed a fixed-size pipe. Compositing
therefore finishes in this loop rather than in the encoder's filter graph.

Two things deliberately stay in ffmpeg:
  * **Captions.** The burned `.ass` file is correct and fast; reimplementing ASS
    rendering in OpenCV is a lot of code to arrive back where we started.
  * **Meme overlays.** They are extra inputs on an ffmpeg command that already
    exists, and Giphy assets are animated GIF/mp4 that OpenCV cannot composite
    without decoding them itself.
"""

import argparse
import math
import queue
import subprocess
import tempfile
import threading
from pathlib import Path

import cv2
import numpy as np

from _base import read_json, run_stage, write_json

OUT_W, OUT_H = 1080, 1920
FPS = 30
# Everything is decoded to this height; the crop window is a fraction of it.
WORK_H = 1080
FREEZE_SEC = 0.6  # freeze-frame-callout, matching the old tpad stop_duration

# phase 30: the framing WINDOW's aspect, independent of the OUT_W x OUT_H
# CANVAS. Mirrors server/pipeline/retention.ts's ASPECT_RATIO exactly.
ASPECT_RATIO = {"9:16": 9 / 16, "1:1": 1.0, "4:3": 4 / 3, "16:9": 16 / 9}

# (hwaccel, video encoder, encoder options) tried in order. systemCheck proved
# NVENC exists in phase 0, but a driver that refuses at runtime must cost a
# warning, never the render (CLAUDE.md rule 5).
ATTEMPTS = (
    ("cuda", "h264_nvenc", ["-preset", "p4", "-cq", "23", "-b:v", "0"]),
    (None, "libx264", ["-preset", "veryfast", "-crf", "20"]),
)


# ── effects ───────────────────────────────────────────────────────────────────
# Each takes the cropped BGR frame and the clip-relative time, and returns a
# frame of the same shape. `t` is clip-relative because that is what `t` meant
# in the ffmpeg expressions these replace.
#
# Geometry is expressed as a fraction of the frame, never in pixels: the crop is
# 608x1080 here but the old filters were written against the 1080x1920 output,
# and a hardcoded "20 px" would silently mean something different.


_CONTRAST_LUTS: dict[int, np.ndarray] = {}


def _contrast_lut(con: float) -> np.ndarray:
    lut = _CONTRAST_LUTS.get(int(con * 100))
    if lut is None:
        lut = np.clip((np.arange(256, dtype=np.float32) - 128.0) * con + 128.0, 0, 255).astype(np.uint8)
        _CONTRAST_LUTS[int(con * 100)] = lut
    return lut


def _eq(f, sat, con):
    """ffmpeg `eq=saturation=:contrast=`, contrast about mid-grey.

    All uint8 via LUT + addWeighted. The obvious float32 version reads clearer
    and cost 22 s of the 30 s a colour-graded 20 s clip took — every step
    allocated a 25 MB float array per frame.
    """
    out = cv2.LUT(f, _contrast_lut(con)) if con != 1.0 else f
    if sat == 1.0:
        return out
    # cvtColor's BGR2GRAY weights are 0.114/0.587/0.299 — the same luma ffmpeg uses.
    gray = cv2.cvtColor(cv2.cvtColor(out, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    return cv2.addWeighted(out, sat, gray, 1.0 - sat, 0)


_R_IDX: dict[tuple[int, int], np.ndarray] = {}


def _radius_index(h: int, w: int) -> np.ndarray:
    """Distance from centre, 0 at the middle and 255 at the corners.

    The vignette gain depends on nothing but this, so the pulsing mask is a
    256-entry LUT over it rather than 2M transcendental ops per frame — and one
    array per frame size instead of a full-size mask cached per angle.
    """
    m = _R_IDX.get((h, w))
    if m is None:
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        r = np.hypot(xs - w / 2, ys - h / 2) / math.hypot(w / 2, h / 2)
        m = (np.clip(r, 0, 1) * 255).astype(np.uint8)
        _R_IDX[(h, w)] = m
    return m


# political used `curves=preset=cross_process` on top of the eq: cool shadows,
# warm highlights. A per-channel gamma is the cheap version of that curve.
_X = np.arange(256, dtype=np.float32) / 255.0
_CROSS_LUT = (
    np.stack([_X**1.20, _X**1.00, _X**0.85], axis=-1) * 255  # B, G, R
).reshape(1, 256, 3).astype(np.uint8)


def _cross_process(f):
    return cv2.LUT(f, _CROSS_LUT)


def fx_fullscreen(f, t, ctx):
    return f


def fx_meme_corner(f, t, ctx):
    # Reserves space only; the meme overlay step composites into it.
    return f


def fx_blurred_fill(f, t, ctx):
    # ponytail: blur at 1/8 scale, then upscale. A full-resolution sigma-20 blur
    # costs ~30ms/frame and a background blur has no detail left to lose — the
    # two are indistinguishable side by side.
    h, w = f.shape[:2]
    small = cv2.resize(f, (max(1, w // 8), max(1, h // 8)), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), max(1.0, 2.5 * w / OUT_W))
    out = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    out[0 : h // 2] = cv2.resize(f, (w, h // 2))
    return out


def fx_shake_on_beat(f, t, ctx):
    h, w = f.shape[:2]
    mx, my = max(2, round(w * 0.0185)), max(2, round(h * 0.0104))  # old: 20px of 1080x1920
    dx = int(round(mx / 2 + (mx / 4) * math.sin(t * 30)))
    dy = int(round(my / 2 + (my / 4) * math.cos(t * 30)))
    # The ffmpeg version left the frame at 1060x1900 and let the encoder deal
    # with it; the raw pipe has one fixed size, so scale back up.
    return cv2.resize(f[dy : dy + h - my, dx : dx + w - mx], (w, h))


def fx_vignette_pulse(f, t, ctx):
    h, w = f.shape[:2]
    angle = math.pi / 4 + 0.1 * math.sin(t * 3)
    rs = np.arange(256, dtype=np.float32) / 255.0
    lut = (np.cos(np.arctan(rs * math.tan(angle))) ** 4 * 255).astype(np.uint8)  # cos^4, ffmpeg's model
    gain = cv2.cvtColor(cv2.LUT(_radius_index(h, w), lut), cv2.COLOR_GRAY2BGR)
    return cv2.multiply(f, gain, scale=1 / 255.0, dtype=cv2.CV_8U)


def fx_glitch_cut(f, t, ctx):
    h, w = f.shape[:2]
    sx, sy = max(1, round(w * 0.0037)), max(1, round(h * 0.0010))  # old: rh=4 rv=2
    b, g, r = cv2.split(f)
    r = np.roll(np.roll(r, sx, axis=1), sy, axis=0)
    b = np.roll(np.roll(b, -sx, axis=1), -sy, axis=0)
    return cv2.merge([b, g, r])


def fx_color_grade_pop(f, t, ctx):
    mode = ctx.get("contentMode")
    if mode == "gaming":
        return _eq(f, 1.5, 1.15)
    if mode == "political":
        return _eq(_cross_process(f), 0.9, 1.0)
    return _eq(f, 1.3, 1.1)  # funny


def fx_letterbox_cinematic(f, t, ctx):
    h, w = f.shape[:2]
    bar = max(1, round(h * 0.0625))  # old: 120px of 1920
    out = np.zeros((h, w, 3), np.uint8)
    out[bar : h - bar] = cv2.resize(f, (w, h - 2 * bar))
    return out


def fx_freeze_frame_callout(f, t, ctx):
    # Frame-count effect, applied after the loop by holding the last frame.
    return f


EFFECTS = {
    "fullscreen": fx_fullscreen,
    "meme-corner": fx_meme_corner,
    "blurred-fill": fx_blurred_fill,
    "shake-on-beat": fx_shake_on_beat,
    "vignette-pulse": fx_vignette_pulse,
    "glitch-cut": fx_glitch_cut,
    "color-grade-pop": fx_color_grade_pop,
    "letterbox-cinematic": fx_letterbox_cinematic,
    "freeze-frame-callout": fx_freeze_frame_callout,
}


# ── camera ────────────────────────────────────────────────────────────────────


def camera_at(path: list[dict], t: float, key: str = "cx") -> float:
    """Interpolated `key` ("cx" or "cy") at time `t`.

    Keyframes are 0.25 s apart; frames are 1/30 s apart. Stepping the crop only
    at keyframes would quantise the pan into visible 8-frame jerks.
    """
    if not path:
        return 0.5
    if t <= path[0]["t"]:
        return path[0].get(key, 0.5)
    for i in range(1, len(path)):
        if path[i]["t"] < t:
            continue
        a, b = path[i - 1], path[i]
        av, bv = a.get(key, 0.5), b.get(key, 0.5)
        span = b["t"] - a["t"]
        return bv if span <= 0 else av + (t - a["t"]) / span * (bv - av)
    return path[-1].get(key, 0.5)


def camera_cx(path: list[dict], t: float) -> float:
    return camera_at(path, t, "cx")


def _dim(f: np.ndarray, factor: float = 0.82) -> np.ndarray:
    """The "not currently talking" cue for split-screen — subtle on purpose,
    per phase 10: a hard highlight reads as a video-call UI, not an edit."""
    return (f.astype(np.float32) * factor).clip(0, 255).astype(np.uint8)


def composite_split(
    frame: np.ndarray,
    top_path: list[dict],
    bot_path: list[dict],
    t: float,
    dec_w: int,
    crop_w: int,
    active: int | None,
    targets: tuple[int, int],
) -> np.ndarray:
    """One `split-screen` frame: two independently-tracked 9:8 halves, stacked.

    Each half is `crop_w` wide (same window width `camera_cx` uses for a full
    9:16 crop) and half the decoded frame tall — which is exactly a 9:8 window,
    since `crop_w / (work_h/2) == crop_w / work_h * 2 == (9/16) * 2 == 9/8`. So
    the encoder's existing `scale=1080:1920` upscales each half to 1080x960
    with no extra filter-graph work.
    """
    work_h = frame.shape[0]
    half_h = work_h // 2
    max_x = dec_w - crop_w
    max_y = work_h - half_h

    def half(path: list[dict]) -> np.ndarray:
        x0 = min(max_x, max(0, round(camera_at(path, t, "cx") * dec_w - crop_w / 2)))
        y0 = min(max_y, max(0, round(camera_at(path, t, "cy") * work_h - half_h / 2)))
        return frame[y0 : y0 + half_h, x0 : x0 + crop_w]

    top, bot = half(top_path), half(bot_path)
    # Emphasis: dim whichever half is not the one ASD says is talking right now.
    # Without this cue split-screen is unreadable — there is nothing else on
    # screen telling the viewer whose turn it is.
    if active == targets[0]:
        bot = _dim(bot)
    elif active == targets[1]:
        top = _dim(top)
    return np.vstack([top, bot])


def _window_width(src_w: int, src_h: int, dec_w: int, aspect: str) -> int:
    """Crop width in decoded-frame pixels for `aspect` — the same normalized
    fraction `server/pipeline/retention.ts`'s `cropWidthFor` computes, using the
    real source dimensions rather than the decode-derived proxy."""
    ratio = ASPECT_RATIO.get(aspect, ASPECT_RATIO["9:16"])
    frac = min(1.0, ratio / (src_w / src_h))
    return max(2, min(dec_w, round(frac * dec_w / 2) * 2))


def _fit_and_fill(crop: np.ndarray, fill: str) -> np.ndarray:
    """Scale a source-window crop to the OUT_W x OUT_H canvas and centre it
    vertically; fill whatever's left with a blurred, zoomed copy of the same
    crop (default) or solid black.

    A 9:16 window already fills the canvas exactly (`sh == OUT_H`), so this is
    a no-op resize for every clip phase 10 already rendered correctly — the
    canvas and the window only diverge once phase 30 widens the window.
    """
    ch, cw = crop.shape[:2]
    scale = OUT_W / cw
    sh = max(1, round(ch * scale))

    # Close enough to the canvas aspect that any gap is rounding noise, not a
    # real letterbox — stretch straight to the canvas, matching the old
    # encoder-side `scale=1080:1920` exactly rather than inventing a 1-2px fill
    # band nothing asked for. `_window_width`'s even-rounding of crop widths is
    # exactly what produces this noise for a "9:16" window.
    if abs(sh - OUT_H) <= 4:
        return cv2.resize(crop, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)

    scaled = cv2.resize(crop, (OUT_W, sh), interpolation=cv2.INTER_LINEAR)
    if sh > OUT_H:
        y0 = (sh - OUT_H) // 2
        return np.ascontiguousarray(scaled[y0 : y0 + OUT_H])

    if fill == "black":
        canvas = np.zeros((OUT_H, OUT_W, 3), np.uint8)
    else:
        # ponytail: blur at 1/8 scale then upscale — same trick as
        # fx_blurred_fill; a background blur has no detail left to lose.
        small = cv2.resize(crop, (max(1, cw // 8), max(1, ch // 8)), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(small, (0, 0), max(1.0, 2.5 * cw / OUT_W))
        canvas = cv2.resize(small, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)

    y0 = (OUT_H - sh) // 2
    canvas[y0 : y0 + sh] = scaled
    return canvas


# ── render ────────────────────────────────────────────────────────────────────


def _esc(p) -> str:
    """Path into an ffmpeg filter option value."""
    return str(p).replace("\\", "/").replace(":", "\\:")


def _filter_complex(comp: dict, d: Path) -> tuple[str, str]:
    ass = _esc((d / comp["ass"]).resolve())
    fonts = _esc(comp["fontsDir"])
    fc = f"[0:v]scale={OUT_W}:{OUT_H},ass='{ass}':fontsdir='{fonts}'[base]"
    meme_filter = comp.get("memeFilter")
    if meme_filter:
        return f"{fc};{meme_filter}", comp["finalLabel"]
    return fc, "[base]"


def _source_size(video: str) -> tuple[int, int]:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", video],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    w, h = (int(x) for x in out.split("x"))
    return w, h


def _read_exact(stream, view: memoryview) -> bool:
    """Fill `view` completely. A short read at the end of the stream is EOF, not
    a frame — writing a partial frame would shear every frame after it."""
    got = 0
    while got < len(view):
        k = stream.readinto(view[got:])
        if not k:
            return False
        got += k
    return True


def _pump(comp: dict, d: Path, hwaccel, venc, venc_opts) -> int:
    """One decode->crop->composite->fit->encode pass. Returns the frame count."""
    source = str((d / comp["source"]).resolve())
    out = str((d / comp["out"]).resolve())
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    start, end = str(comp["start"]), str(comp["end"])
    fc, final = _filter_complex(comp, d)

    src_w, src_h = _source_size(source)
    dec_w = max(2, round(src_w * WORK_H / src_h / 2) * 2)
    path = comp.get("cameraPath") or []
    timeline = comp.get("layoutTimeline") or []
    split_path = comp.get("splitPath") or {}
    top_path = split_path.get("top") or []
    bot_path = split_path.get("bottom") or []
    active_track = comp.get("activeTrack")
    sample_step = comp.get("sampleStep") or 0.25

    dec_cmd = ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error"]
    if hwaccel:
        dec_cmd += ["-hwaccel", hwaccel]
    dec_cmd += [
        "-accurate_seek", "-ss", start, "-to", end, "-i", source,
        "-vf", f"scale={dec_w}:{WORK_H}",
        "-r", str(FPS), "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]

    enc_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
        # phase 30: the pipe carries the CANVAS, not the crop — a per-segment
        # window width cannot feed a fixed-size pipe, and `_fit_and_fill`
        # already leaves every frame at OUT_W x OUT_H before it is queued.
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OUT_W}x{OUT_H}", "-r", str(FPS), "-i", "-",
        # Audio comes straight from the source; only the video was rebuilt.
        "-accurate_seek", "-ss", start, "-to", end, "-i", source,
    ]
    for m in comp.get("memeInputs", []):
        enc_cmd += ["-i", m]
    enc_cmd += [
        "-filter_complex", fc,
        "-map", final, "-map", "1:a?",
        "-c:v", venc, *venc_opts,
        # Not optional. The pipe feeds bgr24, so ffmpeg negotiates GBR planar
        # end-to-end and encodes H.264 **High 4:4:4 Predictive** — which ffmpeg
        # reads back perfectly and no browser can decode. Chrome renders the
        # planes as if they were YUV: green background, magenta skin. The file
        # measures colour-correct the whole time, which is what makes this so
        # slow to find. Forcing 8-bit 4:2:0 is also what every platform ingests.
        "-pix_fmt", "yuv420p",
        # And tag the colour space rather than letting it be guessed — an
        # untagged render came back as bt470bg (601), a subtler version of the
        # same class of bug.
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        out,
    ]

    effects = comp.get("effects") or []
    freeze = any(e.get("template") == "freeze-frame-callout" for e in effects)
    ctx = {"contentMode": comp.get("contentMode")}

    # Frames go out on a writer thread. Reading and writing from one thread
    # serializes two pipes that should overlap — the decoder idles while we block
    # on the encoder and vice versa. Measured at ~2x the wall time of the slower
    # leg alone.
    with tempfile.TemporaryFile() as dec_err, tempfile.TemporaryFile() as enc_err:
        dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=dec_err)
        enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=enc_err)

        outbox: queue.Queue = queue.Queue(maxsize=4)  # bounded: never buffer the whole clip
        broken = threading.Event()

        def pusher():
            while True:
                buf = outbox.get()
                if buf is None:
                    return
                try:
                    enc.stdin.write(buf)
                except (BrokenPipeError, ValueError):
                    broken.set()  # the encoder died; its stderr below is the real error
                    return

        writer = threading.Thread(target=pusher, daemon=True)
        writer.start()

        # One reusable read buffer: `frombuffer(...).copy()` allocated and
        # memcpy'd a whole frame per iteration for no benefit.
        frame = np.empty((WORK_H, dec_w, 3), np.uint8)
        view = memoryview(frame.reshape(-1))
        n = 0
        last = None
        seg_idx = 0
        try:
            while not broken.is_set() and _read_exact(dec.stdout, view):
                t = n / FPS
                while timeline and seg_idx + 1 < len(timeline) and timeline[seg_idx]["t1"] <= t:
                    seg_idx += 1
                seg = timeline[seg_idx] if timeline else None
                # Absent frameAspect/fill means an old composition or no timeline
                # at all — 9:16 + blur is the phase 10 behaviour, preserved.
                aspect = (seg.get("frameAspect") if seg else None) or "9:16"
                fill = (seg.get("fill") if seg else None) or "blur"
                crop_w = _window_width(src_w, src_h, dec_w, aspect)
                max_x = dec_w - crop_w

                if seg and seg.get("mode") == "split-screen" and seg.get("targets"):
                    active = None
                    if active_track is not None:
                        k = int(t / sample_step)
                        active = active_track[k] if 0 <= k < len(active_track) else None
                    f = composite_split(frame, top_path, bot_path, t, dec_w, crop_w, active, tuple(seg["targets"]))
                else:
                    x0 = min(max_x, max(0, round(camera_cx(path, t) * dec_w - crop_w / 2)))
                    # The slice is a view into the reused buffer, so it has to be
                    # materialised before it is queued either way.
                    f = np.ascontiguousarray(frame[:, x0 : x0 + crop_w])
                for e in effects:
                    if e["t0"] <= t < e["t1"]:
                        f = EFFECTS.get(e["template"], fx_fullscreen)(f, t - e["t0"], ctx)
                f = _fit_and_fill(f, fill)
                outbox.put(f if f.flags["C_CONTIGUOUS"] else np.ascontiguousarray(f))
                if freeze:
                    last = f
                n += 1
            if freeze and last is not None:
                for _ in range(int(FREEZE_SEC * FPS)):
                    outbox.put(last)
                    n += 1
        finally:
            outbox.put(None)
            writer.join(timeout=60)
            dec.stdout.close()
            if enc.stdin:
                try:
                    enc.stdin.close()
                except BrokenPipeError:
                    pass
            dec.wait()
            enc.wait()

        def tail(fh):
            fh.seek(0)
            return fh.read().decode("utf8", "replace").strip()[-800:]

        if n == 0:
            raise RuntimeError(f"decoder produced no frames ({tail(dec_err) or 'no stderr'})")
        if enc.returncode != 0:
            raise RuntimeError(f"encoder {venc} exited {enc.returncode}: {tail(enc_err) or 'no stderr'}")
    return n


def main(d: Path) -> dict:
    p = argparse.ArgumentParser()
    p.add_argument("--clip-id", required=True)
    args, _ = p.parse_known_args()
    clip_id = args.clip_id

    comp = read_json(d, f"composition/{clip_id}.json")
    if not comp:
        raise SystemExit(f"composition/{clip_id}.json missing — Node writes it before invoking this stage")

    last_error = None
    for hwaccel, venc, venc_opts in ATTEMPTS:
        try:
            n = _pump(comp, d, hwaccel, venc, venc_opts)
            aspects = sorted({s.get("frameAspect", "9:16") for s in comp.get("layoutTimeline") or []}) or ["9:16"]
            print(
                f"[render] {clip_id}: {n} frames, mode={comp.get('mode', 'static-center')}, "
                f"canvas={OUT_W}x{OUT_H}, aspects={aspects}, decoder={hwaccel or 'cpu'}, encoder={venc}",
                flush=True,
            )
            return {
                "clipId": clip_id,
                "clip": comp["out"],
                "frames": n,
                "mode": comp.get("mode", "static-center"),
                "decoder": hwaccel or "cpu",
                "encoder": venc,
            }
        except RuntimeError as e:
            last_error = e
            print(f"[render] ⚠️ {venc} path failed ({e}) — falling back", flush=True)

    raise RuntimeError(f"every render path failed; last: {last_error}")


def _self_test() -> None:
    """Each effect moves a synthetic frame in the expected direction, at the real
    crop size. No exact pixels — that would break on any OpenCV version bump."""
    h, w = WORK_H, 608
    mid = np.full((h, w, 3), 128, np.uint8)
    noise = (np.random.default_rng(0).integers(0, 256, (h, w, 3))).astype(np.uint8)
    ctx = {"contentMode": "gaming"}

    for name, fn in EFFECTS.items():
        out = fn(noise.copy(), 0.1, ctx)
        assert out.shape == (h, w, 3), f"{name} changed frame shape to {out.shape}"
        assert out.dtype == np.uint8, f"{name} returned {out.dtype}"

    # blur reduces local variance
    assert fx_blurred_fill(noise, 0, ctx)[h - 10 :].std() < noise[h - 10 :].std()
    # gaming grade raises saturation: a flat grey stays grey, colour spreads
    assert np.array_equal(fx_color_grade_pop(mid, 0, ctx), mid)
    chan = np.zeros((h, w, 3), np.uint8)
    chan[:, :, 2] = 200
    assert fx_color_grade_pop(chan, 0, ctx)[:, :, 2].mean() > chan[:, :, 2].mean()
    # vignette darkens corners more than the centre
    v = fx_vignette_pulse(np.full((h, w, 3), 200, np.uint8), 0, ctx)
    assert v[0, 0].mean() < v[h // 2, w // 2].mean()
    # letterbox writes black bars
    lb = fx_letterbox_cinematic(np.full((h, w, 3), 200, np.uint8), 0, ctx)
    assert lb[0].max() == 0 and lb[h - 1].max() == 0 and lb[h // 2].mean() > 100
    # glitch shifts R and B but leaves G alone
    g = fx_glitch_cut(noise, 0, ctx)
    assert np.array_equal(g[:, :, 1], noise[:, :, 1])
    assert not np.array_equal(g[:, :, 2], noise[:, :, 2])

    # camera path interpolates between keyframes rather than stepping at them
    path = [{"t": 0.0, "cx": 0.30}, {"t": 0.25, "cx": 0.40}]
    assert abs(camera_cx(path, 0.125) - 0.35) < 1e-9
    assert camera_cx(path, -1) == 0.30 and camera_cx(path, 99) == 0.40
    assert camera_cx([], 5) == 0.5

    # phase 9: a camera-switch cut is two keyframes sharing a timestamp. The old
    # position must hold right up to it and the next frame must already be at the
    # new one — anything in between is a pan between two people, which reads as a
    # rendering bug rather than an edit.
    cut = [{"t": 0.0, "cx": 0.30}, {"t": 5.0, "cx": 0.30}, {"t": 5.0, "cx": 0.70}, {"t": 5.25, "cx": 0.70}]
    assert camera_cx(cut, 4.9) == 0.30
    assert abs(camera_cx(cut, 5.0 + 1 / FPS) - 0.70) < 1e-9

    # phase 10: two synthetic tracks composite into the correct halves, with no
    # seam — the frame dimensions must round-trip exactly.
    sh, sw = 200, 100
    split_frame = np.zeros((sh, sw, 3), np.uint8)
    split_frame[: sh // 2] = (10, 20, 30)     # source's upper half
    split_frame[sh // 2 :] = (200, 210, 220)  # source's lower half
    top_path = [{"t": 0.0, "cx": 0.5, "cy": 0.25}]  # centred on the upper half
    bot_path = [{"t": 0.0, "cx": 0.5, "cy": 0.75}]  # centred on the lower half
    out = composite_split(split_frame, top_path, bot_path, 0.0, sw, sw, None, (1, 2))
    assert out.shape == (sh, sw, 3), f"split frame shape {out.shape}, expected {(sh, sw, 3)}"
    assert np.array_equal(out[0, 0], [10, 20, 30]), "top half pulled the wrong source region"
    assert np.array_equal(out[-1, 0], [200, 210, 220]), "bottom half pulled the wrong source region"
    # the boundary sits exactly at half the frame height, not off by a row
    assert np.array_equal(out[sh // 2 - 1, 0], [10, 20, 30])
    assert np.array_equal(out[sh // 2, 0], [200, 210, 220])
    # active-speaker emphasis dims the half that is not talking
    dimmed = composite_split(split_frame, top_path, bot_path, 0.0, sw, sw, 2, (1, 2))
    assert dimmed[0, 0].mean() < out[0, 0].mean(), "inactive (top) half was not dimmed when track 2 is talking"
    assert np.array_equal(dimmed[-1], out[-1]), "active half was dimmed too"

    # phase 30: a 9:16 window on a 16:9 source is byte-identical to the phase 10
    # crop width, and _fit_and_fill on it is a true no-op (fills the canvas
    # exactly, nothing to blend).
    crop_w_916 = _window_width(1920, 1080, 1920, "9:16")
    assert crop_w_916 == min(1920, round(WORK_H * OUT_W / OUT_H / 2) * 2), "9:16 window width regressed"
    narrow = np.random.default_rng(1).integers(0, 256, (WORK_H, crop_w_916, 3)).astype(np.uint8)
    fitted = _fit_and_fill(narrow, "blur")
    assert fitted.shape == (OUT_H, OUT_W, 3)
    resized = cv2.resize(narrow, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
    assert np.array_equal(fitted, resized), "9:16 fit-and-fill was not a plain stretch, like the old encoder-side scale"

    # a 16:9 window is much wider than the canvas is tall once scaled to OUT_W,
    # so it must be centred with fill above and below, not stretched to fill.
    crop_w_169 = _window_width(1920, 1080, 1920, "16:9")
    wide = np.random.default_rng(2).integers(0, 256, (WORK_H, crop_w_169, 3)).astype(np.uint8)
    blurred = _fit_and_fill(wide, "blur")
    assert blurred.shape == (OUT_H, OUT_W, 3)
    sh = round(WORK_H * OUT_W / crop_w_169)
    y0 = (OUT_H - sh) // 2
    assert y0 > 0, "16:9 window should be shorter than the canvas once scaled"
    # blur reduces local variance — same check `fx_blurred_fill` uses above —
    # so the fill band must be smoother than the sharp framed band beneath it.
    assert blurred[:10].std() < blurred[y0 : y0 + 10].std(), "fill band was not blurred"
    black = _fit_and_fill(wide, "black")
    assert black[0].max() == 0, "black fill top band was not true black"
    assert black[-1].max() == 0, "black fill bottom band was not true black"

    print("[render] self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        d, out = run_stage("render", main)
        write_json(d, f"render/{out['clipId']}.json", out)
