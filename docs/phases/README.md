# Phase plan — one feature per phase

Executable slicing of `shorts-studio-master-plan.md` and
`content-hunt-and-local-agents.md`. **Each phase adds exactly one feature** and
ends at a gate you can check.

## Locked decisions

These were decided up front and every phase file assumes them:

| # | Decision | Consequence |
|---|---|---|
| 1 | **Composition is auto-detected**, not user-picked | All four content types must work. Adds phase 5 (classifier) and phase 11 (gaming). |
| 2 | **Gaming gets full support** — facecam PiP + action-region tracking | Phase 11 exists. Not in the original master plan. |
| 3 | **India / Hinglish in romanized Latin script** | **No Devanagari work.** Anton + the Google Fonts picker work unchanged. WhisperX transcribes Hindi and romanizes. |
| 4 | `compositionType` is **measured**, `contentMode` is **LLM-chosen** | Two fields, one owner each. The LLM can never select a layout that's physically impossible. |
| 5 | **Router frames, effects decorate** — the templates survive as a styling layer | Phase 6 ported 11 of 12 to OpenCV and dropped `speed-ramp`; phase 12 drives them per-segment. |
| 6 | **Rights posture is per-job**, mix of owned and third-party | Phase 14 exists as its own feature before upload. |

## Priority

| Block | What | Phases |
|---|---|---|
| **A — CORE** | Paste a YouTube URL in the web UI → a Short good enough to publish | 0–13 |
| **B — UPLOAD** | That Short reaches your channel | 14–15 |
| **C — LATER** | Local models, Content Hunt, scripts, SaaS | 16–23 |
| **D — SELF-IMPROVING** | Record everything, judge it, publish to the right channel, learn from the result | 24–28 |

Input is **manual for all of Block A and B** — you paste the URL at
`localhost:5177`. That already works and is not touched.

## Build order ≠ phase number

**Phase numbers are stable file IDs, not a schedule.** Renumbering would break
every cross-reference in 29 documents to express something a single list says
better.

Block A runs in order. Two of Block D's phases are pulled forward to sit **early
in Block A** rather than after Block C:

```
   6 … 13   Block A continues            ← 6-9 built
→  24  Source catalog + telemetry store  the DB everything else records into
→  28  Operations dashboard              the surface that makes the later gates answerable
   14 … 23  as planned
   25 … 27  quality gate → multi-channel → performance loop
```

Why they moved:

- **24 pays for itself today.** Re-clipping a source currently re-downloads it.
  It also has no dependencies beyond SQLite.
- **28 makes the remaining Block A gates answerable.** Phases 7–13 each ask *did
  this get better?* Answering that from `job.json` and scrollback is how a wrong
  number sits unnoticed for a month — which already happened once, in phase 4,
  and phase 6's gate 4 is the second time a number needed measuring before it
  could be believed.
- **Nothing already built needs editing.** `runStage` has emitted `onTiming`
  since phase 1 and it is already wired at
  [index.ts:134](../../server/index.ts#L134), so every existing stage becomes
  monitorable the day 24 lands. That is rule 7 paying out.

25–27 stay after Block B, because a quality gate needs clips to judge and a
performance loop needs published clips to learn from.

## How this is run

1. Build the phase. Nothing outside its scope.
2. Run its gate. If it fails, refine — do not start the next phase.
3. Update the status table below.

Every phase file has the same shape: **Goal · Why now · Scope · Out of scope ·
Changes · Contracts · Gate · Tests · Risks**.

Depth is honest, not uniform. Block A files are near-term and concrete. Block C
files are real plans but will need revising when reached — anything that depends
on Block A's measured behaviour is marked `[revisit]`.

## Status

| # | Feature | Block | State |
|---|---|---|---|
| [0](phase-00-setup.md) | Environment & toolchain setup | A | **built** — gate 1 ok, gate 2 partial |
| [1](phase-01-artifact-store.md) | Artifact store + stage runner | A | **built** — all gates pass |
| [2](phase-02-whisperx.md) | WhisperX transcription | A | **built** — gate 3 needs HF repo access |
| [3](phase-03-boundary-snapping.md) | Scene-cut + silence boundary snapping | A | **built** — gate 5 (speed) missed |
| [4](phase-04-face-signals.md) | Face detection + signal computation | A | **built** — YuNet; overlap blocked on HF |
| [5](phase-05-content-classifier.md) | Content-type classifier | A | **built** — all gates pass; phase 8 lifted the HF confidence ceiling |
| [6](phase-06-opencv-render.md) | OpenCV → NVENC render path | A | **built** — gate 4 (speed) rewritten; `speed-ramp` dropped |
| [7](phase-07-router.md) | Composition router + fullscreen-follow | A | **built** — all gates pass; `MOTION_T` + deadzone recalibrated |
| [24](phase-24-source-catalog.md) | Source catalog + telemetry store | D | planned |
| [28](phase-28-dashboard.md) | Operations dashboard | D | planned |
| [8](phase-08-light-asd.md) | Light-ASD active speaker detection | A | **built** — gates 1/4 need diarization; ASD unblocks routing |
| [9](phase-09-camera-switch.md) | camera-switch + group-crop | A | **built** — gate 4 restated; group-crop unexercised on real footage |
| [10](phase-10-split-screen.md) | Split-screen renderer | A | **built** — gates 1/6 unexercised, no corpus footage with confirmed crosstalk |
| [11](phase-11-gaming.md) | Gaming composition (facecam + action) | A | planned |
| [12](phase-12-llm-taste.md) | LLM taste layer (per-segment) | A | planned |
| [13](phase-13-caption-polish.md) | Caption polish + best-frame thumbnail | A | planned |
| [14](phase-14-rights-posture.md) | Rights posture tagging | B | planned |
| [15](phase-15-youtube-upload.md) | YouTube OAuth + upload | B | planned |
| [16](phase-16-local-provider.md) | Local model provider (Ollama) | C | planned |
| [17](phase-17-embeddings.md) | T0 embeddings service (CPU) | C | planned |
| [18](phase-18-quota-ledger.md) | YouTube API quota ledger | C | planned |
| [19](phase-19-content-hunt-harvest.md) | Content Hunt: seeds, harvest, screen | C | planned |
| [20](phase-20-content-hunt-scoring.md) | Content Hunt: semantic, scoring, queue | C | planned |
| [21](phase-21-creator-memory.md) | Creator Memory | C | planned |
| [22](phase-22-script-system.md) | Script system | C | planned |
| [23](phase-23-productization.md) | Productization | C | planned |
| [25](phase-25-clip-quality-gate.md) | Clip quality gate (reject → archive) | D | planned |
| [26](phase-26-multi-channel.md) | Multi-channel routing + publishing | D | planned |
| [27](phase-27-performance-loop.md) | Performance ingest + calibration | D | planned |

## Ordering logic

Editing quality is the critical path, so it is all of Block A. Within it,
phases 1–3 are the highest value per line in the entire plan: phase 1 stops you
re-running 8 minutes of transcription after a render crash, phase 2 fixes the
caption desync visible in today's output, phase 3 fixes mid-sentence cuts. All
three are cheap and all three are visible to a viewer.

Upload follows because it's the shortest path from "good clip" to "published
Short" and needs nothing new. Content Hunt is last because discovering great
opportunities and then editing them badly is worse than not discovering them.

Block D closes the loop that Blocks A–C leave open. A–C can produce a clip and
publish it; nothing in them can tell you whether the clip was worth publishing,
and nothing records what happened after. The order inside D follows the
dependency chain exactly: you cannot judge clips without somewhere to record the
verdict (24), cannot route to a channel what you haven't judged (25 → 26), and
cannot calibrate a judge without published outcomes to calibrate against
(26 → 27).

One warning that belongs here rather than buried in phase 26: **several channels
of templated automated output is the exact pattern YouTube's inauthentic-content
policy describes.** Clipping long-form is fine and stays fine — mass-producing
near-identical output across channels is not. Block D's value depends on the
channels being genuinely different, which is a content decision no amount of
code makes for you.

## Test corpus (set this up during phase 0)

Every gate from phase 4 onward is checked against the same four sources. Pick
them once, record them in [test-corpus.md](test-corpus.md), never change them:

1. **Solo talking-head** — one person, low motion
2. **Podcast** — two people, visible crosstalk
3. **Gaming** — gameplay with a facecam
4. **Hinglish** — heavy English/Hindi code-switching

Without fixed sources, "did this get better?" is unanswerable.
