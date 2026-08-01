# Phase 7 — Composition router + fullscreen-follow

**Goal:** the deterministic router decides which layouts are *allowed*, and the
camera can follow a subject smoothly.

> **Status: built 2026-08-01. All six gates pass.** Two constants from the
> master plan had to be recalibrated against measured footage before the phase
> could work at all — see [What actually happened](#what-actually-happened).

## Why now

This is the core differentiator (master plan Part 3), and it's the first phase
where the system makes an editorial decision. It comes after phase 6 because
following a subject requires per-frame crop control that the ffmpeg path
couldn't give.

Two modes go live: `static-center` and `fullscreen-follow`. That covers most
single-speaker content correctly — **including the case where plain centre is
the right edit**, which the system must be able to decide rather than default to.

## Scope

`route()`, camera path generation, smoothing, and the two modes.

## Out of scope

Anything needing to know *which face is speaking* — phase 8. `camera-switch`,
`group-crop`, `split-screen` return from `route()` as allowed but are not yet
implemented; the renderer falls back to `fullscreen-follow` and logs it.

## Changes

### `server/pipeline/router.ts` (new)

```ts
export function route(sig: Signals, type: CompositionType, confidence: number): LayoutMode[]
```

Returns **allowed** modes, best first. Ported from master plan §3.2 with the
phase 5 classification as the outer branch:

```
type === "b-roll"        → ["static-center", "blurred-fill"]
type === "screen-rec"    → ["blurred-fill", "static-center"]      // phase 11 extends
type === "talking-head"  → subjectMotion < MOTION_T
                             ? ["static-center"]
                             : ["fullscreen-follow", "static-center"]
type === "multi-speaker" → facesFitOneCrop   → ["group-crop", "fullscreen-follow"]
                           overlapRatio>0.25 → ["split-screen", "camera-switch"]
                           otherwise         → ["camera-switch", "split-screen"]
```

**Low classifier confidence forces the conservative option.** When phase 5
returns `confidence < 0.6`, drop to `["static-center", "blurred-fill"]`
regardless of type. A generic edit on an ambiguous clip beats a confident wrong one.

`route` is pure: signals in, string array out. No I/O, no LLM, fully testable.

### `server/pipeline/camera.ts` (new)

```ts
export function buildCameraPath(
  track: FaceTrack, cuts: number[], opts: SmoothingPreset
): CameraKeyframe[]
```

The tunable set from master plan §3.3 — these constants encode real trial and
error and are worth starting from rather than re-deriving:

| Param | Start | Effect |
|---|---|---|
| `track_step` | 0.25 s | sampling interval; interpolate between |
| `track_deadzone` | 0.15 | ignore movement within this fraction of frame — kills micro-jitter |
| `track_smooth` | 0.30 | EMA factor toward target |
| `track_jitter` | 5 px | below this, don't move at all |
| `track_snap` | 0.25 | above this delta, hard-snap instead of easing |
| `switch_hold` | 2.0 s | minimum dwell (phase 9 uses it) |

Exposed as **presets, not constants** — `"calm"` (larger deadzone, slower
smoothing, longer hold) and `"dynamic"` (tighter, faster, shorter). Creators feel
this difference immediately and it's a cheap differentiator.

**Snap on scene cut** is non-negotiable: at a `cuts[]` boundary, reset camera
position instantly instead of easing. Smooth-panning *through* a hard cut reads
as a rendering bug, not a style.

### `worker/stages/render.py`

Reads `cameraPath` and moves the crop window per frame, interpolating between
keyframes. `static-center` is the degenerate case — a constant path — so there is
one code path, not two.

### `server/index.ts`

New stage between analysis and render: read `analysis/<clipId>.json`, run
`route()` and `buildCameraPath()`, write `composition/<clipId>.json`.

## Contracts

`composition/<clipId>.json` extended:

```jsonc
{
  "allowedModes": ["fullscreen-follow", "static-center"],
  "routedReason": "talking-head, subjectMotion 0.31 > 0.15",
  "preset": "calm",
  "layoutTimeline": [
    { "t0": 0.0, "t1": 12.4, "mode": "fullscreen-follow", "target": 1 },
    { "t0": 12.4, "t1": 36.3, "mode": "fullscreen-follow", "target": 1, "snapped": true }
  ],
  "cameraPath": [ { "t": 0.0, "cx": 0.52, "cy": 0.40, "zoom": 1.0 } ]
}
```

`target` is a **face track id** from phase 4, not a speaker label. Phase 8 is
what makes the binding between them authoritative.

This artifact is a complete, inspectable edit decision record — reviewable before
render, debuggable when wrong, re-renderable in a different style without
re-running inference, and user-editable in phase 23's review UI.

## Gate

1. **Low-motion single-speaker footage stays static.** Not "follows gently" —
   static. If the router can't reach "plain centre is right", the phase failed.
2. High-motion talking-head follows smoothly with no visible jitter.
3. Camera **snaps** at every scene cut in the corpus podcast source — no pan
   across a cut, verified frame by frame at each boundary.
4. `calm` vs `dynamic` produce visibly different output on the same clip.
5. Unimplemented modes fall back to `fullscreen-follow` and log it, never crash.
6. Phase 6's timing is not regressed.

## Tests

`router.test.ts` — pure, table-driven:
- each branch of the rule table returns the documented modes
- `confidence < 0.6` forces the conservative list from every type
- `split-screen` is **never** returned when `distinctFaceTracks < 2` — the
  factual-impossibility guarantee, asserted directly

`camera.test.ts` — pure:
- movement inside the deadzone produces no keyframe change
- a delta above `track_snap` produces a hard snap, not an eased transition
- a scene cut always produces a discontinuity
- `calm` produces strictly fewer keyframe changes than `dynamic` on the same track
- an empty face track returns a valid centered path rather than throwing

## Risks

| Risk | Mitigation |
|---|---|
| Smoothing tuned on one source, jittery on another | Presets, not constants; tune against all four corpus sources |
| Deadzone too large → camera feels dead | `calm`/`dynamic` gives an escape hatch without a code change |
| Face track drops mid-clip → camera jumps to centre | Hold last position for `switch_hold`, then ease to centre |
| Router and classifier disagree in a confusing way | `routedReason` is written to the artifact and read first when debugging |

## What actually happened

### Two of the plan's constants would have made the phase a no-op

Both were off by roughly 4×, in the same direction, and neither failure would
have thrown anything — the system would have rendered plausible clips forever
while one of its two headline modes was unreachable.

**`MOTION_T` 0.15 → 0.04.** `subjectMotion` is the primary face track's
positional standard deviation. Measured over 8 real corpus windows it runs
**0.0006 – 0.072**. At 0.15 every clip routes to `static-center` and
`fullscreen-follow` never renders once. The static windows top out at 0.029 and
the two genuinely mobile ones sit at 0.053 and 0.072, so the threshold goes in
that gap.

**Deadzone 0.15 → 0.06 / 0.03.** A face's total horizontal excursion measures
0.001 – 0.173, and its 90th-percentile drift from the opening position is
0.001 – 0.025 when static against 0.073 – 0.081 when moving. A 0.15 deadzone
never opens, so `fullscreen-follow` would have produced a byte-identical render
to `static-center` — the worst kind of bug, because the artifact says
`fullscreen-follow` and the video disagrees. `track_snap` 0.25 has the same
problem: no measured face ever jumps that far.

**`track_jitter` (5 px) is gone.** With a 0.03 – 0.06 deadzone it is 6–12×
smaller than the knob beside it and can never be the binding constraint. Two
parameters that both mean "don't move" is one parameter and a bug.

This is the phase-5 pattern for the third time: a documented constant that was
never checked against this signal's actual units. Every threshold in
`ROUTE_THRESHOLDS` and `PRESETS` now carries its measurement in a comment.

### Gate 4 needs the right window, and picking the wrong one looks like a failure

Measured first on the mobile solo window, `calm` and `dynamic` differ by 13 px
against 9 px of mean camera-to-face lag on a 1912-wide source — real in the
numbers, invisible on screen. It is tempting to record that as "the presets
don't work".

They work; the window was wrong. That subject's total horizontal excursion is
0.116 while the crop window is 0.316 of the frame width, so the face never
approaches the window edge and every sane preset frames it identically. **The
presets can only differ where the camera has somewhere to go.**

The solo source's opening has exactly that — the speaker walks the stage,
excursion **0.432**:

| Window | Excursion | `calm` lag | `dynamic` lag | Camera travel |
|---|---|---|---|---|
| solo 146.8–171.8 (seated) | 0.116 | 13 px | 9 px | 0.104 |
| **solo 10–35 (walking)** | **0.432** | **88 px** | **58 px** | **0.364** |

Rendered both ways, the walking window gives **PSNR 14.9 dB** between the two
presets — against 8.1 dB for a completely different framing and 42.9 dB for an
identical one. Visibly different, and the gate passes.

The lesson is about gates, not cameras: **a gate measured on footage that cannot
exercise it reports a false negative**, and a false negative here would have led
straight to widening the presets until the number moved — tuning to a gate
rather than to output. [test-corpus.md](test-corpus.md) now names the walking
window so the next phase that touches camera movement does not rediscover this.

### The multi-cam guard the rule table needed

The plan's `multi-speaker` branch reaches `split-screen` and `camera-switch`
through `facesFitOneCrop` and `overlapRatio` alone. Phase 4 measured the
2-person podcast at **3 distinct face tracks but 1 face on screen at a time** —
every cut mints a new track id. Splitting a screen that only ever shows one
face is nonsense, so the branch now requires `medianConcurrentFaces >= 2`
(the tracking-free count) before any two-subject layout is reachable.

### Recentring is exempt from the snap rule

A dropped face and a subject change are not the same event. With `snap` at 0.1
and a lost face 0.2 from centre, the plain rule would have the camera *jump* to
the middle the instant the hold expires. It eases instead; scene cuts still snap.

### What corpus footage cannot reach yet

`group-crop`, `camera-switch` and `split-screen` all sit behind a confident
`multi-speaker` classification, which needs diarization. With
`speaker-diarization-community-1` still gated, the podcast classifies at 0.55
confidence and routes conservatively to `static-center`. The fallback path is
covered by unit test, not by the corpus — that changes the day HF access lands.

### Measured

| Window | Classified | Routed | Render |
|---|---|---|---|
| solo 175–200, motion 0.036 | talking-head @ 0.9 | `static-center`, 0 camera moves | 1.81× ffmpeg |
| solo 146.8–171.8, motion 0.072 | talking-head @ 0.9 | `fullscreen-follow`, 101 keyframes, 6/6 cuts snapped | 1.95× ffmpeg |
| solo 10–35, motion 0.122 (walking) | talking-head @ 0.7 | `fullscreen-follow`, 0.364 travel, 4 cuts snapped | — |
| hinglish 398.6–423.6 | multi-speaker @ 0.55 | conservative → `static-center` | 2.08× ffmpeg |

Rendering the mobile clip forced to `static-center` and comparing against its
`fullscreen-follow` render gives **PSNR 8.1 dB** — the camera path reaches the
pixels rather than merely appearing in the artifact.

**Gate 6 holds.** Following costs the same as static (6132 ms against 6138 ms),
and the ratio to plain ffmpeg improved slightly against phase 6 (1.8–2.1×
against 1.9–2.4×) because the pipe now carries the 608×1080 crop rather than the
composited 1080×1920 output — about a third fewer bytes, and the upscale happens
in the encoder beside the caption burn.

### Carried into phase 8

- `layoutTimeline[].target` is a **face track id**, and nothing yet checks it is
  the person speaking. That binding is phase 8's entire job.
- The compose stage is its own pass over all clips before any render, so
  re-rendering in a different style re-runs routing and nothing upstream.
- `COMPOSITION_PRESET=dynamic` switches the feel. Phase 21 moves it onto the
  creator profile; until there is a profile, one env var beats a settings screen.
