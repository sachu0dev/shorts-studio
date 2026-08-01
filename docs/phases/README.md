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
| 7 | **Canvas ≠ window.** The published canvas is always 1080×1920; the *framing window* into the source is 9:16 → 16:9 and changes **per segment within a clip** | Phases 29–31 exist. One clip can open 9:16 on a close-up, widen to 4:3 when the panel enters, and return — the remainder of the tall canvas is filled with blur (default) or black. A wide shot is never shipped as a landscape file: that is not a Short. |

## Priority

| Block | What | Phases |
|---|---|---|
| **A — CORE** | Paste a YouTube URL in the web UI → a Short good enough to publish | 0–13, **29–31** |
| **B — UPLOAD** | That Short reaches your channel | 14–15 |
| **C — LATER** | Local models, Content Hunt, scripts, SaaS | 16–23 |
| **D — SELF-IMPROVING** | Record everything, judge it, publish to the right channel, learn from the result | 24–28 |

**29–31 are core, and they block Blocks B and C.** Framing correctness is part of
"good enough to publish", not a refinement after it. Uploading (14–15) or
harvesting more sources (19–20) before the framing is right means publishing
clips with half the cast cropped out and then discovering it at scale — the
upload adapter has no opinion about whether a clip is well framed, and Content
Hunt's whole value is finding more footage to run through this same pipeline.
**Nothing in B or C starts until 29–31 pass their gates.**

Input is **manual for all of Block A and B** — you paste the URL at
`localhost:5177`. That already works and is not touched.

## Build order ≠ phase number

**Phase numbers are stable file IDs, not a schedule.** Renumbering would break
every cross-reference in 32 documents to express something a single list says
better. **This list is that single source of truth — read it first, build the
topmost unbuilt row, and do not infer the order from the numbers.**

### Execution queue

| # | Phase | Why it sits here |
|---|---|---|
| ✅ | 0–10 | built — artifact store → split-screen renderer |
| ✅ | [29 — Content retention signal](phase-29-content-retention.md) | **built** — gates 2/4/5 pass; gate 1 passes on the one clean local solo clip; gate 3 unconfirmed (only stale pre-phase-9 ASD data available) |
| ✅ | [30 — Adaptive framing window](phase-30-adaptive-framing.md) | **built** — gates 1/2/4/5/6/8/9 pass (gate 8 measured, 1.21×); gate 3's mechanism verified but no real clip has an internal cut; gate 7 deferred to phase 13 |
| **1** | **[31 — Panel framing & speaker priority](phase-31-panel-framing.md)** | **← START HERE.** Fixes the live centre-crop defect. Needs 30's wide window |
| 2 | [11 — Gaming composition](phase-11-gaming.md) | Resumes the original Block A. Cheaper after 30 delivers `blurred-fill` |
| 3 | [12 — LLM taste layer](phase-12-llm-taste.md) | Per-segment taste, on top of a framing layer that is finally correct |
| 4 | [13 — Caption polish + thumbnail](phase-13-caption-polish.md) | Last of Block A |
| 5 | [24 — Source catalog + telemetry](phase-24-source-catalog.md) | Pulled forward from Block D |
| 6 | [28 — Operations dashboard](phase-28-dashboard.md) | Pulled forward from Block D |
| 7 | [14](phase-14-rights-posture.md) → [15](phase-15-youtube-upload.md) | Block B — upload. **Blocked until 29–31 pass** |
| 8 | 16 … 23 | Block C — local models, Content Hunt, scripts. **Blocked until 29–31 pass** |
| 9 | 25 → 26 → 27 | Block D remainder — quality gate → multi-channel → performance loop |

Two rules that outrank the table: **finish the phase you are on before starting
the next** (a half-built phase is worse than an unstarted one), and **update the
status table below when a gate passes**, so the next session starts from fact
rather than from this paragraph.

**Why 29–31 jump the queue.** They fix a reproduced defect in live output, not a
missing feature. On corpus job `vI57GWdQo5` clip 2 — an eight-person talent-show
panel — the pipeline renders `static-center`: a fixed dead-centre crop that
frames whoever sits in the middle and ignores who is speaking. Measured, a 9:16
window on that clip **retains 42.4% of the face-appearances and discards the
rest**; 16:9 retains 98.5%.

Two faults compound: the low-confidence fallback is geometric (`static-center`)
where it should be content-preserving, and the window aspect is hardcoded to the
canvas aspect so "keep all eight people" is not expressible at all. Everything
after this point renders through the same framing code, so fixing it later means
re-cutting whatever shipped in between.

They also make phase 11 cheaper: its largest inherited item is that
`blurred-fill` is *routed but not built* and needs "`render.py` to decode
full-width and skip the crop". A full-width window with a filled remainder is
exactly that, and arrives in phase 30 as a special case of the general mechanism.

Why 24 and 28 moved:

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

0. **Read the execution queue above and take the topmost unbuilt row.** Never
   pick the next phase by number.
1. Build the phase. Nothing outside its scope.
2. Run its gate. If it fails, refine — do not start the next phase.
3. Update **both** the execution queue and the status table below, then commit.
   A gate that passed but was not recorded costs the next session a re-derivation.

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
| [29](phase-29-content-retention.md) | Content retention signal | A | **built** — gates 2/4/5 pass; gate 1 on one clean clip; gate 3 unconfirmed (stale ASD data) |
| [30](phase-30-adaptive-framing.md) | Adaptive framing window, per segment | A | **built** — mid-clip 9:16 ⇄ 4:3 ⇄ 16:9 verified; render time 1.21× phase 10 |
| [31](phase-31-panel-framing.md) | Panel framing & speaker priority | A | **next** — fixes the reproduced centre-crop defect |
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

Framing correctness (29–31) precedes framing *features* (11–13): every later
phase renders through the same window code, so a clip that ships with half its
cast cropped out has to be re-cut once the window is fixed.

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
