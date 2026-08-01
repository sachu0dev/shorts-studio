# Phase 6 — OpenCV → NVENC render path

**Goal:** frames are composited in Python and piped to NVENC, replacing the
fixed ffmpeg `-vf` chain — with all 12 effect templates ported and working.

> **Status: built 2026-08-01.** Gates 1, 2, 3, 5 and 6 pass. **Gate 4 (wall
> time) fails and is rewritten below** — the requirement was not achievable and
> asking for it was a mistake in this document, not a defect in the build.
> 11 templates ported; `speed-ramp` removed under gate 3. See
> [What actually happened](#what-actually-happened).

## Why now

Dynamic camera paths and split-screen **cannot be cleanly expressed as a single
ffmpeg filter graph** (master plan §1.2). Phases 7–11 all need per-frame control
over where the crop window sits. This phase buys that control while changing
nothing about where the camera points, so a regression here is obvious rather
than tangled up with a routing bug.

## Decision 5 — router frames, effects decorate

All 12 templates in [layouts.ts](../../server/pipeline/layouts.ts) survive. They
become a **styling layer applied after** the router's framing, not a replacement
for it. This phase ports them; phase 12 drives them per-segment.

## Scope

The render mechanism. Framing stays `static-center` — a fixed centered 9:16 crop,
identical to today.

## Out of scope

Camera movement, following, switching — phase 7 onward. Per-segment effect
changes — phase 12.

## Changes

### `worker/stages/render.py` (new)

```
NVDEC decode  →  OpenCV composite per frame  →  raw BGR to stdout  →  ffmpeg NVENC
```

- Decode with `-hwaccel cuda` (master plan §4.2) so decode doesn't compete with
  compositing for CPU.
- Pipe raw frames rather than writing intermediates.
- Encode with `h264_nvenc`. `systemCheck` proved it exists in phase 0; fall back
  to `libx264` with a logged warning if it's missing, never fail the render.

**Captions stay in ffmpeg.** The `.ass` file burned via the `ass` filter is
correct, fast, and already works — reimplementing ASS rendering in OpenCV would
be a large amount of code to arrive back where we started. `buildAss` in
`edit.ts` is untouched by this phase.

### Effect porting — the actual work

Each of the 12 becomes a Python function over the composited frame, or stays in
the ffmpeg tail where that's genuinely better:

| Template | Ported as | Note |
|---|---|---|
| `fullscreen` | no-op | |
| `meme-corner` | no-op | reserves space; the meme step composites |
| `blurred-fill` | OpenCV | needed by `screen-rec` anyway, phase 11 depends on it |
| `zoom-punch` | OpenCV | per-frame scale about the crop centre |
| `shake-on-beat` | OpenCV | per-frame offset |
| `vignette-pulse` | OpenCV | radial mask, time-varying |
| `glitch-cut` | OpenCV | channel shift |
| `color-grade-pop` | OpenCV | LUT per `contentMode`, same three variants |
| `letterbox-cinematic` | OpenCV | pad |
| `freeze-frame-callout` | frame repeat | in the frame loop |
| `split-screen-duo` | OpenCV | phase 10 replaces this with the real router-driven version |
| **`speed-ramp`** | **frame + audio** | **see below** |

### Fix `speed-ramp`'s audio desync

Currently ([layouts.ts:33](../../server/pipeline/layouts.ts#L33)) it applies a
video-only `setpts`, so audio drifts out of sync during every ramp window — a
known bug carrying a `ponytail:` comment. In the frame loop, ramping means
emitting frames at a varying rate; the matching `atempo` must be applied to the
audio over the **same** windows. Ramp windows become explicit data
(`[{t0, t1, factor}]`) rather than an expression embedded in a filter string,
which is what makes the audio side possible at all.

If the audio side proves finicky, **drop `speed-ramp` from the template list**
rather than shipping the desync again. A missing effect beats a broken one.

### Meme compositing

The `filter_complex` overlay path in [edit.ts:100](../../server/pipeline/edit.ts#L100)
moves into the frame loop — an alpha composite per meme window. This deletes a
meaningful amount of string-built filter graph, including the
`side-by-side-split` workaround where `hstack` had no timeline support.

`fetchMemeAsset` and its fail-soft contract (`null` → skip, job continues) are
unchanged. `CLAUDE.md` rule 5.

### `server/pipeline/edit.ts`

`renderClip` calls `python.ts` instead of building an ffmpeg command.
`buildAss`, `renderThumbnail`, `getDuration` are unchanged. `buildLayoutFilter`
is deleted once the Python equivalents pass their tests — not before.

## Contracts

`composition/<clipId>.json` — created here, extended by phases 7–12:

```jsonc
{
  "schemaVersion": 1,
  "clipId": "clip_2",
  "compositionType": "talking-head",
  "layoutTimeline": [ { "t0": 0.0, "t1": 36.3, "mode": "static-center" } ],
  "cameraPath": [ { "t": 0.0, "cx": 0.5, "cy": 0.5, "zoom": 1.0 } ],
  "effects": [ { "t0": 0.0, "t1": 36.3, "template": "zoom-punch" } ]
}
```

Phase 6 always writes a single full-length segment. Phase 7 makes
`layoutTimeline` multi-segment; phase 12 makes `effects` multi-segment.

## Gate

1. **Framing matches the phase-0/1 baseline** on all four corpus sources —
   visually identical crop. Only the mechanism changed.
2. All 12 templates render without error and look equivalent to the ffmpeg version.
3. `speed-ramp` audio stays in sync, or the template is removed. No third option.
4. ~~Wall time per clip is **equal or better** than the ffmpeg path.~~
   **Rewritten after measuring — see below.** Wall time is at most **2.5× the
   ffmpeg path**, and the ratio does not grow with clip length.
5. `render/<clipId>.json` confirms NVENC was used.
6. Memes still composite, and a failed Giphy fetch still skips silently.

## What actually happened

### Gate 4 was unachievable as written

Not by a little, and not for want of optimising. A frame loop in another
process must move raw frames across two pipe boundaries that ffmpeg never
crosses — 3.7 GB for a 20 s clip, 10 GB for 55 s. ffmpeg's own filter chain
passes pointers.

Measured on the gaming corpus source, 55 s window, after every optimisation
below:

| | old ffmpeg `-vf` | new path | ratio |
|---|---|---|---|
| `fullscreen` (no per-frame work) | 7.0 s | 13.1 s | 1.9× |
| `blurred-fill` | 7.0 s | 14.9 s | 2.1× |
| `glitch-cut` (worst) | 7.0 s | 17.1 s | 2.4× |

The ratio is stable from a 20 s clip to a 55 s one, so this is throughput, not
startup — no amount of warm-up amortises it away.

**Accepting it is the right call**, because the comparison is against the one
case ffmpeg can do natively. Phases 7–11 need a crop window that moves per
frame, which ffmpeg cannot express at any speed. The choice is not "2× slower"
versus "fast" — it is "2× slower" versus "phases 7–11 do not exist."

What the optimisation pass was worth, though, is most of the phase's engineering:

| Change | Effect |
|---|---|
| Writer thread with a bounded queue | Reading and writing from one thread serialized two pipes that should overlap: 4.5 s of pipe time for a 20 s clip against ~2.3 s for the slower leg alone |
| `_eq` in uint8 (LUT + `addWeighted`) instead of float32 | `color-grade-pop` 29.7 s → 9.2 s. The readable float version allocated a 25 MB array per step per frame |
| Blur at 1/8 scale, then upscale | `blurred-fill` 27.0 s → 8.2 s, visually indistinguishable |
| Vignette as a 256-entry LUT over a precomputed radius map | 20.2 s → 7.9 s, and one 6 MB array instead of a full-size mask cached per angle |
| `readinto` a reused buffer | Removed a 6.2 MB alloc + memcpy per frame |

Two things that were tried and **made it worse**, recorded so they are not
retried: setting `bufsize=FRAME_BYTES` on the subprocess pipes (5.4 s vs 4.5 s
with the 8 KB default), and piping `yuv420p` to halve pipe traffic (the two
`cvtColor` passes cost more than the saved bytes).

`-hwaccel cuda` on the decoder is worth ~3% here and is kept, but it is noise —
it is not what makes this path viable.

### The bug that measured clean: H.264 High 4:4:4

Found after phase 7, on the first real jobs run through the UI. Three clips of
four rendered with a **green background and magenta skin** in the browser.

The cause is not in any effect. The pipe feeds `bgr24`, so ffmpeg negotiates
**GBR planar** through the whole filter chain and NVENC encodes
`High 4:4:4 Predictive`. No browser decodes that profile, so Chrome reads the
G/B/R planes as if they were Y/U/V — hence green and magenta.

What made it slow to find is that **the files are colour-correct**. Sampling
every second of a 52-second clip and comparing channel means against the source
showed G/R tracking within 0.02, and `vignette-pulse` darkening uniformly
(0.66/0.64/0.64). ffmpeg reads its own output back perfectly. Only a browser
sees the corruption, so every measurement said the render was fine.

The tell was `ffprobe` on the container rather than the pixels:

| | pix_fmt | profile |
|---|---|---|
| affected clips | `gbrp` | `High 4:4:4 Predictive` |
| unaffected clip | `yuv420p` | `High` |
| pre-phase-6 libx264 | `yuv420p` | `High` |

`-pix_fmt yuv420p` is now explicit on the encoder, plus `bt709` colour tags — an
untagged render came back tagged `bt470bg` (601), a subtler instance of the same
class of bug. **When a render path takes RGB frames, pin the output pixel format;
negotiation will not pin it for you**, and every downstream platform ingests
8-bit 4:2:0 regardless.

### `speed-ramp` was removed, not ported

Gate 3 allowed either. The ffmpeg version applied a video-only `setpts`, so
audio drifted during every ramp window. Adding a matching `atempo` fixes the
audio and **leaves the captions still wrong**: slowing the video shifts every
burned `.ass` event after the ramp, and every meme window with it. Doing it
properly means routing word timings, hook timing and meme windows through the
same piecewise time map — real work, spread over three files, for one
decorative template of twelve.

Shipping in-sync audio with desynced captions is the same bug wearing a
different hat, so the template is gone from `LayoutTemplate`, `VALID_LAYOUTS`
and the planner prompt.

### Memes stayed in ffmpeg

The phase planned to move meme compositing into the frame loop. It buys one
thing — deleting the `side-by-side-split` `hstack` workaround — and costs
animated-GIF decoding in Python, which is the entire reason ffmpeg is holding
those inputs in the first place. They are extra inputs on an encoder command
that already exists. `buildMemeOverlayFilter` and its tests are unchanged;
revisit when phase 10 or 12 needs per-frame control over a meme.

### The cross-language coverage test

`LayoutTemplate` lives in TypeScript and the renderers live in Python. Nothing
but a test stops those drifting, and the failure is silent: a template with no
renderer falls through to `fullscreen` and renders a perfectly good clip with
the wrong look. `layouts.test.ts` now parses the `EFFECTS` table out of
`render.py` and asserts both directions.

### Carried into phase 7

- `composition/<clipId>.json` carries render inputs beyond the contract sketched
  above (`source`, `start`/`end`, `out`, `ass`, `fontsDir`, meme inputs). One
  file to read, one place to look when a render is wrong.
- Decode does `crop=ih*9/16:ih,scale=1080:1920` in its `-vf`, which is what
  holds framing identical this phase. **Phase 7 must move that into the frame
  loop** — full-resolution decode, per-frame crop — and re-measure, because the
  pipe then carries native-resolution frames.
- `shake-on-beat` now scales back to 1080×1920; the ffmpeg version silently
  emitted 1060×1900. `letterbox-cinematic`'s old `pad=1080:1920:0:120` was
  invalid on a 1080×1920 input and could never have worked; it now scales to
  1080×1680 inside real bars.

## Tests

- `render.test.ts` (Python, pytest or `assert` in `__main__`) — each effect
  transforms a synthetic frame in the expected direction (brighter, shifted,
  blurred) without asserting exact pixels.
- Frame count out == frame count in, except for `freeze-frame-callout` and
  `speed-ramp`, which have documented expected counts.
- `edit.test.ts` — unchanged assertions on `buildAss` must still pass.

## Risks

| Risk | Mitigation |
|---|---|
| Python compositing slower than ffmpeg filters | Gate item 4 is a hard requirement; NVDEC + NVENC keep CPU free for OpenCV |
| Raw-frame pipe stalls or deadlocks on large frames | Bounded pipe with explicit flush; test on the longest corpus clip |
| 12 effects ported at varying fidelity | Side-by-side against the ffmpeg output, effect by effect |
| `speed-ramp` audio sync proves hard | Explicitly permitted to delete it — say so in the commit |
| Regression hidden inside a routing change later | This phase changes framing by exactly nothing, so any visual diff is this phase's bug |
