# Phase 3 — Scene-cut + silence boundary snapping

**Goal:** clip boundaries land on real cut points and silences instead of
wherever the LLM guessed.

> **Status: built 2026-08-01.** Gates 1–4 pass on the corpus (0 mid-word, 100%
> snapped to a cut, 0 duration violations, 0 overlaps). **Gate 5 (speed) fails**
> — scene detection runs ~15× realtime, so a 25-minute source takes ~100s, not
> "well under a minute". See *What actually happened*.

## Why now

Cheap, CPU-only, and visible to a viewer. The LLM picks `start`/`end` from
transcript timestamps, so clips currently begin mid-word and end on a cut-off
syllable. `sanitizePlan` ([analyze.ts:120](../../server/pipeline/analyze.ts#L120))
clamps the range but never aligns it to anything real.

Scene cuts are also an input phase 7 needs (snap-on-cut) and phase 9 needs
(re-decide layout per scene), so computing them now means phase 7 doesn't have to.

## Scope

PySceneDetect + silence detection over the source, and a snapping function that
adjusts LLM-chosen windows.

## Out of scope

Using cuts to drive camera behaviour — phase 7. Face or speaker analysis — phase 4.

## Changes

### `worker/stages/scenes.py` (new)

```python
from scenedetect import detect, AdaptiveDetector
cuts = detect(video_path, AdaptiveDetector())
```

CPU-only, runs on the **whole source** (unlike phase 4, which runs only on
selected windows) because cut detection is cheap and clip selection needs it
before windows exist.

Silence from ffmpeg, not a second library:

```
ffmpeg -i source.mp4 -af silencedetect=noise=-30dB:d=0.35 -f null -
```

Parse `silence_start` / `silence_end` from stderr. `run()` in `download.ts`
already streams stderr line by line — reuse it.

### `server/pipeline/boundaries.ts` (new)

```ts
export function snapWindow(
  start: number, end: number,
  cuts: number[], silences: { start: number; end: number }[],
  words: Word[],
  maxShiftSec = 1.2
): { start: number; end: number; snappedTo: SnapReason }
```

Priority, best available wins:

1. **Scene cut** within `maxShiftSec` → snap to it. Hard cuts are the cleanest
   possible boundary.
2. **Silence midpoint** within `maxShiftSec` → snap there. Starting in a gap
   sounds deliberate.
3. **Word boundary** — snap to the nearest `word.start` (for `start`) or
   `word.end` (for `end`). This is the floor; it must always succeed, so a clip
   can never begin mid-word.

Constraints that must survive snapping, in this order:
- Duration stays within 20–58 s (the prompt's contract and Shorts' limit).
- Clips must not overlap — snap `start` and `end` independently, then resolve
  any collision by preferring the earlier clip's `end`.
- Never shift more than `maxShiftSec`; a boundary that can't be improved within
  that budget keeps the word-boundary snap.

`snapWindow` is **pure** — cuts, silences and words in, numbers out. That is what
makes it testable without ffmpeg.

### `server/pipeline/analyze.ts`

`sanitizePlan` gains a snapping pass after clamping. Order matters: clamp to the
video duration first, then snap, then re-verify the duration bounds — snapping
can push a 58 s clip over.

### `server/index.ts`

`scenes.json` is produced **before** `planClips`, and cut timestamps are included
in the planning prompt so the LLM can prefer windows that already align. Cheaper
than correcting it afterwards, and it improves selection rather than just fixing it.

## Contracts

`scenes.json`:

```jsonc
{
  "schemaVersion": 1,
  "cuts": [12.4, 30.1, 47.8],
  "silences": [{ "start": 11.9, "end": 12.3 }],
  "detector": "adaptive"
}
```

`clips.json` entries gain:

```jsonc
{ "start": 142.08, "end": 178.44, "snappedTo": "scene-cut", "shiftedBy": 0.31 }
```

`snappedTo` is `"scene-cut" | "silence" | "word" | "none"` — it makes a bad cut
debuggable instead of mysterious.

## Gate

Across a 10-clip sample from the corpus:

1. **No clip starts or ends mid-word.** Zero tolerance — this is the whole phase.
2. ≥60% snap to a scene cut or silence rather than falling through to word boundary.
3. No clip drifts outside 20–58 s.
4. No two clips from one job overlap.
5. Scene detection on a 25-minute source finishes in well under a minute (it's
   CPU-only and must not become the bottleneck).

## Tests

`boundaries.test.ts`, all pure, no ffmpeg:

- snaps to a scene cut when one is inside the budget
- prefers a scene cut over a nearer silence (priority order)
- falls through to word boundary when nothing is within `maxShiftSec`
- never shifts beyond `maxShiftSec`
- a snap that would push duration past 58 s is rejected, not applied
- two adjacent clips cannot be snapped into an overlap

## What actually happened

### The plan's priority order was wrong, and the gate caught it

The plan ranked candidates **scene cut > silence > word**, with word as "the
floor … so a clip can never begin mid-word". Those two rules contradict each
other, and real footage exposes it immediately: **a multi-camera podcast cuts
while someone is mid-sentence**, so the cut lands *inside a word*.

First gate run: **3 of 5 clips started or ended mid-word** — the exact defect the
phase exists to remove, caused by the snapping itself.

Fix: a candidate is only eligible if it does not fall strictly inside a word.
Cuts and silence midpoints are filtered by that test *before* ranking, so
priority still applies — but only among boundaries that are legal. The
duration-rejection fallback had the same flaw (it fell back to the raw LLM
value, which is precisely what is mid-word) and now falls back to a word edge.

After the fix, on the same corpus data:

| Gate | Result |
|---|---|
| Mid-word boundaries | **0** ✅ |
| Snapped to cut/silence | **5/5 = 100%** ✅ (target ≥60%) |
| Duration outside 20–58s | **0** ✅ |
| Overlapping clips | **0** ✅ |

### OpenCV cannot decode AV1, and PySceneDetect does not say so

The first real run reported **0 cuts on a 44-minute podcast**. Not a threshold
problem — YouTube served **AV1**, OpenCV decoded **zero frames**, and
PySceneDetect returned "0 scenes" without raising. Every threshold I tried
returned 0, which is what made it look like a tuning issue.

Measured on a 180s slice:

| Backend | Frames read | Cuts |
|---|---|---|
| `pyav` | 5393 | **18** |
| `opencv` | **0** | 0 |

Two fixes, because either alone leaves a hole:

1. `scenes.py` opens with **PyAV first**, falls back to OpenCV, and **asserts
   frames were actually decoded** — a backend that read nothing is an error, not
   an answer. The backend used is recorded in the artifact.
2. `download.ts` now prefers **H.264 (avc1)** explicitly, with AV1 as last
   resort. Phase 6's OpenCV render path would have hit this same wall.

Re-run: **254 cuts, 5.7/min** — plausible for multi-cam.

### Gate 5 (speed) fails, honestly

`frame_skip=2` was measured as a free win — **identical cut list**, timings
shifted ≤0.1s (far inside the 1.2s snap budget), wall time halved. Applied.

Even so: **179s for a 44-minute source**, roughly 15× realtime, so a 25-minute
source lands near 100s rather than "well under a minute".

A hypothesis worth recording as **wrong**: AV1 decode was assumed to be the
bottleneck. Re-encoding the same slice to H.264 made it *slower* (8.2× vs 15.5×
realtime) — dav1d is heavily multithreaded. The H.264 download preference is
justified by OpenCV compatibility, **not** speed.

For context, transcription of that same file takes 143s, so scene detection is
comparable to — not dominant over — the GPU stage. The real fix is decoding
downscaled frames through an ffmpeg pipe, which is exactly the machinery
**phase 6** builds; revisit it there rather than building it twice.

### Fails soft

Scene detection is wrapped so a failure costs boundary *quality*, never the
render (CLAUDE.md rule 5) — clips fall back to word-boundary snapping.

## Risks

| Risk | Mitigation |
|---|---|
| `AdaptiveDetector` over-triggers on fast-cut gaming footage | Cap cuts per minute; phase 11 re-tunes for screen-rec content specifically |
| Snapping breaks the non-overlap guarantee | Explicit collision resolution + a test |
| Silence threshold wrong for loud/compressed sources | `-30dB` is a starting value; tune against the corpus and record what worked |
| Scene detection on a 3-hour source is slow | It's CPU and parallel to nothing else; if it hurts, downscale the decode |
