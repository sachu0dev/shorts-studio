# Phase 9 — camera-switch + group-crop

**Goal:** on multi-speaker footage, the camera cuts to whoever is talking — and
knows when not to bother.

## Why now

Phase 8 made "who is speaking" authoritative. This is the phase that spends it,
and master plan §6 calls it *"the quality tier the incumbents visibly miss."*

Two modes, and the second matters as much as the first:

- **`camera-switch`** — cut between speakers as they take turns.
- **`group-crop`** — when everyone fits one 9:16 window, just crop wider and
  don't switch at all. Switching when a single crop would work is a gimmick, and
  the system must be able to decide against it.

> **Inherited from phase 8 — face track ids are not identity-stable across
> scene cuts, and this is the phase where that becomes load-bearing.** Measured
> on a multi-cam window: **13 of 22 tracks span a cut**, and one track covered
> *two different people* — the tracker matched them because they occupied a
> similar position either side of the cut. `camera-switch` cutting to "track 2"
> across such a boundary lands on the wrong person while claiming to be right.
>
> Retiring tracks at every cut was tried in phase 8 and **reverted**: on a solo
> window with 6 cuts in 25 s the primary track shatters into 7 fragments,
> `distinctFaceTracks` drops to 0, and `buildCameraPath` gets a 4 s track for a
> 25 s clip. It fixes identity by destroying phase 7.
>
> The fix that works for both is **re-identification across cuts** — match a
> post-cut face to a pre-cut track by appearance rather than position — so a
> track id survives a cut only when it is the same person. Do it here, before
> the first switch is rendered, and add it to this phase's gate: *a switch never
> lands on a different person than the segment claims.*

## Scope

Both modes, plus the three rules that separate "works" from "looks broken".

## Out of scope

Split-screen — phase 10. `overlapRatio > 0.25` still routes to `camera-switch`
here; phase 10 takes it over.

## Changes

### `server/pipeline/router.ts` — implement the multi-speaker branch

```
facesFitOneCrop    → ["group-crop", "fullscreen-follow"]
overlapRatio > 0.25 → ["camera-switch"]          // phase 10 prepends "split-screen"
otherwise          → ["camera-switch", "group-crop"]
```

`facesFitOneCrop` wins over turn-based switching. It was defined precisely in
phase 4 — all active face boxes fit one 9:16 window with ≥5% margin — and that
precision is what makes this branch trustworthy.

### `server/pipeline/timeline.ts` (new)

```ts
export function buildLayoutTimeline(
  activeTrack: (number | null)[], sampleStep: number,
  cuts: number[], binding: SpeakerBinding, opts: SmoothingPreset
): LayoutSegment[]
```

Turns the per-sample `activeTrack` array from phase 8 into held segments. **The
three rules from master plan §3.2, all of them enforced here:**

**1. Minimum hold (~2.0 s).** Once a layout or active speaker is chosen, hold it.
Without this, every "yeah" and "mhm" triggers a cut and the result is unwatchable.
This is the single most important line in the phase.

**2. Snap on scene cut.** At a source cut, reset instantly and re-decide the
layout for the new scene. Never ease across a hard cut.

**3. Hysteresis on ASD.** Already applied in phase 8 — `activeTrack` arrives
stable. Do not re-implement it here; consuming a stable signal is the whole point
of having built it upstream.

Edge cases that must be handled explicitly, not by accident:

- **Speaker bound to `null`** (off-camera, from phase 8) → hold the current
  frame. Never cut to the nearest visible face; that is confidently wrong.
- **Overlap** — two speakers active at once, but `overlapRatio` below the
  split-screen threshold → stay on the current speaker. Don't oscillate.
- **A turn shorter than min-hold** → absorbed into the surrounding segment.
- **A segment shorter than min-hold at a scene-cut boundary** → the cut wins;
  min-hold does not override a real source cut.

### `worker/stages/render.py` — `group-crop`

One crop window containing all active face tracks, with margin, held steady.
It is not a camera move; it is a wider static frame. Reuse the phase 7 camera
path machinery with a constant target — one code path.

### `camera-switch` transitions

A hard cut, not a pan. Panning between two people who are two metres apart looks
like a mistake. `zoom` may differ between targets; position changes instantly.

## Contracts

`composition/<clipId>.json` — `layoutTimeline` becomes genuinely multi-segment:

```jsonc
{
  "layoutTimeline": [
    { "t0": 0.0,  "t1": 12.4, "mode": "camera-switch", "target": 1, "reason": "SPEAKER_00 active" },
    { "t0": 12.4, "t1": 20.1, "mode": "camera-switch", "target": 2, "reason": "turn", "snapped": true },
    { "t0": 20.1, "t1": 36.3, "mode": "group-crop", "reason": "facesFitOneCrop" }
  ],
  "heldSegments": 2,
  "suppressedSwitches": 7
}
```

`suppressedSwitches` — how many switches min-hold rejected — is the fastest way
to tell whether the tuning is right. Zero on a fast podcast means min-hold isn't
working; twenty on a calm interview means it's too aggressive.

## Gate

On the corpus podcast source:

1. **No cut is triggered by a one-word "yeah" or "mhm".** Verify by finding
   backchannel moments in the transcript and watching those timestamps. This is
   the phase's headline failure mode.
2. **No pan across a hard cut.**
3. `group-crop` is chosen — and looks right — on at least one clip where both
   speakers genuinely fit one frame.
4. Switches align with real turn boundaries within ~0.3 s.
5. `suppressedSwitches > 0` on fast-exchange footage.
6. An off-camera speaker never causes a cut to a wrong face.
7. `calm` produces visibly fewer switches than `dynamic`.

## Tests

`timeline.test.ts` — pure, fixture `activeTrack` arrays:
- a 0.4 s turn (below min-hold) produces no segment
- a 3 s turn does
- a scene cut always begins a new segment, even mid-hold
- `null` active track holds the previous segment rather than emitting a segment
- `facesFitOneCrop` yields `group-crop` and zero switches
- `suppressedSwitches` counts correctly
- segments are contiguous, non-overlapping, and cover the full clip — no gaps

That last one is worth its own assertion. A gap in the timeline is a black frame.

## Risks

| Risk | Mitigation |
|---|---|
| min-hold too long → misses genuinely fast exchanges | Preset-tied; `suppressedSwitches` makes it measurable rather than a vibe |
| Wrong binding from phase 8 → confident cuts to the wrong face | Phase 8's gate is the guard; `reason` per segment makes it traceable |
| `group-crop` chosen when faces are too far apart | The ≥5% margin definition from phase 4; verify by eye on the corpus |
| Timeline has a gap or overlap | Asserted directly in tests |
| Switching feels mechanical even when correct | This is what phase 12's taste layer is for — don't over-tune here |
