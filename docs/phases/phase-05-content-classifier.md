# Phase 5 — Content-type classifier

**Goal:** the system decides what kind of content a clip is, from measured
signals, without asking anyone.

> **Status: built 2026-08-01.** All six gate rows pass, three of them against
> the real phase-4 corpus artifacts rather than fixtures. **The rule table in
> this document as originally written failed its own gate** on measured data —
> two rules had to change. See *What actually happened*.

## Carried over from phase 4 — measured corrections

Two things phase 4 proved on the corpus, which change how this classifier must
be written:

1. **Branch on face SIZE, not face presence.** A gaming clip with a persistent
   facecam has `faceCoverage` ~1.0, identical to a talking head. The separating
   signal is `faceSizeRatio`: **0.12 gaming facecam / 0.20 solo / 0.29 podcast**.
   The `faceCoverage < 0.2` rule still works for *narration-free* b-roll and
   screen-rec, but it cannot detect gaming on its own.
2. **Use `medianConcurrentFaces` as the people-count, not `distinctFaceTracks`.**
   Multi-camera footage re-mints track IDs at every cut — the 2-person podcast
   measures 3 filtered tracks (11 unfiltered) but `medianConcurrentFaces` reads a
   correct **2**.

Measured baselines to classify against:

| Source | concurrent | coverage | faceSize | motion |
|---|---|---|---|---|
| solo | 1 | 0.51 | 0.20 | 0.052 |
| podcast | 2 | 1.00 | 0.29 | 0.016 |
| gaming (facecam) | 1 | 0.99 | 0.12 | 0.014 |

Note solo's coverage of 0.51: a moving stage speaker is *not* reliably detected,
so any rule assuming coverage >0.9 for talking-head would misfire.

## Why now

This phase exists because of **decision 1**: composition is auto-detected, not
user-picked. Everything downstream branches on the answer — phase 7 routes
talking-head, phase 9 routes multi-speaker, phase 11 routes screen-rec. Deciding
the taxonomy after three consumers exist means changing all three.

It is deliberately its own phase and not folded into the router. Classification
("what is this?") and routing ("what may we do about it?") fail differently and
should be debuggable separately.

## Decision 4 — this is measured, never LLM-chosen

Two fields, one owner each. They are **not** merged:

| Field | Values | Owner | Drives |
|---|---|---|---|
| `compositionType` | `talking-head` `multi-speaker` `screen-rec` `b-roll` | **deterministic, from signals** | framing, camera, layout |
| `contentMode` | `funny` `gaming` `political` | **LLM, from transcript** | caption palette, font, tone |

Keeping them apart is `CLAUDE.md` rule 3. The LLM must not be able to declare a
clip `multi-speaker` when phase 4 measured one face — that is a factual
impossibility, not a creative choice. Conversely, whether a clip is *funny* is
not something you can measure from face boxes.

They will often disagree in harmless ways — a gaming clip with a big facecam is
`compositionType: talking-head` and `contentMode: gaming`. That is correct, and
it's exactly why one field can't do both jobs.

## Scope

One pure function plus the artifact field. No behaviour change yet — nothing
consumes `compositionType` until phase 7.

## Out of scope

Acting on the classification. Phase 7 is the first consumer.

## Changes

### `server/pipeline/classify.ts` (new)

```ts
export type CompositionType = "talking-head" | "multi-speaker" | "screen-rec" | "b-roll";

export function classify(sig: Signals): {
  type: CompositionType;
  confidence: number;
  reason: string;
}
```

Rules, first match wins:

```
faceCoverage < 0.2  and  speakerCount >= 1   → screen-rec   // gameplay, screen capture with narration
faceCoverage < 0.2  and  speakerCount == 0   → b-roll       // music, montage, no narration
distinctFaceTracks >= 2  and  speakerCount >= 2 → multi-speaker
distinctFaceTracks >= 2  and  speakerCount == 1 → talking-head  // one speaker, bystanders in frame
otherwise                                    → talking-head
```

Two details that matter more than the thresholds:

**`screen-rec` vs `b-roll` splits on narration, not on faces.** Gameplay with a
commentator needs caption-led composition and facecam handling (phase 11); a
silent montage needs neither. `faceCoverage` alone cannot tell them apart.

**Two faces but one speaker is `talking-head`, not `multi-speaker`.** A person
being interviewed with a silent listener in frame should not get camera-switching.
The audio-side cross-check is what prevents that, and it's why phase 4 computes
`speakerCount` even though it needs no CV.

### Confidence and the boundary band

`faceCoverage` near 0.2 is genuinely ambiguous — a gaming clip with a large
facecam sits right on it. Return `confidence` low in the 0.15–0.30 band, and
have phase 7 prefer conservative layouts (`static-center`, `blurred-fill`) when
confidence is low. A safe generic edit beats a confident wrong one.

`reason` is a human-readable string (`"faceCoverage 0.11 < 0.2, 1 speaker"`)
written into the artifact. When a clip is framed wrong, this is the first thing
you read.

### Thresholds live in one place

```ts
export const CLASSIFY_THRESHOLDS = { faceCoverage: 0.2, ambiguousBand: [0.15, 0.30] };
```

Exported and tunable. They are starting values from the master plan, not
measurements — expect to move them once the corpus says so, and record what changed.

### `server/pipeline/analyze.ts`

`ClipPlan` gains `compositionType`, written by `classify()` **after** the LLM
returns. `sanitizePlan` must not accept a `compositionType` from the model —
if the LLM emits one, discard it silently. The prompt is not told the field exists.

## Contracts

`analysis/<clipId>.json` gains:

```jsonc
{
  "classification": {
    "type": "multi-speaker",
    "confidence": 0.91,
    "reason": "2 face tracks, 2 speakers, faceCoverage 0.97"
  }
}
```

## Gate

All four corpus sources classify correctly, plus the deliberately hard cases:

| Source | Expected |
|---|---|
| Solo talking-head | `talking-head` |
| Podcast | `multi-speaker` |
| Gaming with facecam | `screen-rec` (**not** `talking-head` — the facecam must not fool it) |
| Gaming without facecam | `screen-rec` |
| Silent montage / music | `b-roll` |
| Interview, one speaker + silent listener | `talking-head`, **not** `multi-speaker` |

Misclassification of the last two is the failure mode worth caring about; both
produce a visibly wrong edit downstream.

## Tests

`classify.test.ts` — pure, table-driven, one case per row above plus:

- exactly on the 0.2 boundary → deterministic, documented side
- ambiguous band returns `confidence < 0.6`
- `distinctFaceTracks: 0` never throws
- `reason` is non-empty for every branch

## What actually happened

### The specified rule table failed its own gate

Written literally, the rules in *Changes* misclassify two of the three measured
corpus sources:

| Source | Specified rules give | Gate wants |
|---|---|---|
| Gaming w/ facecam | `talking-head` — coverage 0.99 never reaches the `< 0.2` branch | `screen-rec` |
| Podcast | `talking-head` — `speakerCount` is 0, so `>= 2` never fires | `multi-speaker` |

The phase-4 carry-over notes at the top of this file predicted the first one
exactly. Two rules were added ahead of the people-count branch:

```
faceCoverage  < 0.2                          → wordCount > 0 ? screen-rec : b-roll
faceSizeRatio < 0.15 and people <= 1         → screen-rec     // facecam over screen content
people >= 2 and speakers >= 2                → multi-speaker
people >= 2 and speakers == 1                → talking-head   // listener in frame
people >= 2 and speakers == 0                → multi-speaker, confidence 0.55
otherwise                                    → talking-head
```

`people` is `medianConcurrentFaces`, per the phase-4 correction.

### `speakerCount == 0` means "unknown", not "nobody spoke"

The specified table reads a zero speaker count as fact. On this machine it is an
artifact of pyannote being gated — it reads 0 on **every** clip, so a literal
reading classifies every podcast as a talking head and split-screen could never
fire.

Zero labelled speakers while faces are on screen is not a measurement, it is a
missing measurement. The classifier now falls back to CV, returns **0.55
confidence**, and says `no speaker labels available` in `reason`. When the HF
repo is accepted, the same clip promotes itself to 0.9 with no code change, and
the interview-with-a-silent-listener case starts being demoted correctly.

### Narration is `wordCount`, not `speakerCount`

`screen-rec` vs `b-roll` splits on whether anyone is talking. Using
`speakerCount` for that would have made every clip `b-roll` today, for the same
reason. `signals.wordCount` was added in `transcriptSignals` — one line, and it
holds whether or not diarization runs.

### Measured gate results

Run against the actual phase-4 artifacts in `storage-p2/`:

| Artifact | Type | Confidence | Reason |
|---|---|---|---|
| solo | `talking-head` | 0.9 | 1 face, faceCoverage 0.5062, faceSizeRatio 0.2022 |
| podcast | `multi-speaker` | **0.55** | 2 concurrent faces, no speaker labels available |
| gaming | `screen-rec` | 0.8 | faceSizeRatio 0.1236 < 0.15 with 1 face |

The remaining three gate rows (gaming without facecam, silent montage,
interview with silent listener) have no corpus source and are covered by
`classify.test.ts` instead.

### `sanitizePlan` needed no change

The plan asked for `compositionType` to be discarded if the LLM emits one.
`sanitizePlan` builds its return object field by field rather than spreading, so
an unknown key from the model is already dropped structurally. Nothing to add —
the property is set on the plan after analysis, in `index.ts`.

## Carried into phase 7

- **Route on `confidence < 0.6`, not just on `type`.** Today that band means
  "diarization is gated", and it covers every multi-speaker clip. Phase 7 should
  prefer `static-center` / `blurred-fill` there, exactly as this file specifies.
- **`facecamFaceSize` (0.15) is the weakest threshold in the file.** It sits in
  a real measured gap (0.12 vs 0.20) but on one gaming source. Phase 11 does
  real facecam detection — position and stability, not size alone — and should
  take this branch over.

## Risks

| Risk | Mitigation |
|---|---|
| Gaming clip with a fullscreen facecam classifies as `talking-head` | `faceSizeRatio` + position from phase 4 is the tiebreak; phase 11 re-tunes this with real facecam detection |
| Thresholds tuned to one source and wrong elsewhere | Gate is four different sources; thresholds exported and versioned |
| Classification silently wrong, no one notices | `reason` in the artifact; phase 7 logs the type it routed on |
| A fifth content type appears later (e.g. slideshow) | Adding a branch is cheap because nothing consumes the enum until phase 7 |
