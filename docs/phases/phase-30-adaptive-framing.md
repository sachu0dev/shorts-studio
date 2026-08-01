# Phase 30 — Adaptive framing window

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

Selection is deterministic and reuses phase 29's numbers — **the narrowest
aspect clearing the retention floor**, never the widest that fits:

```
frameAspect = narrowest a in CANDIDATE_ASPECTS where
                retention[a]        >= RETENTION.floor
                and speakerRetention[a] >= RETENTION.speakerFloor
              else widest candidate
```

Narrowest-first is the whole ethic of the rule. A wider window keeps more people
but makes every face smaller on a phone screen, and a Short that is technically
complete and practically unwatchable is not an improvement. Widening is what you
do when the alternative is cutting someone out, not a default.

**Aspect may only change at a segment boundary.** Segments already begin at a
scene cut or a min-hold expiry (phase 9), so this costs nothing and buys the
guarantee that the frame never resizes mid-shot — which reads as a rendering
fault, exactly like panning across a cut does.

### `server/pipeline/camera.ts` — window width per segment

`cropWidthFor(sourceW, sourceH, aspect)` gains its third argument and keeps
returning a normalized fraction, so every clamp in `buildCameraPath`,
`buildSwitchPath`, `buildHalfPath` and `groupCenter` keeps working unchanged —
they all already take `cropWidth` as a parameter rather than deriving it. This
is why phase 7 was written that way and it pays out here.

### `worker/stages/render.py` — fit and fill

Per frame, the window is cropped at its segment's aspect, scaled to the canvas
width, and centred vertically; the remainder is filled.

**Fill is a blurred, zoomed copy of the same frame** — the existing
`fx_blurred_fill` treatment, which already exists and already looks right. Not
black bars: black bars on a phone read as "this video is broken" and waste the
most valuable screen area on a vertical feed.

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
    { "t0": 0.0,  "t1": 8.2,  "mode": "camera-switch", "target": 1, "frameAspect": "9:16" },
    { "t0": 8.2,  "t1": 22.0, "mode": "group-crop",    "frameAspect": "16:9",
      "fill": "blur", "reason": "retention 0.42 at 9:16, 0.99 at 16:9" }
  ]
}
```

`reason` on the segment is not decoration — it is what makes "why is this shot
wide?" answerable from the artifact without re-deriving the signal.

## Gate

1. The panel clip renders at 16:9 with **all eight faces visible** in the framed
   region. This is the clip the block exists for.
2. Solo talking-head clips are **unchanged** — still 9:16, still `static-center`
   or `fullscreen-follow`, byte-identical where the mode did not change.
   Widening must be something the system does reluctantly.
3. A clip that changes aspect does so **only at a segment boundary**, verified
   from the artifact, and the change lands on a cut in the rendered file.
4. Letterboxed output has no black bars — the fill is present top and bottom and
   the framed region is centred.
5. Captions remain legible and do not sit on the seam between fill and frame.
6. Render wall time within **1.3×** of phase 10 on the same clip, or the
   clip-width pipe fallback is taken. Recorded in `job.json`, not asserted.
7. Old `composition/*.json` without `frameAspect` still render, as 9:16.

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
| Pipe bytes regress render speed | Measured in gate 6 with a named fallback, not assumed either way |
| Aspect changes look like a bug to viewers | Only at segment boundaries, which are cuts — the same rule phase 9 used for camera jumps |
| Blurred fill looks cheap on every clip | It only appears when the alternative is cropping someone out; gate 2 keeps it off clips that do not need it |
| Old artifacts break | `frameAspect` optional and defaulted to 9:16; gate 7 asserts it |
