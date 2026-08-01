# AI Content OS — Expansion Plan: Content Hunt + Local Model Layer

Companion to `shorts-studio-master-plan.md` and `AI_Content_OS_Master_Plan.md`.
Covers three additions: **(A)** the Content Hunt module (YouTube-only v1), **(B)** a local-model layer that cuts API dependence, **(C)** the agent + script system built on top of both.

Rig assumption unchanged: RTX 4050 laptop, 6GB VRAM, i7 13th-gen HX, local single-user first.

---

# PART A — CONTENT HUNT (YouTube v1)

## A.1 What it actually is

The Master Plan's "Discovery Engine" is broad. Narrowed to YouTube-only, Content Hunt answers one question repeatedly:

> **"Which video should I turn into content right now, and why?"**

It's a continuously-running funnel that turns the whole of YouTube into a ranked, deduplicated queue of *opportunities*, each of which can be dropped straight into the Shorts Studio pipeline.

```
  SEED           HARVEST          ENRICH          SCORE          QUEUE
 keywords   →   candidate    →   metadata,   →  opportunity  →  ranked
 channels       video IDs        transcript      scoring         backlog
 topics                          (cheap)
```

## A.2 The constraint that dictates the entire design: YouTube API quota

This is the single most important engineering fact for this module, and it kills naive designs immediately.

| Operation | Quota cost | Practical meaning |
|---|---|---|
| `search.list` | **100 units** | ~100 searches/day, total |
| `videos.list` (up to 50 IDs/call) | **1 unit** | ~500k videos/day of metadata if batched |
| `playlistItems.list` | **1 unit** | the escape hatch — see below |
| `videos.insert` (upload) | ~100 units, **own daily bucket** (~100/day) as of June 2026 | uploads no longer compete with reads |

Default allocation is **10,000 units/day per Google Cloud project** (not per key — all keys in a project share it), resetting midnight Pacific. Every request costs at least 1 unit, **including failed and malformed ones**.

### The design rules that fall out of this

**Rule 1 — Search is a scarce, budgeted resource. Treat it like paid API credits.**
100 searches a day is your entire discovery budget. Paginating one query 5 pages deep costs 500 units — 5% of the day gone on one keyword. Build a **quota ledger** in the DB from day one: every call logs its unit cost, and the harvester refuses to run when the projected cost exceeds remaining budget. Reserve a floor (say 1,500 units) so an experiment can't starve your production jobs.

**Rule 2 — Use the uploads-playlist trick for channel monitoring.**
To watch a channel for new videos, do **not** call `search.list` (100 units). Every channel has an "uploads" playlist; `playlistItems.list` against it costs **1 unit**. That's a 100× saving, and it's the difference between monitoring 5 channels and monitoring 500. Channel monitoring should *never* touch search.

**Rule 3 — Search discovers, reads enrich.**
Use `search.list` only to find *new* channels/videos you don't already know about. Once you have IDs, everything else — stats, duration, tags, descriptions — comes from batched `videos.list` at 1 unit per 50 IDs.

**Rule 4 — Cache with ETags and field selection.**
Conditional requests plus `fields=` projection plus GZIP plus local caching can cut a workload's quota consumption several-fold. A metadata refresh that naively costs 1,000 units/day can drop to a small fraction of that.

**Rule 5 — Transcripts don't come from the Data API.**
Caption retrieval via the API is awkward and quota-costly. Use `yt-dlp`'s subtitle extraction for auto-captions during the cheap screening pass; only run WhisperX (expensive, GPU) on videos that survive scoring.

### Practical daily budget (single user, default quota)

```
  1,500 units  channel monitoring   (~1,500 playlistItems calls — huge coverage)
  4,000 units  discovery search     (40 searches, rotated across seed topics)
  2,000 units  metadata enrichment  (~100,000 videos of batched videos.list)
  1,000 units  analytics/own-channel reads
  1,500 units  RESERVE (failures, retries, experiments)
 ─────────────
 10,000 units
 + separate ~100/day upload bucket
```

## A.3 Pipeline stages

### Stage H1 — Seeds
Persistent, user-editable seed set: keywords, tracked channels, topics, competitor channels. Each seed carries a **cadence** (how often to re-harvest) so you're not spending search quota on slow-moving niches daily.

### Stage H2 — Harvest (quota-aware)
- Tracked channels → `playlistItems.list` on uploads playlist (1u each). Cheap, run often.
- Keyword seeds → `search.list` (100u), rotated round-robin so each seed gets hit on its cadence rather than all firing daily.
- Output: candidate video IDs, dedup'd against everything already seen.

### Stage H3 — Cheap screening (no GPU, no cloud LLM)
Batched `videos.list` for metadata. Then filter *before* spending anything expensive:
- duration in range, language, age, not already processed
- **velocity**: views ÷ hours-since-publish — this is the strongest early signal of an opportunity
- engagement ratio: (likes + comments) ÷ views
- channel-relative outlier: is this video overperforming *that channel's* baseline? (a 50k-view video on a 5k-average channel is a far stronger signal than a 500k video on a 2M channel)
- auto-caption availability

### Stage H4 — Local semantic pass (see Part B)
For everything that survives H3, run **local embeddings** over title + description + caption snippet:
- semantic dedup (10 channels covering the same news story collapse to one opportunity)
- topic clustering
- similarity to your own past top-performers ("this looks like the stuff that worked for me")
- similarity to your brand/topic profile

This is high-volume, mechanical work — exactly what a local model should do, and it costs nothing per item.

### Stage H5 — Opportunity scoring
Combine into a single ranked score with **transparent sub-scores** (never one opaque number):

| Sub-score | Source |
|---|---|
| Velocity | metadata (H3) |
| Channel-relative outlier | metadata (H3) |
| Topic freshness | embedding cluster recency (H4) |
| Saturation / competition | how many similar videos already exist (H4) |
| Brand fit | similarity to your profile (H4) |
| Clip potential | local LLM quick pass on captions (Part B) |
| Rights posture | see A.4 |

### Stage H6 — Queue
Ranked backlog with reasons attached. Feeds either auto-processing (top N per day) or a review UI where you approve before the GPU pipeline runs.

## A.4 The thing you must design for now, not later: rights

Your Master Plan lists "rights-aware ingestion" as a principle — make it concrete in Content Hunt, because this module is specifically designed to find *other people's* videos.

Clipping someone else's video and uploading it to your own channel is a copyright question, not a technical one. Fair-use/fair-dealing analysis is fact-specific and I'm not in a position to tell you where any given clip lands — but the product should make the distinction structural rather than leaving it to a judgment call at 2am:

Tag every opportunity with an explicit **rights posture** at harvest time:
- `owned` — your own channels. Full auto-pipeline, safe to auto-publish.
- `licensed` — explicit permission, Creative Commons (YouTube exposes a CC license flag in video metadata — read it), or a partner agreement.
- `third-party` — everything else. **Never auto-publishes.** Can be analyzed and can produce a draft, but requires an explicit human action to publish, and should surface a warning.

Make `third-party` incapable of reaching the publisher by architecture (the publish adapter rejects it), not by policy documentation. That single design choice is also a genuine enterprise selling point later — it's the kind of thing that gets asked about in procurement.

Two other practical notes: automated YouTube uploads must comply with YouTube's Terms of Service, and quota increase requests are approved partly on demonstrated ToS compliance — so a clean rights model directly helps you scale quota later. And when this becomes a product, "we prevent our users from committing copyright infringement by default" is a much better position than the alternative.

---

# PART B — THE LOCAL MODEL LAYER

## B.1 The honest framing

The goal isn't "eliminate cloud models." It's **"stop paying cloud prices for mechanical work, and stop being unable to run when offline."** Full local-only would meaningfully hurt output quality on the creative decisions. The right structure is a **capability ladder** where work flows to the cheapest tier that can do it correctly.

## B.2 The constraint nobody plans for: your GPU is already full

This is the key architectural insight for your rig. WhisperX, Light-ASD, and face detection already saturate 6GB. **A local LLM cannot be co-resident with the CV pipeline.** Naive "just run Ollama alongside" will either OOM or silently spill layers to system RAM.

Three consequences:

1. **Local LLM inference is its own pipeline stage**, subject to the same process-per-stage / VRAM-lifecycle discipline as everything else. It never overlaps with CV stages.
2. **Anything that needs to run *concurrently* with CV work must be CPU-only.** Your i7 HX handles this fine for embeddings and small models — this is exactly why embeddings (Stage H4) are the ideal local workload.
3. **Context length is a VRAM multiplier, and agent loops are context hogs.** An agent that reads files, plans, executes, and reviews can burn thousands of tokens per iteration. Setting a large context window directly increases VRAM use, and overflowing causes silent CPU fallback that degrades tool-call format reliability — the model still emits calls, they just get malformed. Cap `num_ctx` to what actually fits and design agent tasks to be narrow and short-context.

## B.3 Model ladder for 6GB

| Tier | Runs on | Model class | Use for |
|---|---|---|---|
| **T0 — Embeddings** | **CPU**, always available | small sentence-embedding model (BGE / MiniLM / nomic-embed class) | semantic dedup, clustering, brand-fit, retrieval. Highest-volume, lowest-value-per-item work. Runs concurrently with GPU stages. |
| **T1 — Small local** | CPU or GPU-when-free | ~2–4B class (Qwen3-family small, Phi-4-mini, Gemma-4 E2B class) | classification, tagging, metadata extraction, keyword generation, boolean judgments, first-pass filtering |
| **T2 — Mid local** | GPU, dedicated stage | ~7–9B class at Q4 (~5–6GB) | clip candidate pre-ranking, caption cleanup, structured JSON extraction, draft generation |
| **T3 — Cloud** | Anthropic API (your existing interface) | Claude | final clip selection, hooks, titles, `layoutTimeline` taste layer, script writing, anything creative or high-stakes |

Two rules of thumb worth internalizing:
- Within a fixed memory budget, **a larger model at Q4 generally beats a smaller model at Q8**. Prefer quantizing up.
- For tool-calling reliability specifically, the **Qwen3 family is the most consistently recommended local option** — it rarely hallucinates calls or drops parameters, and ships proper tool-call parsing support in the common runtimes. If your agents need function calling, that's the family to start with.

## B.4 The routing rule (write this once, use everywhere)

```
Is the task mechanical, high-volume, and objectively checkable?  → T0/T1 local
Is it structured extraction with a schema you can validate?      → T2 local, validate, escalate on failure
Is it creative, taste-driven, or user-facing final output?       → T3 cloud
Is the network down?                                             → best available local tier, mark output "draft"
```

**Escalation, not replacement.** Local tier produces output → schema validation / confidence check → on failure, escalate to the next tier. This gives you graceful degradation *and* a natural measurement harness: log how often local output passes validation, and you learn empirically which tasks can be demoted to local permanently.

## B.5 What this saves you

Concretely, on a Content Hunt run screening 500 candidate videos a day:
- All 500 through embeddings + T1 filtering: **zero API cost**, runs on CPU during GPU work.
- ~20 survive to T2 local structured extraction: still zero API cost.
- ~3 reach T3 cloud for final clip selection, hooks, and layout taste: **you pay for 3, not 500.**

That's roughly a 99% reduction in cloud calls for the discovery half of the system, while keeping cloud quality exactly where it matters. It also means Content Hunt keeps running when you're rate-limited, offline, or between API budgets.

## B.6 Runtime choices

- **Ollama** — easiest path, good enough for orchestration from Node/TS, OpenAI-compatible endpoints, tool support built in. Start here.
- **llama.cpp** — more control over quantization, offload split, and CPU threading. Move here when you need to pin exactly how many layers go to GPU vs CPU.
- Keep both behind the **same provider interface `analyze.ts` already uses** for Anthropic/OpenAI/Gemini. Local models become just another provider — no new abstraction, and swapping tiers becomes config.

---

# PART C — AGENTS & SCRIPTS

## C.1 Design principle: agents are stages, not a swarm

The Master Plan lists 8 agents. Resist the temptation to make them a free-form multi-agent chat. On a 6GB laptop, a chatty agent swarm will be slow, expensive in context, and non-deterministic in ways that make failures unreproducible.

Instead: **each agent is a pipeline stage with a typed input artifact, a typed output artifact, and a fixed tier assignment.** Same discipline as your CV stages. You get resumability, caching, testability, and the ability to swap a stage's model tier without touching anything else.

## C.2 Agent roster mapped to tiers

| Agent | Job | Tier | Notes |
|---|---|---|---|
| **Hunt Agent** | seed rotation, quota budgeting, harvest scheduling | T1 + rules | mostly deterministic; LLM only for keyword expansion |
| **Screen Agent** | dedup, cluster, brand-fit, first-pass ranking | T0/T1 | pure local, high volume, runs on CPU |
| **Knowledge Agent** | topics, entities, quotes, hooks, story beats from transcript | T2 local → T3 escalate | structured extraction with a schema; validate then escalate |
| **Clip Agent** | final clip selection + hook/title | **T3** | this is the money decision — don't cheap out |
| **Editing Agent** | `layoutTimeline` taste layer over router facts | **T3** | deterministic router already provides the fallback |
| **Script Agent** | see C.3 | T3 (T2 for drafts) | |
| **SEO Agent** | titles, descriptions, tags, hashtags | T2 → T3 for finals | high volume of variants, low stakes per variant |
| **Publish Agent** | platform adapters, scheduling, retry, **rights gate** | rules only | no LLM — this is where non-determinism is most dangerous |
| **Analytics Agent** | metric collection, pattern detection | T1 + stats | statistics do most of the work; LLM only for narrative summary |

Note which agents have **no LLM at all**. Publishing and quota budgeting should be boring deterministic code. Reserve model calls for judgment.

## C.3 The Script system — this is bigger than it looks

You asked about scripts, and it's worth separating three genuinely different products hiding under one word:

**1. Clip scripts (repurposing).** Given a chosen clip, generate the hook line, on-screen text beats, caption emphasis, and end-card CTA. Grounded entirely in existing footage. Lowest risk, highest immediate value. T3 with T2 draft.

**2. Original video scripts (creation).** Content Hunt finds a topic → Research Agent gathers sources → Script Agent writes a full script with hook, beats, B-roll suggestions, and CTA. This is the step that turns your product from a *repurposing* tool into a *creation* tool — a substantially larger market position, and something none of the incumbents in your competitive table do.

**3. Series/format scripts.** Given your top-performing formats (learned from analytics), generate the next N episodes in an established format. This is where the Learning Engine actually pays off, and it's the most defensible feature because it depends on *your accumulated data*, which a competitor can't copy.

**Grounding requirement.** Scripts must cite their sources into an artifact (`script/{id}.json` with a `sources[]` array). A script agent free-styling confident facts is the fastest way to burn a channel's credibility. Make citation structural: the artifact schema requires sources, so an ungrounded claim is a schema violation, not a style preference.

## C.4 Creator Memory — the local-model killer app

Your Master Plan's "Creator Memory" (brand voice, fonts, colors, caption style, presets, audience, schedule) is best implemented as a **local vector store + structured profile**, because:
- it's queried constantly (every agent needs it) — cloud calls would be wasteful
- it's private data you may not want leaving the machine
- embeddings are T0: free, CPU, always available
- it grows monotonically and gets more valuable over time — this is the real moat

Store: brand profile (structured), past outputs + their analytics (embedded), voice examples (embedded), preset configs. Every agent retrieves from it before generating. This is what makes output *sound like you* rather than like a generic AI clipper, and it costs essentially nothing to run.

---

# PART D — REVISED ROADMAP

Slotting the new modules into the existing phase plan without disrupting the critical path (editing quality still comes first — a discovery engine feeding a mediocre editor is worthless).

| Phase | Existing (Shorts Studio) | Added |
|---|---|---|
| **0** | Python worker, WhisperX, scene snapping, instrumentation | **Quota ledger + provider interface for local models** (both are foundational plumbing, cheap now, painful to retrofit) |
| **1** | Face tracking, router skeleton, OpenCV render | **T0 embeddings service (CPU)** — enables everything in Part A |
| **2** | Light-ASD, camera-switch, multi-speaker | **Content Hunt H1–H3** (seeds, quota-aware harvest, cheap screening) |
| **3** | Split-screen renderer | **Content Hunt H4–H6** (semantic pass, scoring, queue) + rights posture gate |
| **4** | LLM taste layer, caption polish | **T1/T2 local tiers + escalation routing** + Script system (clip scripts) |
| **5** | YouTube auto-upload | **Publish Agent with rights gate**; Analytics collection begins |
| **6** | Multi-tenant SaaS | Learning Engine, original + series scripts, Creator Memory at scale, marketplace |

**Sequencing logic:** the quota ledger and the model-provider interface go in Phase 0 because both are cross-cutting and horrible to retrofit. Embeddings come early because Content Hunt depends on them and they're cheap. Content Hunt itself lands *after* the editor is good, because discovering great opportunities you then edit badly is worse than not discovering them.

---

# PART E — NEW RISKS

| Risk | Mitigation |
|---|---|
| **Copyright on third-party clips** | Rights posture tagged at harvest; `third-party` structurally cannot reach the publish adapter; human approval required. Read YouTube's CC license flag from metadata where present. |
| **YouTube ToS on automated upload** | Review ToS before automating publish; ToS compliance is also a factor in quota-increase approval |
| Quota exhaustion mid-day | Hard ledger with reserve floor; refuse-before-call rather than fail-after-call; channel monitoring via playlist reads never touches search |
| Local model quality regression sneaking into output | Schema validation + escalation on failure; log local-pass-rate per task so demotions to local are data-driven, not vibes |
| Agent context blowup on 6GB | Cap `num_ctx` to real VRAM; narrow single-purpose agent tasks; watch for silent CPU spill degrading tool-call format |
| Local + CV contention | Local LLM is its own stage, never co-resident with CV; only T0 embeddings run concurrently, and only on CPU |
| Scope creep — this plan is large | Editing quality remains the critical path. Content Hunt is worthless attached to a mediocre editor. |

---

## Immediate next actions

Unchanged in priority — Phase 0 of the editing pipeline is still the thing to build first. But two small additions belong in that same phase because retrofitting them later is expensive:

1. **Quota ledger** — a table + wrapper that logs unit cost on every YouTube API call and refuses calls that would breach the reserve floor. ~100 lines, saves you from the classic "app dies at lunchtime" failure.
2. **Local provider behind the existing LLM interface** — register Ollama as another provider in `analyze.ts`. Costs almost nothing now, and makes the entire tier ladder in Part B a config change rather than a refactor.
