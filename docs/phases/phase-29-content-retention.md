# Phase 29 — Content retention signal

**Goal:** make "how much of what matters did this crop throw away?" a number in
the artifact, for every clip, before any renderer changes.

## Why now

This is the measurement that phases 30 and 31 spend, and it is the reason both
of them exist. It was written after a live failure that nobody could see coming
from `job.json`.

**The measurement that triggered this block.** Corpus job `vI57GWdQo5`, clip 2 —
a talent-show panel, 1920×1080 source, 46 s, 753 face-appearances over 185
sampled moments:

| framing window | % of source width | face-appearances kept |
|---|---|---|
| **9:16** (what ships today) | 31.6% | **42.4%** |
| 1:1 | 56.2% | 70.4% |
| 4:3 | 75.0% | 81.5% |
| 16:9 | 100% | 98.5% |

**The 9:16 window this pipeline has always assumed discards 57.6% of the people
on screen**, and nothing in the system says so. `job.json` reports the mode, the
preset, the keyframe count and the encoder — every one of which was "fine" on
the clip that lost half its cast.

That is rule 7 (*instrument from the first commit; the laptop's bottleneck is
not where you think*) applied to output quality instead of speed. A retention
number makes the failure visible on every past clip retroactively and on every
future one automatically.

## Scope

The signal, and only the signal. No routing changes, no renderer changes — this
phase must be able to land without altering a single rendered frame.

## Out of scope

Acting on the number (phase 30 widens the window; phase 31 changes the policy).
Non-face content — text, action regions, product shots. Faces are what the
pipeline already measures, and the panel failure is entirely a face failure.
Phase 11's action region joins the same metric when it exists.

## Changes

### `server/pipeline/retention.ts` (new) — a function of a **time range**, not a clip

This is the load-bearing design decision of the whole block, and getting it
wrong makes phases 30 and 31 impossible.

Retention must be answerable **over any `[t0, t1)`**, because the whole point is
that one clip needs different framing at different moments: a solo close-up at
9:16 for eight seconds, then 4:3 when the panel comes into shot. A single
clip-level score would average those two situations into one number that
describes neither, and the system would pick one aspect for the entire clip —
which is barely better than today's fixed 9:16.

So it is a pure function, not a stored scalar:

```ts
export const CANDIDATE_ASPECTS = ["9:16", "1:1", "4:3", "16:9"] as const;

/** Fraction of face-appearances in [t0,t1) a window of `aspect` retains whole. */
export function retentionOver(
  tracks: FaceTrack[], sourceW: number, sourceH: number,
  t0: number, t1: number, aspect: FrameAspect
): number;

/** Narrowest aspect clearing both floors over [t0,t1), or the widest candidate. */
export function narrowestSafe(
  tracks: FaceTrack[], sourceW: number, sourceH: number,
  t0: number, t1: number, activeTrack?: (number|null)[], sampleStep?: number
): FrameAspect;
```

**No Python change is needed.** `analysis/<clipId>.json` already carries
`faceTracks[].samples[]` with `{t, cx, cy, w, h}` per 4 Hz sample — every input
this metric needs is in the artifact today. Computing it in Node keeps it a pure
unit-testable function with no GPU and no stage, exactly like phase 8 kept
stabilisation and binding on the Node side.

For each sampled moment in the range, slide a window of the aspect's width and
take the placement retaining the most **whole** face boxes. A face clipped in
half counts as lost — a half face on screen is the failure a viewer notices.

Four candidate aspects is enough. They are the framings an editor actually
reaches for, and a continuous search would optimise a number nobody can perceive.

### `server/pipeline/signals.ts` — the clip-level summary, for visibility only

The stored numbers are the whole-clip case of the same function. They exist so
the failure is **visible** in `job.json` and the UI on every clip, including
past ones. They are not what phase 30 reads — that calls `retentionOver` per
segment.

```ts
/** Fraction of face-appearances a window of this aspect retains whole. */
retention?: Record<string, number>;
/**
 * The same, restricted to moments where ASD says that face is the ACTIVE
 * SPEAKER. Losing a silent bystander is an editing choice; losing the person
 * currently talking is a bug, so these are never averaged together.
 */
speakerRetention?: Record<string, number>;
/** Narrowest aspect clearing RETENTION_FLOOR — the recommendation, not a command. */
narrowestSafe?: string;
```

Two numbers because they carry different authority. `retention` is a preference
that trades face size against completeness. `speakerRetention` is a constraint:
**the active speaker is never outside the frame**, and phase 31 treats a
violation as disqualifying rather than as a low score.

`speakerRetention` requires ASD, so it is absent until phase 8's stage has run
and is computed on the Node side from `asd/<clipId>.json` + `faceTracks`, where
it stays unit-testable without a GPU — the same split phase 8 used for
stabilisation and binding.

### `server/index.ts`

Log the retention line next to the existing signals line, and carry
`retention` / `narrowestSafe` into `EditSummary` so the number reaches the UI
rather than only the artifact.

## Contracts

`analysis/<clipId>.json`, `schemaVersion` 4 — the **whole-clip** summary, which
is the reporting surface, not the decision input:

```jsonc
{
  "signals": {
    "retention":       { "9:16": 0.424, "1:1": 0.704, "4:3": 0.815, "16:9": 0.985 },
    "speakerRetention":{ "9:16": 0.910, "1:1": 0.995, "4:3": 1.0,   "16:9": 1.0   },
    "narrowestSafe": "16:9"
  }
}
```

Phase 30 calls `retentionOver(tracks, …, seg.t0, seg.t1, aspect)` per segment and
will routinely reach a *different* answer than this row — a clip that summarises
to 16:9 can still open with eight seconds of correct 9:16 close-up. That is the
intended behaviour, not a disagreement to reconcile.

```ts
export const RETENTION = {
  /**
   * Starting value, to be moved only when the corpus says so — the same rule
   * every threshold in this repo follows. 0.90 is deliberately strict: the
   * panel clip scores 0.424 at 9:16, so nothing about this number is close to
   * the decision on the clip that motivated it.
   */
  floor: 0.90,
  /** The active speaker is a constraint, not a preference. */
  speakerFloor: 0.99,
};
```

## Gate

1. **Every corpus clip reports a retention row**, and the solo talking-head
   sources score ≥ 0.95 at 9:16 — if a one-person clip claims to lose content,
   the metric is wrong, not the clip.
2. The panel clip (`vI57GWdQo5` clip 2) reproduces the table above within ±2%.
   This is the regression test for the metric itself.
3. `speakerRetention` at 9:16 is **strictly higher** than `retention` at 9:16 on
   every multi-face clip. The speaker is nearer the middle than the crowd is; if
   this inverts, the ASD binding is wrong.
4. **No rendered frame changes.** `git diff` over a re-render of two corpus clips
   is empty. A measurement phase that alters output has a bug in it.
5. Added cost < 100 ms per clip and 0 MiB VRAM — it is arithmetic over existing
   boxes.

## Tests

`retention.test.ts` (pure, over fixture face boxes):
- one centred face → 1.0 at every aspect
- two faces at cx 0.1 and 0.9 → < 0.5 at 9:16, 1.0 at 16:9
- a face straddling the window edge counts as **lost**, not partial
- no faces → retention absent, not 0 (absent means unknown; 0 means measured empty)
- `narrowestSafe` returns the *narrowest* clearing the floor, not the best-scoring
- **the time-range test that the whole block rests on**: one track alone for
  0–8 s, then eight tracks for 8–20 s → `retentionOver(…, 0, 8, "9:16") === 1.0`
  while `retentionOver(…, 8, 20, "9:16") < 0.5`. If these two ranges return the
  same number, per-segment framing is impossible and phase 30 cannot work
- the whole-clip summary equals `retentionOver` over `[0, duration)`

Against the real artifact: `retentionOver` over the full panel clip reproduces
the measured table within ±2%.

## Risks

| Risk | Mitigation |
|---|---|
| Retention rewards "widest always", making every clip 16:9 | It is a *floor* to clear, and phase 30 picks the **narrowest** that clears it. Widest is never preferred, only permitted |
| Face boxes are a poor proxy for "important content" | True, and stated: this phase claims faces only. Action regions join in phase 11, text later. A partial metric beats today's absence of one |
| Threshold picked from one clip | It is picked to be far from that clip's numbers, and gate 1 checks the opposite end (solo clips) so both tails are exercised |
| `speakerRetention` absent when ASD fails | Absent, never defaulted to 1.0 — phase 31 must not read "unknown" as "safe" |
