# Shorts Studio — Final Master Build Plan

**Base codebase:** `shorts-studio` (Node/TS: yt-dlp → whisper/VTT → Anthropic clip planning → ffmpeg render + ASS captions)
**Phase 1 target rig:** Acer Predator Helios Neo 16 — i7 13th-gen HX, RTX 4050 laptop (6GB VRAM), local single-user
**End goal:** paste a YouTube link → fully auto-edited Short → auto-uploaded to the channel, with editing quality that stands next to a human editor. Architecture must scale to multi-tenant SaaS later without a rewrite.

---

# PART 1 — MARKET RESEARCH

## 1.1 The competitive landscape (as of mid-2026)

The market has segmented into three distinct jobs, and knowing which one you're competing in matters more than feature count:

| Tool | Core job | Approx. pricing | Notable strength | Notable weakness |
|---|---|---|---|---|
| **OpusClip** | Find viral moments in long recordings | ~$15/mo Starter, ~$29/mo Pro | Best-regarded hook/moment detection; virality scoring; "ClipAnything" prompt-based semantic search of footage | Credit metering is the #1 complaint driving churn |
| **Vizard** | High-volume transcript-first clipping | ~$16–30/mo | Clean UI, accurate reframing, 4K exports, native scheduling, API access at non-enterprise price | Shallower moment detection than Opus; bills by upload length |
| **Submagic** | Make an *already-cut* clip look incredible | ~$19–20/mo, API on ~$69/mo tier | Best-in-class animated captions and visual polish | Does **not** find moments — you bring the clip |
| **Choppity** | Clip → post → analytics loop | ~$20/mo | Face-tracking + caption customization; only tool combining posting, scheduling and per-post analytics with generation | Smaller brand |
| **Reap** | Multilingual + AI dubbing | — | Face tracking on by default; dubbing | — |
| **CapCut** | Free manual editor | Free | No cost | Zero AI moment detection — fully manual |

### The three findings that should shape your product

**Finding 1 — Credit metering is the market's open wound.**
Across multiple independent comparisons, the dominant reason creators switch tools is not clip quality — it's that credits run out mid-month and cost scales linearly with source length (commonly 1 credit = 1 minute of source video). A 60-minute podcast burns 60 credits. This is the clearest wedge available.

**Finding 2 — Multi-speaker footage is where the incumbents visibly break.**
Reviewers consistently note that clip quality "holds up for straightforward talking-head and podcast content," but the honest limit shows on **complex multi-speaker footage**, where users still drop into a separate editor to finish. Your adaptive composition router (Part 3) targets exactly this gap.

**Finding 3 — Nobody has fully merged "find the moment" and "make it look incredible."**
OpusClip finds moments but creators add Submagic on top for captions. Submagic polishes but can't find moments. The workflow most creators actually run is *two paid subscriptions stapled together*. A single tool that does both well is a real position.

### Your differentiated position

> **Content-aware composition + word-perfect captions in one pass, with a pricing model that doesn't punish long-form.**

Because you're running inference yourself (not reselling an API), you can price on *output clips* rather than *source minutes* — directly attacking Finding 1. A 3-hour podcast producing 5 Shorts costs you ~5 renders, not 180 credits.

## 1.2 Technical state of the art — what to actually build with

| Layer | Winner | Why it beats the alternatives |
|---|---|---|
| **Transcription + word timing** | **WhisperX** | Runs faster-whisper (CTranslate2) for transcription, then adds VAD chunking, **wav2vec2 forced alignment** for true word-level timestamps, and pyannote diarization + word-to-speaker assignment — in one pipeline. This collapses three of your stages into one call. |
| **Diarization ("who spoke when")** | **pyannote 3.1** (bundled in WhisperX) | Industry standard, free weights, HF-gated token. |
| **Active speaker detection ("which face is speaking")** | **Light-ASD / LR-ASD** | CVPR 2023, explicitly designed as a *lightweight* ASD model, reports mAP ~94% on AVA validation — higher than TalkNet's ~90.8% while being far cheaper to run. This is the single biggest quality unlock and the piece the open-source clippers you looked at do **not** have. |
| **Face detection** | MediaPipe (default) → YOLOv8n-face (fallback) | MediaPipe is CPU-based: zero VRAM cost, leaves the GPU free. Swap to YOLO only if you observe misses on real footage. |
| **Scene/cut detection** | PySceneDetect (AdaptiveDetector) | Standard, cheap, CPU-only. |
| **Rendering** | OpenCV per-frame composite → pipe raw frames → ffmpeg NVENC | Confirmed as the approach both reference implementations use. Dynamic camera paths and split-screen cannot be cleanly expressed as a single ffmpeg filter graph. |

### The WhisperX decision — important

Earlier plan said `faster-whisper`. **Upgrade to WhisperX.** Reasons:

1. Whisper's native word timestamps are derived from decoder attention and are known to be imprecise. WhisperX adds proper **forced alignment** with wav2vec2 — this is the difference between captions that *look* synced and captions that *are* synced.
2. It performs **word-to-speaker assignment** natively, which is precisely the input your composition router needs — you get "word X, at time T, spoken by SPEAKER_01" in one artifact.
3. Its VAD batching also reduces hallucination on long-form audio.

**Two caveats to design around:**
- wav2vec2 alignment is **less noise-robust than Whisper itself**. On clean studio audio timestamps are excellent; on noisy source they degrade faster than the transcription does. Mitigation: run a light audio denoise pass before alignment on low-quality sources, and flag low-confidence alignment rather than trusting it blindly.
- Words the aligner can't place inherit a neighbouring word's timestamp. Numbers and proper nouns are where this shows. If you ever add a "precision caption" mode, test specifically on that content.

---

# PART 2 — SYSTEM ARCHITECTURE

## 2.1 Design principle: local now, distributed later, same code

Every component is written so the only thing that changes between "my laptop" and "500 customers" is **where the queue lives and how many workers consume it.** No rewrite.

```
┌──────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE — Node/TS  (your existing app, evolved)                │
│  • REST API + job submission                                          │
│  • Anthropic calls: clip selection, hooks, titles, layout intent       │
│  • YouTube OAuth + upload (videos.insert)                             │
│  • Job state machine, retries, artifact registry                       │
│  Phase 1: single process, SQLite. Phase 3: Postgres + BullMQ/Redis.    │
└────────────────────────────┬─────────────────────────────────────────┘
                             │  job queue (interface, not implementation)
┌────────────────────────────▼─────────────────────────────────────────┐
│  MEDIA PLANE — Python worker  (new)                                   │
│                                                                        │
│  STAGE 1  ingest        yt-dlp → normalized mp4 + wav                 │
│  STAGE 2  transcribe    WhisperX: words + speakers          [GPU]     │
│  STAGE 3  ── hand transcript back to control plane for clip picking ──│
│  STAGE 4  analyze       PySceneDetect + face track + Light-ASD [GPU]  │
│           (ONLY on selected clip windows)                             │
│  STAGE 5  route         Composition Router → layoutTimeline           │
│  STAGE 6  render        OpenCV composite → NVENC encode → burn caps   │
│                                                                        │
│  Each stage: separate process invocation, own VRAM lifecycle,          │
│  writes a JSON artifact, fully resumable.                              │
└────────────────────────────┬─────────────────────────────────────────┘
                             │
                  artifacts (JSON + mp4) in content-addressed store
                  Phase 1: local disk. Phase 3: S3/R2.
```

## 2.2 Why stages must be separate processes

On 6GB VRAM you cannot hold WhisperX + pyannote + Light-ASD + YOLO simultaneously. Structuring each stage as its own invocation gives you three things at once:

1. **VRAM safety** — process exit is the most reliable `cuda.empty_cache()` there is.
2. **Resumability** — a crash in render doesn't re-run 8 minutes of transcription.
3. **Free horizontal scaling later** — stages already communicate via artifacts, so distributing them across machines is a config change.

Always also do the explicit cleanup, since stages may be batched in one process during development:

```python
del model
gc.collect()
torch.cuda.empty_cache()
```

## 2.3 Artifact contracts (the real API of the system)

Each stage reads and writes typed JSON. Version them from day one (`"schemaVersion": 1`) — you will change these.

```
job/{id}/
  source.mp4              # normalized 1080p
  audio.wav               # 16kHz mono
  transcript.json         # STAGE 2: words[] with start/end/speaker/confidence
  clips.json              # STAGE 3: LLM-chosen windows (start/end/title/hook/...)
  analysis/{clipId}.json  # STAGE 4: faceTracks, sceneCuts, asdScores, signals
  composition/{clipId}.json # STAGE 5: layoutTimeline + cameraPath
  out/{clipId}.mp4        # STAGE 6
  out/{clipId}_thumb.jpg
```

### `composition/{clipId}.json` — the central artifact

```jsonc
{
  "schemaVersion": 1,
  "clipId": "clip_2",
  "start": 142.08, "end": 178.44,        // snapped to scene cut / silence
  "sourceFps": 30,
  "speakers": {
    "SPEAKER_00": { "faceTrackId": 1, "confidence": 0.94 },
    "SPEAKER_01": { "faceTrackId": 2, "confidence": 0.89 }
  },
  "signals": {                            // measured, drives routing + debugging
    "distinctFaceTracks": 2,
    "faceCoverage": 0.97,
    "overlapRatio": 0.31,
    "turnRate": 8.2,
    "subjectMotion": 0.12,
    "facesFitOneCrop": false,
    "sceneCuts": [12.4, 30.1]
  },
  "layoutTimeline": [
    { "t0": 0.0,  "t1": 12.4, "mode": "fullscreen-follow", "target": "SPEAKER_00" },
    { "t0": 12.4, "t1": 20.1, "mode": "split-screen", "reason": "overlap" },
    { "t0": 20.1, "t1": 36.3, "mode": "fullscreen-follow", "target": "SPEAKER_01" }
  ],
  "cameraPath": [ { "t": 0.0, "cx": 0.52, "cy": 0.40, "zoom": 1.0 } ],
  "words": [ { "w": "insane", "start": 143.12, "end": 143.44, "speaker": "SPEAKER_00", "punch": true } ]
}
```

**Why this artifact matters commercially:** it is a complete, inspectable edit decision record. It makes the edit reviewable before render, debuggable when it looks wrong, re-renderable in a different style without re-running inference, and — later — **user-editable in a web UI** ("no, keep it fullscreen here"). That's a product feature the incumbents largely don't expose.

---

# PART 3 — THE COMPOSITION ROUTER

The core differentiator. Not every clip needs a fancy layout — sometimes a plain centered crop is the correct edit, and the system must be able to *decide that*.

**Principle: deterministic rules own facts. The LLM owns taste.**
The LLM must never be able to choose split-screen when only one face is present — that's a factual impossibility, not a creative choice.

## 3.1 Measured signals (Stage 4 output)

| Signal | Method | Routing role |
|---|---|---|
| `faceCoverage` | % of sampled frames with ≥1 face | <0.2 ⇒ non-talking-head content |
| `distinctFaceTracks` | tracking continuity across samples | 1 vs 2+ is the primary branch |
| `speakerCount` | pyannote (via WhisperX) | audio-side cross-check |
| `overlapRatio` | fraction of clip with 2+ speakers active | >0.25 ⇒ split-screen earns its place |
| `turnRate` | speaker switches per minute | high ⇒ camera-switch |
| `subjectMotion` | variance of face centroid | low ⇒ no tracking needed at all |
| `facesFitOneCrop` | do all active faces fit one 9:16 window | true ⇒ just crop wider, no gimmick |
| `asdScore[track][t]` | **Light-ASD** per face per time | authoritative "who on screen is talking" |
| `sceneCuts` | PySceneDetect | snap camera, re-decide per scene |

**Light-ASD vs. audio-only diarization — why it matters.** Diarization tells you *someone* labelled SPEAKER_01 is talking. It cannot tell you *which rectangle on screen* that is. The reference implementations paper over this with fixed left/right slot assignment, which breaks the moment people move or the camera cuts. Light-ASD scores each detected face directly for "is this face speaking right now," which makes the binding correct rather than assumed.

## 3.2 Deterministic routing

```python
def route(sig) -> list[str]:            # returns ALLOWED modes
    if sig.faceCoverage < 0.2:
        return ["static-center", "blurred-fill"]      # gameplay, screen rec, b-roll
    if sig.distinctFaceTracks == 1:
        return (["static-center"] if sig.subjectMotion < MOTION_T
                else ["fullscreen-follow", "static-center"])
    if sig.facesFitOneCrop:
        return ["group-crop", "fullscreen-follow"]
    if sig.overlapRatio > 0.25:
        return ["split-screen", "camera-switch"]
    return ["camera-switch", "split-screen"]
```

**Three rules that separate "works" from "looks broken":**

1. **Minimum hold (~2.0s).** Once a layout or active speaker is chosen, hold it. Without this, every "yeah" / "mhm" triggers a cut and the result is unwatchable.
2. **Snap on scene cut.** On a PySceneDetect boundary, reset camera position instantly instead of panning. Smooth-panning *through* a hard cut reads as a rendering bug.
3. **Hysteresis on ASD.** Require the ASD score to exceed the switch threshold for N consecutive samples before switching targets. Prevents flicker at turn boundaries.

## 3.3 Camera path smoothing

Ported from the reference implementations' tunable set — these constants encode real trial and error, worth starting from rather than re-deriving:

| Param | Start value | Effect |
|---|---|---|
| `track_step` | 0.25s | detection sampling interval; interpolate between |
| `track_deadzone` | 0.15 | ignore face movement within this fraction of frame — kills micro-jitter |
| `track_smooth` | 0.30 | EMA factor toward target position |
| `track_jitter` | 5 px | below this, don't move at all |
| `track_snap` | 0.25 | above this delta, hard-snap instead of easing |
| `switch_hold` | 2.0s | minimum dwell before allowing a speaker switch |

Expose these as **presets** — "Calm" (larger deadzone, slower smoothing, longer hold) vs "Dynamic" (tighter, faster, shorter hold) — rather than fixed constants. Creators feel this difference immediately, and it's a cheap product differentiator.

## 3.4 LLM taste layer

The router hands the LLM *facts + allowed modes*, never raw video:

> "2 face tracks. 31% speech overlap. 8.2 turns/min. Motion moderate. Scene cuts at 12.4s, 30.1s. Allowed: `camera-switch`, `split-screen`. Transcript with word timings and speakers: … "

It returns a `layoutTimeline` plus emphasis decisions (which word to punch, where to push in). If the LLM call fails or returns malformed JSON, **the deterministic router output is already a valid shippable layout** — graceful degradation by construction.

---

# PART 4 — OPTIMIZATION PLAYBOOK

## 4.1 The single biggest win: analyze only what you'll use

Naive ordering (analyze everything, then choose) is what makes laptop pipelines unusable.

```
Download          → whole video   (cheap)
Transcribe        → whole video   [GPU]  ← unavoidable, needed to choose clips
LLM picks clips   → text only     (cheap)
Scene+face+ASD    → ONLY selected windows  [GPU]  ← ~10–20× reduction
Render            → per clip      [CPU composite + NVENC]
```

A 25-minute source analyzed at 3 clips × 40s means you run CV on ~2 minutes of footage instead of 25.

## 4.2 GPU / VRAM tactics (6GB)

- **Sequential stages, process-per-stage.** Never co-resident models.
- **Quantize WhisperX/faster-whisper**: `compute_type="int8_float16"`. Fall back to `distil-large-v3` or `medium` if tight.
- **Keep face detection on CPU** (MediaPipe) so the GPU is free for ASD/whisper. Your i7 HX has the cores.
- **NVENC for encode** (`h264_nvenc`), **NVDEC for decode** (`-hwaccel cuda`) — encoding shouldn't compete with OpenCV compositing for CPU.
- **Batch ASD inference** across the clip's face crops rather than per-frame calls.

## 4.3 I/O and pipeline tactics

- **Download 1080p, never 4K.** Output is 1080×1920; 4K only burns decode time.
- **Sample, don't scan.** Face detection at 0.25s intervals with interpolation between samples.
- **Decode once.** Extract the clip window to an intermediate file before per-frame work rather than seeking repeatedly in a long source.
- **Cache aggressively, keyed by content hash.** Transcript and analysis JSON should never be recomputed when the user only changes caption style or reruns with different creative settings. This is a *huge* iteration-speed win while you're tuning.
- **Two-pass render while developing:** low-res draft at `-preset ultrafast` for review, full quality only on approval.

## 4.4 Instrumentation (do this in Phase 0, not later)

Emit per-stage timing + peak VRAM into the job artifact from the very first commit. You cannot optimize what you don't measure, and on a laptop the bottleneck will surprise you. Log: stage name, wall time, peak VRAM, input duration, output size.

## 4.5 Cost model awareness

Once this is a product, **inference time is your marginal cost** — unlike the transcript-only version which was nearly free. Track GPU-seconds per output clip from day one so pricing is grounded in real numbers rather than guesses. This is also what lets you safely offer the "price per output clip, not per source minute" model that attacks the market's biggest complaint.

---

# PART 5 — SCALABILITY PATH

Designed so **nothing is thrown away** between phases.

| Concern | Phase 1 (laptop) | Phase 3 (SaaS) | What changes |
|---|---|---|---|
| Queue | in-process / SQLite | Redis + BullMQ | config only — jobs already serialize to JSON |
| Artifacts | local disk | S3 / Cloudflare R2 | one storage adapter interface |
| DB | SQLite | Postgres | Prisma/Drizzle migration |
| Workers | 1 local | N GPU workers, autoscaled | stages already isolated |
| GPU | RTX 4050 | rented L4 / A10G, or serverless GPU | same container image |
| Trigger | manual link paste | **PubSubHubbub push** on channel upload | new ingress route |
| Auth | none | OAuth per channel + token vault | new module |

**Design rules to keep this true:**
1. **Never let a stage assume local disk.** Go through a storage adapter from day one, even when it wraps `fs`.
2. **Never let a stage assume it can see another stage's memory.** Artifacts only.
3. **Make every stage idempotent and content-addressed.** Re-running with the same inputs must be a no-op returning cached output.
4. **Keep the LLM provider behind the interface you already have** in `analyze.ts` — you already support Anthropic/OpenAI/Gemini; preserve that.

**On the upload trigger:** when you get to multi-tenant, use **PubSubHubbub push notifications** on each channel's upload feed rather than cron-polling every customer's channel. Push is near-instant and doesn't scale your API cost linearly with customer count. (Note the reference implementation you studied uses polling — you can do better.)

---

# PART 6 — PHASED EXECUTION PLAN

### Phase 0 — Foundation & instrumentation
- Stand up the Python worker skeleton: stage runner, artifact store adapter, JSON schemas v1, per-stage timing + VRAM logging.
- Implement **Stage 1 (ingest)** and **Stage 2 (WhisperX)** with word-level timestamps + speaker labels.
- Wire into existing Node app in place of the current whisper call.
- **Delete `splitWordsWithTiming`** — the even-split interpolation in `captions.ts` is fully superseded by real word timings. This alone fixes the caption desync.
- Add PySceneDetect + silence detection; **snap LLM-chosen clip boundaries** to real cut points. Fixes inconsistent cuts.
- ✅ *Ship-able immediately: captions sync correctly, cuts land clean, with no renderer changes.*

### Phase 1 — Analysis pass + router skeleton
- Stage 4: MediaPipe face detection + tracking, signal computation.
- Stage 5: router with two modes wired — `static-center` and `fullscreen-follow`.
- Stage 6: replace fixed `crop=ih*9/16:ih` with OpenCV-composite → NVENC pipeline; camera path smoothing with the tunable set.
- ✅ *Covers most single-speaker content correctly, including "plain center is right" cases.*

### Phase 2 — Multi-speaker intelligence
- Integrate **Light-ASD**; bind speakers to face tracks via ASD scores (not fixed slots).
- Unlock `camera-switch` and `group-crop`. Implement min-hold, snap-on-cut, ASD hysteresis.
- ✅ *This is the quality tier the incumbents visibly miss.*

### Phase 3 — Split-screen
- Implement the split-screen renderer (stacked / side-by-side), unlocked by `overlapRatio`.
- Most complex renderer, narrowest applicability — correctly last.

### Phase 4 — LLM taste layer + caption polish
- Feed signals + allowed modes to the LLM for `layoutTimeline` refinement and emphasis.
- Caption presets (palettes/animations you already have) driven by content mode.
- Best-frame thumbnail selection using detected faces instead of a fixed timestamp.

### Phase 5 — YouTube auto-upload (still single-user)
- OAuth + `videos.insert` back to your own channel. End-to-end: link in → Short published.

### Phase 6 — Productization
- Multi-tenant auth, Postgres, Redis queue, S3 artifacts, remote GPU workers.
- PubSubHubbub channel subscriptions.
- **Composition review UI** — let users edit the `layoutTimeline` before render. Differentiator, and cheap because the artifact already exists.
- Usage/billing metered on **output clips**, not source minutes.

---

# PART 7 — RISKS & OPEN ITEMS

| Risk | Mitigation |
|---|---|
| **Licensing of reference repos** | Verify licenses of `opensource-clipping` and `auto-vertical-reframe` before shipping commercially. Safest path: lift *architectural patterns and tuning constants*, write your own implementation. Check Light-ASD, TalkNet, and pyannote model licenses for commercial use terms specifically — research-origin models sometimes restrict this. |
| wav2vec2 alignment degrades on noisy audio | Denoise pass before alignment; surface low-confidence alignment rather than trusting silently |
| pyannote requires HF token + terms acceptance | Document as a setup step; fail with a clear error, not a stack trace |
| 6GB VRAM ceiling | Process-per-stage; quantized models; CPU face detection; documented fallback model ladder |
| LLM returns malformed layoutTimeline | Deterministic router output is always a valid fallback — never block a render on the LLM |
| Laptop thermal throttling on long jobs | Log wall-time per stage; if sustained loads throttle, cap concurrency at 1 job |
| Marginal cost misjudged at launch | Track GPU-seconds per clip from Phase 0 so pricing is grounded in measurements |

---

## Immediate next action

Phase 0, and it's small: Python worker skeleton + WhisperX stage (word timestamps + speakers) + PySceneDetect boundary snapping + timing instrumentation, dropped alongside `server/pipeline/` and invoked the way `transcribe.ts` currently shells out to whisper. That single step fixes both quality bugs currently in the app and lays every interface the later phases plug into.
