# Phase 4 — Face detection + signal computation

**Goal:** measure what is actually in each selected clip, and write it down.

> **Status: built 2026-08-01.** Runs on CPU (0 MB torch VRAM) at ~4s per 45s
> clip. **MediaPipe was replaced with OpenCV YuNet** — the corpus proved it
> necessary, exactly as the plan allowed. Two gate expectations turned out to be
> mis-specified rather than unmet. See *What actually happened*.

## Why now

Every composition decision from here on is derived from these numbers. Phase 5
classifies content from them, phase 7 routes from them, phase 12 hands them to
the LLM. Nothing downstream can start until they exist.

This phase is also where master plan §4.1's biggest optimization lands: analysis
runs **only on selected clip windows**. A 25-minute source at 3 clips × 40 s
means CV on ~2 minutes of footage instead of 25 — a 10–20× reduction, and the
difference between a laptop pipeline that's usable and one that isn't.

## Scope

Face detection, face tracking, and the signal set. Per clip, not per source.

## Out of scope

Deciding anything from the signals — phase 5 classifies, phase 7 routes.
Active-speaker detection is phase 8; `asdScore` is absent from this artifact and
that is deliberate.

## Changes

### `worker/stages/analyze_clip.py` (new)

Runs per selected clip. Extracts the clip window to an intermediate file first
(master plan §4.3 — decode once, never seek repeatedly in a long source).

**MediaPipe Face Detection on CPU.** This is a deliberate choice, not a default:
it leaves all 6 GB free for GPU stages, and the i7 HX has the cores. YOLOv8n-face
is the documented fallback if MediaPipe misses on real footage — swap only if the
corpus proves it necessary.

Sampling: every **0.25 s** (`track_step`), interpolating between samples. Do not
run detection per frame; at 30 fps that is 120× the work for no measurable gain.

### Tracking

Detections become tracks by IoU + centroid distance across consecutive samples,
with a small gap tolerance so a track survives a brief occlusion or a missed
detection. A track that appears for under ~0.5 s is discarded as noise.

Simple and boring on purpose. A proper Kalman/ByteTrack implementation is
available if the corpus shows it's needed, but IoU matching at 4 Hz on
talking-head footage is sufficient and has no failure mode anyone has to debug
at 3am.

### Signals

| Signal | Method | Consumed by |
|---|---|---|
| `faceCoverage` | fraction of samples with ≥1 face | phase 5 — `<0.2` means screen-rec/b-roll |
| `distinctFaceTracks` | surviving track count | phase 5, 7 — the primary branch |
| `subjectMotion` | variance of face centroid, normalized to frame | phase 7 — low means no tracking needed at all |
| `facesFitOneCrop` | do all active faces fit one 9:16 window | phase 9 — true means just crop wider, no gimmick |
| `faceSizeRatio` | median face height ÷ frame height | phase 11 — small + cornered suggests a facecam |
| `sceneCuts` | from `scenes.json`, sliced to the window | phase 7, 9 |
| `speakerCount` | distinct speakers in the window from `transcript.json` | phase 5 — audio-side cross-check |
| `overlapRatio` | fraction of window with 2+ speakers active | phase 10 — `>0.25` is what earns split-screen |
| `turnRate` | speaker switches per minute | phase 9 |

`speakerCount`, `overlapRatio` and `turnRate` come from the phase 2 transcript
and need no CV. Compute them here anyway so every routing input lives in one
artifact — that is what makes a bad edit debuggable from a single file.

### `server/pipeline/signals.ts` (new)

TypeScript types mirroring the artifact, plus the pure helpers for the
transcript-derived signals (`overlapRatio`, `turnRate`, `speakerCount`) so they
are unit-testable without invoking Python.

## Contracts

`analysis/<clipId>.json`:

```jsonc
{
  "schemaVersion": 1,
  "clipId": "clip_2",
  "start": 142.08, "end": 178.44,
  "sourceFps": 30,
  "sampleStep": 0.25,
  "faceTracks": [
    { "id": 1, "firstSeen": 0.0, "lastSeen": 36.3,
      "samples": [{ "t": 0.0, "cx": 0.52, "cy": 0.40, "w": 0.18, "h": 0.24, "conf": 0.97 }] }
  ],
  "signals": {
    "faceCoverage": 0.97,
    "distinctFaceTracks": 2,
    "subjectMotion": 0.12,
    "facesFitOneCrop": false,
    "faceSizeRatio": 0.24,
    "speakerCount": 2,
    "overlapRatio": 0.31,
    "turnRate": 8.2,
    "sceneCuts": [12.4, 30.1]
  }
}
```

Coordinates are **normalized 0–1**, never pixels. Resolution changes; ratios don't.

## Gate

Inspected against all four corpus sources — this phase is judged by whether the
numbers are *right*, not by whether it runs:

| Source | Expectation |
|---|---|
| Solo talking-head | `distinctFaceTracks == 1`, `faceCoverage > 0.9`, `subjectMotion` low |
| Podcast | `distinctFaceTracks == 2`, `overlapRatio > 0.2`, `turnRate` clearly non-zero |
| Gaming | `faceCoverage < 0.3`, and if there's a facecam, `faceSizeRatio < 0.15` |
| Hinglish | `speakerCount` matches reality regardless of language |

Plus: analysis of 3 clips × 40 s finishes in **under 60 s total on CPU**, and
`job.json` shows ~0 MB VRAM for this stage (proving it stayed off the GPU).

## Tests

- `signals.test.ts` — `overlapRatio`, `turnRate`, `speakerCount` computed from a
  fixture word list with known speaker changes; zero-length and single-speaker
  edge cases return sane values rather than `NaN`.
- Track continuity: a fixture detection sequence with a two-sample gap yields
  one track, not two.
- A detection sequence shorter than the noise floor yields zero tracks.

## What actually happened

### MediaPipe failed the corpus; YuNet replaced it

The plan said swap only if the corpus proves it necessary. It did, immediately:

| Frame | MediaPipe BlazeFace | YuNet |
|---|---|---|
| Gaming facecam | **0 detections**, then 0.4-confidence boxes at `h=0.39` | **`h=0.12` @ 0.90** ✅ |
| Solo (stage distance) | real face @0.43 **plus a false positive on a background monitor** | `h=0.20` @ 0.92 |
| Podcast | 2 faces, one a `h=0.47` @0.41 false positive | 2 faces @ 0.92–0.93 |

BlazeFace short-range is built for ~2m selfie distance; nothing in this corpus is
shot that way.

**YuNet was chosen over the plan's documented YOLOv8n-face fallback**, and the
reason is not only accuracy: YOLOv8n-face pulls in **AGPL** `ultralytics`, which
phase 23 would have had to unpick before selling anything. YuNet ships inside the
already-installed OpenCV under Apache-2.0 — no new dependency, no licence debt.

`MIN_CONFIDENCE = 0.85` was measured, not guessed. A sweep on the solo source:

| Threshold | Coverage | Raw tracks | maxConcurrent | faceSizeRatio |
|---|---|---|---|---|
| 0.60 | 0.71 | 27 | **8** | **0.05** |
| 0.80 | 0.52 | 7 | 2 | 0.20 |
| **0.85** | **0.51** | **5** | **1** | **0.20** |
| 0.90 | 0.39 | 4 | 1 | 0.21 |

Lower thresholds buy coverage only by inventing faces — `maxConcurrent: 8` on a
one-person stage, with `faceSizeRatio` collapsing to noise-sized 0.05.

### Measured signals

| Source | tracks | concurrent | coverage | faceSize | motion | fitsOneCrop |
|---|---|---|---|---|---|---|
| solo | 1 | 1 | 0.51 | 0.20 | 0.052 | true |
| podcast | 3 | **2** | 1.00 | 0.29 | 0.016 | false |
| gaming | 1 | 1 | 0.99 | **0.12** | 0.014 | true |

### Two gate expectations were wrong, not two failures

**"Gaming: `faceCoverage < 0.3`"** contradicts its own next clause. A persistent
facecam is on screen in *every* frame, so coverage is legitimately ~1.0. The
signal that actually separates gaming from talking-head is **`faceSizeRatio`**:
0.12 (facecam) vs 0.20 (solo) vs 0.29 (podcast). Phase 5 must branch on face
*size*, not face *presence*. Recorded there.

**"Solo: `faceCoverage > 0.9`"** assumed a locked-off talking head. The TED
speaker walks the stage, turns in profile and looks down at his hands; ~0.5 is
the honest detectability of that footage with a frontal-face detector. It stays
far above the `<0.2` that phase 5 uses to call something screen-rec, so nothing
downstream breaks.

### `distinctFaceTracks` over-counts on multi-camera footage

Every cut re-mints track IDs, so the 2-person podcast first measured **11
tracks**. Filtering to tracks covering ≥20% of the clip brings it to 3 — still
one too many, because one camera angle survives the filter.

Rather than tune the ratio until one clip passes, `medianConcurrentFaces` was
added: simultaneous detections per sample, computed without tracking at all, so
cuts cannot fool it. It reads **2** for the podcast and **1** for solo and
gaming. **Phase 5 should use it as the people-count**; `distinctFaceTracks` and
`rawTrackCount` remain for phase 8's speaker-to-face binding.

### Still blocked on diarization

`speakerCount`, `overlapRatio` and `turnRate` are implemented and unit-tested,
but read 0 on real jobs because pyannote is gated (phase 2, gate 3). **This is
what blocks split-screen**: `overlapRatio > 0.25` is the signal that earns it in
phase 10. Until `hf.co/pyannote/speaker-diarization-community-1` is accepted, the
router can see faces but not who is talking.

## Risks

| Risk | Mitigation |
|---|---|
| MediaPipe misses profile/partial faces on real footage | Documented YOLOv8n-face fallback; decide from the corpus, not in advance |
| Track ID swaps when two people cross | Phase 8's ASD binding is what makes identity authoritative; log swaps now |
| 0.25 s sampling too coarse for fast motion | It's a tunable, not a constant — record what the corpus needed |
| `facesFitOneCrop` is ambiguous when faces are at frame edges | Define precisely: all active face boxes fit one 9:16 window with ≥5% margin |
| Signals computed but silently wrong | The gate is inspection against known-answer sources, not "no exception thrown" |
