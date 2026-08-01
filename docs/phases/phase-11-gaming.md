# Phase 11 — Gaming composition (facecam + action tracking)

**Goal:** gameplay clips get the composition a human gaming editor would give
them, not a generic centre crop.

## Why now

**This phase is not in the master plan.** It exists because of decisions 1 and 2:
composition is auto-detected across *all* content types, and gaming gets full
support rather than a blurred-fill fallback.

The gap it fills is real. Phase 5 classifies gameplay as `screen-rec`, and phase
7 routes that to `blurred-fill` — watchable, but visibly worse than a human edit,
and gaming is one of the largest Shorts categories in India.

> **Inherited from phase 7: `blurred-fill` is routed but not built.** `route()`
> returns it first for both `screen-rec` and `b-roll`, and
> `IMPLEMENTED_MODES` in [router.ts](../../server/pipeline/router.ts) does not
> contain it, so every gameplay clip currently falls back to `static-center`
> with a logged reason. **A centre crop of a 16:9 gameplay frame throws away most
> of the screen** — this is the worst live output in the pipeline today, worse
> than the `blurred-fill` the paragraph above calls merely "watchable".
>
> Phase 6 has a `blurred-fill` *effect* (`fx_blurred_fill`), but it is not the
> same thing: it runs on the already-cropped 9:16 window, so it blurs a crop
> rather than fitting the whole frame. The layout mode needs the **uncropped**
> frame, which means `render.py` must decode full-width and skip the crop for
> this mode. Building that is the cheapest real win in this phase and does not
> depend on facecam detection or action tracking — **do it first**, then add
> `IMPLEMENTED_MODES.push("blurred-fill")` and the fallback disappears on its own.

Two features, both needed for the classic gaming Short:

- **Facecam detection** — find the commentator's inset window and preserve it.
- **Action-region tracking** — find where the action is in a 16:9 gameplay frame
  and crop 9:16 around *that*, not around the centre.

## Scope

`screen-rec` composition only. Talking-head and multi-speaker paths are untouched.

## Out of scope

Game-specific understanding (killfeed, minimap, HUD parsing). Generic motion and
saliency handles the common case; anything more is a different product.

## Changes

### `worker/stages/gamecam.py` (new) — facecam detection

A facecam is a face that is **small, near a corner, and spatially stable**. Phase
4 already provides all three inputs — `faceSizeRatio`, track centroid, and
`subjectMotion` — so this is a classification over existing data, not new CV.

```
faceSizeRatio < 0.20
  and centroid within ~25% of a frame corner
  and centroid variance below a small threshold over the clip
  → facecam, with its bounding box
```

Also detect the **rectangular border** many facecams have (edge detection
constrained to the face's neighbourhood) — it gives a tighter crop than the face
box alone and catches the common circular/rounded-rect overlay.

If no facecam is found, that's a normal outcome, not a failure. Plenty of
gameplay has none.

### `worker/stages/action.py` (new) — action-region tracking

Where is the interesting part of a 16:9 gameplay frame?

1. **Motion energy** — frame differencing on a downscaled copy, accumulated into
   a coarse grid. Cheap, CPU, and surprisingly effective: in most games the
   action is where things move.
2. **Centre bias** — crosshair games put the action dead centre. Weight the
   centre so a busy HUD corner can't drag the crop away.
3. **HUD suppression** — screen edges and corners are usually static UI. Damp the
   outer ~10% so a flashing minimap doesn't become "the action".

Output is a smoothed region-of-interest path over time, reusing the phase 7
camera smoothing (deadzone, EMA, snap-on-cut) so the crop doesn't twitch. Same
machinery, different target — no new smoothing code.

**Exclude the facecam region from motion analysis.** A talking face is the
highest-motion area in the frame and will otherwise win every time.

### New layout modes

| Mode | Composition | When |
|---|---|---|
| `gameplay-facecam-stack` | gameplay 9:16 crop on top (~65%), facecam below (~35%) | facecam found |
| `gameplay-facecam-pip` | full-height gameplay crop, facecam as a corner PiP | facecam found, small |
| `action-follow` | 9:16 crop following the action region | no facecam |
| `blurred-fill` | existing fallback | action tracking unreliable |

### `server/pipeline/router.ts`

```
type === "screen-rec" → facecam && actionConfidence > 0.5
                          ? ["gameplay-facecam-stack", "gameplay-facecam-pip", "blurred-fill"]
                        : facecam
                          ? ["gameplay-facecam-pip", "blurred-fill"]
                        : actionConfidence > 0.5
                          ? ["action-follow", "blurred-fill"]
                          : ["blurred-fill", "static-center"]
```

`blurred-fill` is always the last entry. When action tracking is unsure, a
generic edit is the correct output — the same conservative-on-low-confidence rule
as phase 5 and 7.

### Captions

Gaming Shorts are caption-led. Where the facecam sits bottom in
`gameplay-facecam-stack`, captions must not collide with it — the ASS `MarginV`
in `buildStyleLine` needs to be layout-aware. This is a small change to
`captions.ts` and easy to forget until you see it overlapping a face.

## Contracts

`analysis/<clipId>.json` extended:

```jsonc
{
  "screenRec": {
    "facecam": { "x": 0.72, "y": 0.62, "w": 0.24, "h": 0.30, "confidence": 0.88, "shape": "rounded-rect" },
    "actionRegion": [ { "t": 0.0, "cx": 0.51, "cy": 0.47, "confidence": 0.74 } ],
    "actionConfidence": 0.74,
    "hudSuppressed": true
  }
}
```

`actionConfidence` low means "motion was diffuse, no clear region" — which is a
real and common answer for menu screens, cutscenes and slow games.

## Gate

On the corpus gaming source plus at least two more gameplay clips of different genres:

1. Facecam is found and **fully preserved** — never cropped in half. Cropping
   through a commentator's face is the failure everyone notices.
2. Action-follow keeps the action in frame on a fast-motion clip.
3. A menu/cutscene section yields low `actionConfidence` and falls back to
   `blurred-fill` instead of chasing noise.
4. Captions never overlap the facecam in stacked mode.
5. Gameplay with no facecam routes to `action-follow`, not `blurred-fill`.
6. **No regression**: talking-head and podcast sources are byte-identical to
   phase 10 output. This phase must not touch them.
7. Runs on CPU alongside the existing budget; `job.json` shows no VRAM spike.

## Tests

`gaming.test.ts` (TS, pure, over fixture signals):
- small + cornered + stable → facecam
- large + centred face → **not** a facecam (that's a talking-head with gameplay behind)
- no face → no facecam, no error
- `actionConfidence < 0.5` always includes `blurred-fill` first

Python:
- synthetic frames with a bright moving square → action region tracks the square
- motion confined to the facecam region → action region does **not** follow it
- static frames → low `actionConfidence`, not a random region

## Risks

| Risk | Mitigation |
|---|---|
| Facecam detection fires on a talking-head with a gameplay background | Size + corner + stability all required, not any one |
| Action tracking chases HUD animations | Edge damping + centre bias; verify on a HUD-heavy game |
| Motion energy meaningless in slow/strategy games | `actionConfidence` low → `blurred-fill`. Correct, not a failure |
| Two facecams (co-op) | Take the highest-confidence one; log the second. Multi-facecam is out of scope |
| Frame differencing costs too much CPU | Downscale hard before differencing — the grid is coarse anyway |
| This phase is new and unproven | It's isolated behind `compositionType === "screen-rec"`; gate item 6 proves nothing else moved |
