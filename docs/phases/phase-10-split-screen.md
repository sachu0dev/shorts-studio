# Phase 10 — Split-screen renderer

**Status: built.** Gates 2, 3, 4, 5, 7 pass (verified by test + one synthetic
end-to-end render). **Gate 1 and gate 6 are unexercised** — the corpus has no
clip with genuine, ASD-confirmed two-speaker crosstalk, and `overlapRatio`
still depends on the same gated `pyannote` repo phase 8 hit. See "What actually
happened".

**Goal:** when two people genuinely talk over each other, show both at once.

## Why now

Deliberately last of the layout work. Master plan §6: *"Most complex renderer,
narrowest applicability — correctly last."*

It only earns its place when `overlapRatio > 0.25` — a quarter of the clip with
two speakers active. On clean turn-taking it is strictly worse than
`camera-switch`, because it halves everyone's face for no reason.

## Scope

The renderer and the routing rule that unlocks it.

## Out of scope

Three-plus-way splits. If `distinctFaceTracks > 2` and everyone overlaps,
`group-crop` from phase 9 is the answer — it already handles "several people at
once" correctly and costs nothing.

## Changes

### `server/pipeline/router.ts`

```
overlapRatio > 0.25 → ["split-screen", "camera-switch"]
```

`camera-switch` stays second as the fallback, so a split-screen render failure
degrades to a working edit rather than a broken one.

Two hard preconditions, asserted not assumed:
- `distinctFaceTracks >= 2` — the factual impossibility guarantee from phase 7's
  tests already covers this; keep the assertion when the mode is actually used.
- **Both tracks are bound to real speakers** by phase 8. Splitting the screen
  between a speaker and a silent bystander is worse than not splitting.

### `worker/stages/render.py` — split composition

**Stacked (top/bottom)** is the default for 9:16. Two 1080×960 halves, each a
9:8 crop centred on its face track. Side-by-side wastes the vertical frame.

Both halves are **independently tracked** using the phase 7 camera path, one per
track. That's the advantage over the current ffmpeg `split-screen-duo` template,
which crops fixed halves of the source and cannot follow anyone.

**Speaker emphasis.** The active speaker's half gets a subtle lift — slightly
larger, or the inactive half slightly dimmed. Without it the viewer has no cue
who is talking, which is most of what makes split-screen readable. Keep it
subtle; a hard highlight looks like a video call UI.

Ordering must be **stable**: track with the lower first-seen time goes on top,
and it never swaps mid-clip. A mid-clip swap is disorienting and reads as a bug.

### Entering and leaving split

Split-screen is a segment in `layoutTimeline`, not a whole-clip mode. A clip
typically opens on one speaker, splits during crosstalk, and returns.

- Transitions are **hard cuts**, subject to phase 9's min-hold. A 1-second split
  is a flicker; the min-hold rule applies unchanged.
- On a scene cut, re-decide from scratch, same as every other mode.

### Retire `split-screen-duo`

The fixed-half ffmpeg template ported in phase 6 is superseded. Remove it from
`LayoutTemplate` and from the LLM prompt's allowed list — leaving both means the
LLM can pick the dumb one. **Deletion, not deprecation.**

## Contracts

```jsonc
{
  "layoutTimeline": [
    { "t0": 0.0,  "t1": 8.2,  "mode": "camera-switch", "target": 1 },
    { "t0": 8.2,  "t1": 19.6, "mode": "split-screen",
      "targets": [1, 2], "arrangement": "stacked", "reason": "overlapRatio 0.41" },
    { "t0": 19.6, "t1": 36.3, "mode": "camera-switch", "target": 2 }
  ]
}
```

`targets` is ordered — index 0 is top. `activeTrack` from phase 8 still drives
emphasis within the segment.

## Gate

1. **Fires only on genuine crosstalk.** Verify against the corpus podcast: every
   split segment corresponds to a real overlap in the transcript. A split during
   clean turn-taking is a failure.
2. Both halves track their subjects independently — heads stay framed as people move.
3. Active-speaker emphasis is visible but not distracting.
4. Top/bottom assignment never swaps mid-clip.
5. Entering and leaving split respects min-hold. No segment under ~2 s.
6. On a source with `overlapRatio < 0.25` across all clips, split-screen **never
   appears**. Equally important as it appearing when it should.
7. Falls back to `camera-switch` if either binding is missing.

## Tests

`router.test.ts` additions:
- `overlapRatio > 0.25` with 2 bound tracks → `split-screen` first
- `overlapRatio > 0.25` with only 1 bound track → **not** `split-screen`
- `distinctFaceTracks < 2` → never `split-screen`, at any `overlapRatio`

`timeline.test.ts` additions:
- a split segment shorter than min-hold is absorbed
- `targets` ordering is stable across the clip
- a scene cut inside a split segment ends it

Python: two synthetic tracks composite into the correct halves; frame dimensions
are exactly 1080×1920 with no seam.

## Risks

| Risk | Mitigation |
|---|---|
| Split fires on clean turn-taking | `overlapRatio` threshold + gate item 6; tune the threshold against the corpus, not by feel |
| Halves crop badly when faces are near frame edges | Per-half camera path has its own margin clamp |
| Emphasis effect too strong, looks like a call UI | Subtle by default; it's a tunable |
| Both people in one source rectangle (sitting close) | `facesFitOneCrop` routes to `group-crop` before split is considered — phase 9 already wins that case |
| Most complex renderer, least-used path, rots silently | It's gated behind a measured signal, so if it never fires the corpus will show that |

## What actually happened

### "Bound to a real speaker" reuses phase 8's ASD workaround, not diarization

The spec's precondition — both halves bound to a real speaker — reads like it
needs `bindSpeakersToTracks`' diarized labels. It doesn't have to: phase 8
already measures who talks from ASD scores alone (`speakingTracks`, the
renamed and sorted `asdSpeakerCount` internals), because `pyannote` has been
gated since phase 2 and every phase since has had to route around it. Split-
screen's two targets are just the two most-talkative tracks by that same
measure, ordered by first-seen time once and never recomputed — which is what
makes "never swaps mid-clip" true by construction rather than by convention.

### Entering and leaving split reuses phase 9's min-hold verbatim, via one trick

`buildLayoutTimeline`'s cut/min-hold machinery already does exactly what
split-screen needs — a switch has to earn its hold, a challenger has to earn
its turn, cuts always win — so `buildSplitAwareTimeline` doesn't reimplement
it. It maps "both targets are concurrently over the ASD speaking threshold" to
a sentinel track id (`-1`, below any real id) and feeds that through the
existing function with a `mode` selector instead of a constant. A `null`
entry from a real face track can never collide with the sentinel, so a
one-word backchannel gets absorbed by the exact same rule that already kills
the phase 9 "yeah" problem. The only new code is the post-process that turns
sentinel segments into `{ mode: "split-screen", targets, arrangement }`.

### The renderer needed no new geometry, just a second, half-height crop window

`render.py`'s existing crop width (`crop_w`, sized for a 9:16 window against
the decoded frame's full height) is *already* a 9:8 window against half that
height — `crop_w / (WORK_H/2) == (crop_w/WORK_H) * 2 == (9/16) * 2 == 9/8`
— so a split half is `frame[y0:y0+WORK_H//2, x0:x0+crop_w]`, no separate
scale factor to derive. `camera_cx` generalized to `camera_at(path, t, key)`
so the same interpolator drives both halves' `cx` and `cy` — vertical
tracking is new (`buildHalfPath` in `camera.ts`, reusing the deadzone/smooth/
snap math via a pulled-out `trackAxis` helper rather than a second copy of
it). Emphasis is a flat 0.82 multiply on the half ASD says isn't talking.

Verified with a synthetic end-to-end render (`testsrc` source, hand-written
composition mixing `camera-switch` and `split-screen` segments): 180 frames,
h264_nvenc, 1080x1920, the split frame's two halves visibly pull different
source regions with a clean seam at exactly half height, and the surrounding
`camera-switch` frames render as a single full crop as before. `render.py
--self-test` checks the same seam and the dimming direction with pixel
assertions rather than eyeballing.

### Gates 1 and 6 are unexercised, honestly

Neither the transcript-diarization `overlapRatio` (still blocked on
`pyannote/speaker-diarization-community-1`, unresolved since phase 2) nor a
corpus clip with two ASD-confirmed concurrent speakers exists yet to run gate
1 against. The one cached job with `asd/` artifacts predates phase 9's
cross-cut re-identification fix and reports 5–6 "speaking" tracks per clip —
fragmentation phase 9 already fixed for later runs — so it isn't trustworthy
evidence either way and isn't cited as a result. `split-screen-duo` (the old
fixed-half ffmpeg template) is deleted, not deprecated, per the plan: `jobs.ts`,
`analyze.ts`'s `VALID_LAYOUTS` and LLM prompt, and `render.py`'s `EFFECTS` map
no longer mention it.
