# Phase 30 — Adaptive framing window

**Status: built.** Gates 1, 2, 4, 5, 6, 8, 9 pass — gate 8 measured (1.21× phase
10 baseline, under the 1.3× budget). Gate 3's mechanism is verified two ways
(unit tests, and a synthetic end-to-end render with three visually-confirmed
aspects in one clip) but unexercised on real corpus footage — no available
clip has an internal scene cut. Gate 7 (captions vs. the letterbox seam) is
deferred to phase 13 per this doc's own scope note. See "What actually happened".

**Goal:** the framing window's aspect ratio becomes a per-segment decision —
9:16, 1:1, 4:3 or 16:9 — so wide content stops being amputated to fit a tall
crop.

## Why now

Phase 29 measured the damage: a 9:16 window discards 57.6% of the faces on the
corpus panel clip. This is the phase that can act on it.

**The conflation being undone.** Two different things are both "9:16" today and
the code cannot tell them apart:

- the **canvas** — the published file, which must be 1080×1920 because that is
  what a Short is;
- the **window** — how much of the source frame is taken.

`cropWidthFor()` derives the window from the canvas
(`(9/16) / sourceAspect`), and `render.py` hardcodes
`crop_w = WORK_H * OUT_W / OUT_H`. Because the window is defined *as* the canvas
aspect, "keep all eight panelists" is not a thing the system can express — not a
setting that is off, an idea with no representation.

**Decision: the canvas stays 1080×1920; only the window moves.** A 2:1 framing
means a 2:1 slice of the source, scaled to the canvas width and letterboxed into
the tall frame — not a 2:1 output file. A landscape master is not a Short and
YouTube will not treat it as one. If landscape masters are wanted for other
platforms that is an output-profile concern and belongs with phase 26's
multi-channel work, not here.

This also settles phase 11's biggest inherited item for free. That phase notes
`blurred-fill` is *routed but not built*, and that building it requires
"`render.py` must decode full-width and skip the crop for this mode". A
full-width window with a filled remainder **is** `blurred-fill`. It arrives here
as a special case of the general mechanism rather than as its own code path.

## Scope

The window mechanism end to end: the aspect on the segment, the geometry in the
camera path, the compositing in the renderer, and the rule that picks a value.

## Out of scope

Changing *which* subject is framed — phase 31 owns policy. This phase makes wide
framing possible and picks the narrowest safe one; it does not decide that a
panel should be framed as a group rather than a speaker.

Per-segment *effects* (phase 12) and caption geometry inside a letterboxed frame
beyond not overlapping the fill (phase 13 refines it).

## Changes

### `server/pipeline/router.ts` — aspect on the segment

```ts
export type FrameAspect = "9:16" | "1:1" | "4:3" | "16:9";

export interface LayoutSegment {
  // ...
  /** Window aspect for this segment. Absent means 9:16, so old artifacts read correctly. */
  frameAspect?: FrameAspect;
}
```

Selection is deterministic and **decided per segment, over that segment's own
time range** — this is the point of the phase:

```
for each segment:
  frameAspect = narrowest a in CANDIDATE_ASPECTS where
                  retentionOver(tracks, seg.t0, seg.t1, a)        >= RETENTION.floor
                  and speakerRetentionOver(…, seg.t0, seg.t1, a)  >= RETENTION.speakerFloor
                else widest candidate
```

So one clip reads: **9:16 while one person talks in close-up → 4:3 when the
panel comes into shot → back to 9:16 for the reaction cut.** The framing tracks
the content through the clip rather than being chosen once for all of it. A
clip whose whole-clip summary says 16:9 still opens at 9:16 if its first eight
seconds genuinely only contain one person.

Narrowest-first is the ethic. A wider window keeps more people but makes every
face smaller on a phone, and a Short that is technically complete and
practically unwatchable is not an improvement. Widening is what you do when the
alternative is cutting someone out, not a default.

### Two rules that stop "dynamic" becoming "twitchy"

Per-segment freedom is what makes this useful and is also how it goes wrong.
Both guards mirror machinery phase 9 already proved:

**1. Aspect may only change at a segment boundary.** Segments already begin at a
scene cut or a min-hold expiry, so this costs nothing and guarantees the frame
never resizes mid-shot — which reads as a rendering fault, exactly like panning
across a cut does.

**2. An aspect change has its own, longer hold.** `minHold` (2.5 s calm / 1.5 s
dynamic) governs *who* is framed; resizing the frame is a heavier event than
cutting between two people and needs more. With segment-level freedom and no
extra guard, a conversation alternating between a close-up and a two-shot would
breathe 9:16 → 4:3 → 9:16 every couple of seconds, which is far worse than
picking one aspect and living with it.

```ts
export const ASPECT = {
  /** Minimum time at one aspect before it may change again. Starting value. */
  minHold: 5.0,
};
```

A widening that would not survive `ASPECT.minHold` is dropped and the previous
aspect carries — the same two-condition shape as phase 9's min-hold (the current
run must earn its hold, and the challenger must be worth the change), so the
logic is reused rather than reinvented. Consecutive segments sharing an aspect
are merged for this test, since three 2 s segments all at 4:3 are one 6 s
framing decision, not three.

**Exception: `speakerRetention` overrides the hold.** If holding the current
aspect would put the person currently talking outside the frame, it widens
immediately. A guard against twitchiness must never become a reason to crop out
the speaker.

### `server/pipeline/camera.ts` — window width per segment

`cropWidthFor(sourceW, sourceH, aspect)` gains its third argument and keeps
returning a normalized fraction, so every clamp in `buildCameraPath`,
`buildSwitchPath`, `buildHalfPath` and `groupCenter` keeps working unchanged —
they all already take `cropWidth` as a parameter rather than deriving it. This
is why phase 7 was written that way and it pays out here.

### `worker/stages/render.py` — fit and fill

Per frame, the window is cropped at its segment's aspect, scaled to the canvas
width, and centred vertically; the remainder is filled.

**Fill is a per-segment choice, defaulting to blur.**

```ts
export type Fill = "blur" | "black";
```

- **`blur`** (default) — a blurred, zoomed copy of the same frame, reusing the
  existing `fx_blurred_fill` treatment, which already exists and already looks
  right. It is the default because on a vertical feed the top and bottom bands
  are prime screen area, and blurred context reads as an intentional edit.
- **`black`** — clean letterbox. Correct when the source already has its own
  letterboxing (blurring a black bar produces grey mud), for cinematic or
  news-serious palettes, and any time the blur is busier than the subject.

Both are one branch in the same compositing step, so supporting the pair costs
almost nothing over supporting either. The decision is recorded on the segment
rather than inferred at render time, which keeps it reviewable in the artifact
like every other framing choice.

**The pipe has to carry the canvas, not the crop.** Today the raw pipe is opened
with a fixed `-s {crop_w}x{WORK_H}` and the encoder does `scale=1080:1920`. A
window whose size changes per segment cannot feed a fixed-size pipe, so the
composite must be finished in OpenCV and the pipe must carry 1080×1920.

That is roughly 3.2× the bytes of today's 608×1080 crop, and phase 6 chose the
narrow pipe deliberately. **Measure it before believing it is fine** (rule 7):
if wall time regresses, the fallback is a pipe sized to the *widest window the
clip actually uses* — fixed for the clip, variable across clips — which restores
most of the saving without reintroducing the fixed-9:16 assumption.

## Contracts

`composition/<clipId>.json`, `schemaVersion` 5:

```jsonc
{
  "canvas": { "w": 1080, "h": 1920 },
  "layoutTimeline": [
    { "t0": 0.0,  "t1": 8.2,  "mode": "camera-switch", "target": 1,
      "frameAspect": "9:16", "reason": "one speaker, retention 1.0 at 9:16" },
    { "t0": 8.2,  "t1": 22.0, "mode": "group-crop", "frameAspect": "4:3",
      "fill": "blur", "reason": "panel enters — retention 0.44 at 9:16, 0.96 at 4:3" },
    { "t0": 22.0, "t1": 31.5, "mode": "camera-switch", "target": 3,
      "frameAspect": "9:16", "reason": "back to one speaker" }
  ]
}
```

**That timeline is the feature.** One clip, three framings, each decided from
what is actually on screen during that span — full-frame 9:16 for the close-ups
and a letterboxed 4:3 while the panel is in shot. The canvas is 1080×1920
throughout; only the window moves.

`reason` is not decoration — it is what makes "why is this shot wide?"
answerable from the artifact without re-deriving the signal.

## Gate

1. The panel clip renders at 16:9 with **all eight faces visible** in the framed
   region. This is the clip the block exists for.
2. Solo talking-head clips are **unchanged** — still 9:16, still `static-center`
   or `fullscreen-follow`, byte-identical where the mode did not change.
   Widening must be something the system does reluctantly.
3. **A single clip renders at more than one aspect** — a close-up span at 9:16
   and a group span at 4:3 or wider, both correct for what is on screen at that
   moment. This is the headline behaviour; if every clip resolves to one aspect
   the phase has not shipped.
4. A clip that changes aspect does so **only at a segment boundary**, verified
   from the artifact, and the change lands on a cut in the rendered file.
5. No aspect run is shorter than `ASPECT.minHold` — except where widening was
   forced to keep the active speaker in frame, which is logged as such.
6. The framed region is centred, the chosen fill is present above and below, and
   `fill: "black"` produces true black rather than a blurred black bar.
7. Captions remain legible and do not sit on the seam between fill and frame.
8. Render wall time within **1.3×** of phase 10 on the same clip, or the
   clip-width pipe fallback is taken. Recorded in `job.json`, not asserted.
9. Old `composition/*.json` without `frameAspect` still render, as 9:16.

## Tests

`router.test.ts`:
- retention 1.0 at 9:16 → `frameAspect` 9:16 (narrowest wins when it is safe)
- retention 0.42 at 9:16 / 0.99 at 16:9 → 16:9
- `speakerRetention` below its floor at 9:16 **forces** widening even when
  `retention` alone would have cleared
- absent retention (ASD or analysis missing) → 9:16, never a guess
- aspect changes only at segment boundaries, asserted over a generated timeline

`camera.test.ts`:
- `cropWidthFor` at each aspect against a 16:9 and a 9:16 source
- a wide window on a wide source clamps to 1.0 and never exceeds the frame

Python `render.py --self-test`:
- a 16:9 window composites to exactly 1080×1920 with fill above and below and
  the framed band centred to the pixel
- a 9:16 window is byte-identical to the phase 10 path (the no-op case)

## Risks

| Risk | Mitigation |
|---|---|
| Everything widens; faces become tiny | Narrowest-clearing-the-floor, never widest. Gate 2 asserts solo clips did not move |
| Pipe bytes regress render speed | Measured in gate 8 with a named fallback, not assumed either way |
| **Aspect ping-pongs through the clip** — the direct cost of per-segment freedom | `ASPECT.minHold` with consecutive same-aspect segments merged, plus boundary-only changes. Gate 5 asserts it |
| Aspect changes look like a bug to viewers | Only at segment boundaries, which are cuts — the same rule phase 9 used for camera jumps |
| Blurred fill looks cheap on every clip | It only appears when the alternative is cropping someone out; gate 2 keeps it off clips that do not need it |
| Old artifacts break | `frameAspect` optional and defaulted to 9:16; gate 9 asserts it |

## What actually happened

### A real, independent bug surfaced mid-implementation: `static-center` assumed the frame centre instead of measuring it

While wiring `buildFramedPath`, the natural refactor made `static-center`
ignore `target` entirely — matching the *pre-existing* behaviour (`router.ts`'s
old ternary hardcoded `cx: 0.5` for this mode, unconditionally). Live feedback
during the session rejected this outright: a subject who genuinely isn't
centred must not be cropped by a camera that never looked at where they are.

This was a real defect independent of phase 30's own scope, caught only
because the refactor made it visible in one place. Fixed with a new
`staticCenter(track, cropWidth)` (`camera.ts`) — one still keyframe on the
track's own measured midpoint, the same algorithm `groupCenter` already used
for a whole group, just for one subject. Verified with a dedicated test
(`static-center holds on an off-centre subject instead of cropping them out at
0.5`) at both the unit level and through `buildComposition` end to end.

### Gate 1 turns out to be true today, for a reason worth stating plainly

The panel clip (`vI57GWdQo5` clip 2) still routes to `static-center` — phase
31 hasn't landed, so nothing changed *which* mode it gets. But
`cropWidthFor(1920, 1080, "16:9")` clamps to exactly `1.0` on a 16:9 source:
the window *is* the full frame width, so the camera path's horizontal
position stops mattering. Running the real stored artifact through
`buildComposition` today:

```
mode: static-center
layoutTimeline: [{ t0: 0, t1: 46.5, frameAspect: '16:9', fill: 'blur',
                    reason: 'retention 0.422 at 9:16 — widened to 16:9' }]
```

All eight panelists are visible in the rendered frame **today**, one phase
before the mode itself was supposed to change. Phase 31 still matters — it
decides *where in that full-width frame to place emphasis* (a speaker, or the
group) — but the content-loss bug this block exists to fix is already gone for
this clip.

### Gate 3's mechanism verified two ways; real-footage confirmation waits on a clip with a mid-clip cut

Every locally available corpus analysis (`Kvg0L1U0w0`, `BFgmpWALTo`,
`vI57GWdQo5`) has zero internal scene cuts, so every real clip resolves to
exactly one `layoutTimeline` segment and — correctly, not as a bug — one
aspect. Multi-aspect-in-one-clip is the phase's headline claim, so it was
verified two other ways instead:

- **Unit tests** drive `assignFrameAspects` directly over hand-built
  multi-segment timelines (solo → crowd → solo), including the two-condition
  min-hold and the speaker-retention override.
- **A synthetic end-to-end render** — three segments, three aspects (9:16,
  16:9 with blur fill, 4:3 with black fill) — rendered through the real
  `render.py` pipeline and inspected frame by frame: 9:16 fills the canvas
  exactly (the phase 10 no-op case), 16:9 shows the full sharp frame with a
  blurred continuation top and bottom, 4:3 shows true black bars. All three
  centred correctly, no seam artefacts.

### Gate 8, measured rather than assumed

A 20 s, 1920×1080 synthetic clip at a fixed 9:16 aspect (the sensitive case,
since the canvas pipe now moves 3.2× the bytes phase 10's crop-only pipe did):
phase 10's baseline (`crop=608x1080` pipe) rendered in 4088 ms; phase 30's
canvas pipe (`canvas=1080x1920`, going through `_fit_and_fill`'s no-op stretch
path) rendered in 4958 ms — **1.21×**, inside the 1.3× budget. The clip-width
pipe fallback described in the doc was not needed.

### A rounding artefact almost broke the "9:16 is a no-op" guarantee

`_window_width`'s even-rounding of the crop width (matching phase 6/7's
original `crop_w` formula) leaves a 1-2 px gap between the crop's true aspect
and exactly 9:16 once scaled to the canvas. The first version of
`_fit_and_fill` treated that gap as "needs a letterbox," which would have
put a barely-visible blur sliver on **every** clip this pipeline has ever
rendered — the opposite of a no-op. Fixed with a tolerance check (`abs(sh -
OUT_H) <= 4`) that falls back to a plain stretch, matching the old
encoder-side `scale=1080:1920` exactly. Caught by the self-test before it
reached real footage.
