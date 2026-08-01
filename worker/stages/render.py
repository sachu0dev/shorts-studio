"""Composite frames in OpenCV, pipe them to NVENC.

    NVDEC decode -> per-frame crop + composite -> raw BGR pipe -> ffmpeg NVENC

Replaces the fixed ffmpeg `-vf` chain, and from phase 7 the crop window moves:
`cameraPath` in `composition/<clipId>.json` says where the 9:16 window sits at
every moment. `static-center` is the degenerate case — a constant path — so
there is one code path here, not two.

The pipe carries the CROP, not the full frame. It is ~1/3 the bytes of the
composited output, and it means the upscale to 1080x1920 happens in the encoder
alongside the caption burn rather than in this loop.

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
# Everything is decoded to this height; the crop window is 9:16 of it.
WORK_H = 1080
FREEZE_SEC = 0.6  # freeze-frame-callout, matching the old tpad stop_duration

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


def _zoom(f, z):
    h, w = f.shape[:2]
    cw, ch = int(w / z), int(h / z)
    x, y = (w - cw) // 2, (h - ch) // 2
    return cv2.resize(f[y : y + ch, x : x + cw], (w, h), interpolation=cv2.INTER_LINEAR)


def fx_zoom_punch(f, t, ctx):
    return _zoom(f, 1.08) if (t % 2.0) <= 0.3 else f


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


def fx_split_screen_duo(f, t, ctx):
    h, w = f.shape[:2]
    top = cv2.resize(f[0 : h // 2], (w, h // 2))
    bot = cv2.resize(f[h // 2 : h], (w, h - h // 2))
    return np.vstack([top, bot])


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
    "zoom-punch": fx_zoom_punch,
    "shake-on-beat": fx_shake_on_beat,
    "vignette-pulse": fx_vignette_pulse,
    "glitch-cut": fx_glitch_cut,
    "color-grade-pop": fx_color_grade_pop,
    "split-screen-duo": fx_split_screen_duo,
    "letterbox-cinematic": fx_letterbox_cinematic,
    "freeze-frame-callout": fx_freeze_frame_callout,
}


# ── camera ────────────────────────────────────────────────────────────────────


def camera_cx(path: list[dict], t: float) -> float:
    """Interpolated horizontal centre at time `t`.

    Keyframes are 0.25 s apart; frames are 1/30 s apart. Stepping the crop only
    at keyframes would quantise the pan into visible 8-frame jerks.
    """
    if not path:
        return 0.5
    if t <= path[0]["t"]:
        return path[0]["cx"]
    for i in range(1, len(path)):
        if path[i]["t"] < t:
            continue
        a, b = path[i - 1], path[i]
        span = b["t"] - a["t"]
        return b["cx"] if span <= 0 else a["cx"] + (t - a["t"]) / span * (b["cx"] - a["cx"])
    return path[-1]["cx"]


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


def _pump(comp: dict, d: Path, hwaccel, venc, venc_opts) -> tuple[int, int]:
    """One decode->crop->composite->encode pass. Returns (frames, crop width)."""
    source = str((d / comp["source"]).resolve())
    out = str((d / comp["out"]).resolve())
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    start, end = str(comp["start"]), str(comp["end"])
    fc, final = _filter_complex(comp, d)

    src_w, src_h = _source_size(source)
    dec_w = max(2, round(src_w * WORK_H / src_h / 2) * 2)
    crop_w = min(dec_w, round(WORK_H * OUT_W / OUT_H / 2) * 2)
    frame_bytes = dec_w * WORK_H * 3
    path = comp.get("cameraPath") or []

    dec_cmd = ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", "error"]
    if hwaccel:
        dec_cmd += ["-hwaccel", hwaccel]
    dec_cmd += [
        "-ss", start, "-to", end, "-i", source,
        "-vf", f"scale={dec_w}:{WORK_H}",
        "-r", str(FPS), "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]

    enc_cmd = [
        "ffmpeg", "-y", "-hide_banner", "-nostats", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{crop_w}x{WORK_H}", "-r", str(FPS), "-i", "-",
        # Audio comes straight from the source; only the video was rebuilt.
        "-ss", start, "-to", end, "-i", source,
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
    max_x = dec_w - crop_w

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
        try:
            while not broken.is_set() and _read_exact(dec.stdout, view):
                t = n / FPS
                x0 = min(max_x, max(0, round(camera_cx(path, t) * dec_w - crop_w / 2)))
                # The slice is a view into the reused buffer, so it has to be
                # materialised before it is queued either way.
                f = np.ascontiguousarray(frame[:, x0 : x0 + crop_w])
                for e in effects:
                    if e["t0"] <= t < e["t1"]:
                        f = EFFECTS.get(e["template"], fx_fullscreen)(f, t - e["t0"], ctx)
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
    return n, crop_w


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
            n, crop_w = _pump(comp, d, hwaccel, venc, venc_opts)
            print(
                f"[render] {clip_id}: {n} frames, mode={comp.get('mode', 'static-center')}, "
                f"crop={crop_w}x{WORK_H}, decoder={hwaccel or 'cpu'}, encoder={venc}",
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
    # zoom-punch is a no-op outside its 0.3s window and a change inside it
    assert np.array_equal(fx_zoom_punch(noise, 1.0, ctx), noise)
    assert not np.array_equal(fx_zoom_punch(noise, 0.1, ctx), noise)
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

    print("[render] self-test ok")


if __name__ == "__main__":
    import sys

    if "--self-test" in sys.argv:
        _self_test()
    else:
        d, out = run_stage("render", main)
        write_json(d, f"render/{out['clipId']}.json", out)
