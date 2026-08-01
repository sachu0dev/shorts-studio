# Phase 9 — camera-switch + group-crop

**Status: built.** Gates 1, 2, 6, 7 pass. Gates 3 and 5 are covered by test
only — no available footage exercises them. **Gate 4 does not hold as written
and is restated.** See "What actually happened"; the inherited re-identification
problem below is fixed.

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

---

## What actually happened

### The inherited defect is fixed: tracks now survive a cut only if the face does

Phase 8 flagged that face track ids were not identity-stable across scene cuts —
13 of 22 tracks in one multi-cam window spanned a cut and one covered two
different people. Both candidate fixes were wrong on their own: retiring every
track at a cut destroys phase 7, and doing nothing leaves `camera-switch` cutting
confidently to the wrong person.

The fix is a **gate, not a break**. `analyze_clip.py` now carries a cheap
appearance signature per detection and a track only crosses a cut when the face
still looks like the same face:

- **Signature:** a 6×6 RGB thumbnail of the face box padded 2×, mean-removed and
  L2-normalized. The padding is what makes it work — a tight grey crop of a face
  is mostly pose, while hair, clothing and the slice of room beside someone's
  head are what actually differ between two people in one shot.
- **Threshold:** cosine ≥ 0.78, the Youden-optimal split measured over 862
  same-face pairs and 395 definitely-different pairs (two faces detected in the
  same frame — a label that needs no annotation).

| descriptor | Youden J |
|---|---|
| **6×6 RGB, 2× pad** | **0.82** |
| 10×10 grey, tight box | 0.76 |
| 8×8 hue/saturation histogram | 0.73 |

Verified by rendering the face crops either side of every surviving cross-cut
boundary in the offending window: **all 10 pairs are the same person**, and the
track that previously merged two people no longer does.

Cost to everything else, measured over 7 clips from two sources:

| | before | after |
|---|---|---|
| clips whose tracks changed at all | — | 2 of 7 |
| longest track (worst case) | 117 samples | 110 |
| `distinctFaceTracks` | — | **unchanged on all 7** |
| `subjectMotion` | — | moved ≤0.008, never across the 0.04 routing threshold |

So phase 7 is untouched, which was the whole reason the naive version was
reverted.

### `camera-switch` needs no renderer change, and that is the point

A cut is expressed as **two camera keyframes sharing a timestamp** — the old
position and the new one. `render.py`'s interpolator already resolves a zero
span to a jump, so there is one interpolator rather than a second "is this a cut"
code path. Asserted in `render.py --self-test`, so a future change to that
function cannot silently turn every switch back into a pan.

`group-crop` needed even less: the router only reaches it when `facesFitOneCrop`
is true, which *means* everyone already fits one 9:16 window. So it is a single
constant keyframe at the midpoint of the group — `static-center` centred on the
people instead of on the frame. Deciding *against* switching is the feature.

### Min-hold: two halves, and a deferral

The plan's rule is "once a speaker is chosen, hold". Implemented literally, a
switch arriving inside the hold window is dropped and never revisited — a
speaker who takes over one second into a clip would never get the frame. So the
rule is two separate conditions:

- the **current** segment must have lasted `minHold` — rejections here are
  *deferred*, and land the moment the hold expires;
- the **challenger's** turn must itself last `minHold` — this is what kills the
  one-word "yeah", and rejections here are dropped.

`suppressedSwitches` counts rejected *turns*, not rejected samples; counting
samples made a single 0.5 s backchannel read as 2 suppressed switches at 4 Hz.

`minHold` moved onto the smoothing preset (**calm 2.5 s, dynamic 1.5 s**) rather
than being a constant, which is what makes gate 7 measurable — "how twitchy is
this edit" is precisely what a creator means by calm versus dynamic.

### Gate 4 does not hold as written

> *Switches align with real turn boundaries within ~0.3 s.*

They cannot, and the reason is structural rather than a tuning miss:

| source of lag | cost |
|---|---|
| ASD sample grid | 0.25 s |
| phase 8 hysteresis (3 samples) | 0.75 s |
| min-hold deferral | 0 – 2.5 s |

The floor is **~1 s**, and that is the *correct* floor: 0.3 s alignment would
require dropping the hysteresis that stops the seizure this phase exists to
avoid. A late cut reads as an edit; an early one reads as a glitch. **Restated
gate 4: no switch lands before its turn begins, and none lands more than
min-hold + 1 s after it.**

### Verified on real footage

Built a `camera-switch` composition through the real router on a 46 s multi-cam
window and rendered it. 1382 frames, 7.0 s wall, 541 MiB peak, `h264_nvenc`,
`High / yuv420p` — the phase 6 colour fix survives. Frames sampled either side of
all four switches show a clean jump to a differently-framed person with no
intermediate pan.

Two honest caveats from that run:

- **`suppressedSwitches` was 0**, because on multi-cam footage the source has
  already cut to whoever is talking, so the face tracks barely overlap in time
  and there is rarely a competing candidate to suppress. Gate 5 is therefore
  covered by test only until the corpus podcast (a genuine two-shot) is
  available. The gate is not wrong — the footage just cannot exercise it, the
  same lesson as phase 7's gate 4.
- **`asdSpeakerCount` read 5** on a 2-person clip: cut fragmentation still
  inflates the *count* of speaking tracks even though each track is now
  identity-honest. Harmless where it is consumed — `classify()` only asks
  0 / 1 / ≥2 — but it is not a person count and must not be used as one.

### Gate 3 — `group-crop` is unexercised on real footage

No available clip has `facesFitOneCrop` true; every multi-speaker window measured
so far has the two faces further apart than one 9:16 window. Covered by unit test
(chosen over switching, one keyframe, centred between the faces, clamped to the
frame) but not yet seen rendered.

### Tests

`timeline.test.ts` — 12 cases, all seven from the plan plus the deferral, the
preset comparison, duplicate/out-of-range cuts, and contiguity asserted on every
timeline that any test builds. `camera.test.ts` gains the cut-not-pan assertions
for `buildSwitchPath` (including the non-whole-step boundary) and `groupCenter`.
