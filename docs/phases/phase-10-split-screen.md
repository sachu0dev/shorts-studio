# Phase 10 — Split-screen renderer

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
