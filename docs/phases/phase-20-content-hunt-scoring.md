# Phase 20 — Content Hunt: semantic pass, scoring, queue

**Goal:** a ranked backlog of opportunities, each with the reasons attached.

`[revisit]` — sub-score weights must be tuned against which clips actually
performed. Until you have that data, weights are guesses. Make them config.

## Why now

Second half of the funnel: H4–H6. Turns candidates into a decision.

## Scope

Local semantic pass, opportunity scoring, ranked queue with a review UI.

## Out of scope

Auto-processing the queue without review. Learning from outcomes — phase 21.

## Changes

### H4 — Local semantic pass

Everything surviving phase 19 goes through phase 17's embeddings over title +
description + caption snippet. **High-volume, mechanical, objectively checkable —
exactly what tier 0 is for, and it costs nothing per item.**

| Job | Method |
|---|---|
| **Semantic dedup** | 10 channels covering the same news story collapse to one opportunity |
| Topic clustering | group candidates, track cluster recency |
| Similarity to past top-performers | "this looks like what worked for me" |
| Brand fit | similarity to your topic profile |

Semantic dedup is the one that earns the phase on its own. A breaking story
generates dozens of near-identical uploads, and without dedup the queue is
twenty rows of the same thing.

### H5 — Opportunity scoring

**Transparent sub-scores, never one opaque number.**

| Sub-score | Source |
|---|---|
| Velocity | metadata (H3) |
| Channel-relative outlier | metadata (H3) |
| Topic freshness | embedding cluster recency (H4) |
| Saturation / competition | how many similar videos already exist (H4) |
| Brand fit | similarity to your profile (H4) |
| Clip potential | local LLM quick pass over captions (T1/T2) |
| Rights posture | phase 14 |

The composite is a weighted sum, but **the sub-scores are always shown**. "Score
82" is unactionable; "high velocity, low saturation, weak brand fit" tells you
whether to trust it.

Saturation and freshness pull against each other on purpose. A fresh topic with
low saturation is the opportunity; a fresh topic with fifty covers already is not.

### Clip potential — the escalation ladder

First real use of tiered routing:

```
Is the task mechanical, high-volume, objectively checkable?  → T0/T1 local
Is it structured extraction with a schema you can validate?  → T2 local, validate, escalate on failure
Is it creative, taste-driven, or final output?               → T3 cloud
Is the network down?                                         → best local tier, mark "draft"
```

**Escalation, not replacement.** Local produces output → schema validation →
on failure, escalate. Two payoffs: graceful degradation, and a natural
measurement harness. Log how often local output passes validation and you learn
empirically which tasks can be demoted to local permanently — data, not vibes.

Concretely, screening 500 candidates a day: all 500 through embeddings + T1
(zero API cost, CPU, concurrent with GPU work), ~20 survive to T2 local
extraction (still zero), ~3 reach T3 cloud for final selection. **You pay for 3,
not 500** — roughly 99% fewer cloud calls for the discovery half, with cloud
quality kept exactly where it matters.

### H6 — Queue

Ranked backlog in SQLite (phase 24's database), surfaced as a panel in
[phase 28](phase-28-dashboard.md)'s dashboard rather than a bespoke screen:
thumbnail, sub-scores, reasons, rights posture, and a "Send to pipeline" button
that creates a normal job.

**Candidates are checked against the source catalog before they reach the queue.**
A video already ingested, already clipped, or already deliberately archived
should not resurface as a fresh opportunity — that check is one join against
phase 24's `source` table.

**Review by default, not auto-processing.** The manual flow from Block A stays
the path; this just fills the input with good candidates instead of you finding
them. Auto-processing the top N is a later toggle, and `third-party` items can
never take it — phase 14's gate holds unchanged.

## Contracts

```jsonc
{
  "videoId": "dQw4w9WgXcQ",
  "cluster": { "id": 17, "size": 6, "isRepresentative": true },
  "scores": {
    "velocity": 0.91, "outlier": 0.88, "freshness": 0.72,
    "saturation": 0.31, "brandFit": 0.64, "clipPotential": 0.79,
    "composite": 0.76
  },
  "reasons": ["10x channel baseline", "topic 4h old", "only 6 similar videos", "matches your top-performer profile"],
  "rights": "third-party",
  "tier": { "clipPotential": "T2-local", "escalated": false }
}
```

## Gate

1. Semantic dedup collapses a known duplicate set (same story, many channels)
   into one representative.
2. Sub-scores are individually inspectable in the UI.
3. Top 10 queue items are ones you'd genuinely consider — the only real test.
4. `third-party` items are visibly labelled and cannot auto-process.
5. Cloud calls per 500 candidates are in single digits.
6. A local-tier failure escalates to cloud rather than shipping bad output.
7. Local-pass-rate is logged per task type.

## Tests

- `scoring.test.ts` — composite from known sub-scores; weight changes move it
  predictably; missing sub-score degrades rather than `NaN`.
- `dedup.test.ts` — near-identical titles cluster; unrelated ones don't;
  representative selection is deterministic.
- Escalation: schema-invalid local output triggers cloud; valid output does not.
- `third-party` never enters auto-processing.

## Risks

| Risk | Mitigation |
|---|---|
| `[revisit]` Weights guessed | Config, not constants; tuned on real outcomes by [phase 27](phase-27-performance-loop.md), which is what removes this `[revisit]` |
| The same video resurfaces as a new opportunity | Checked against phase 24's `source` catalog before entering the queue |
| Dedup collapses genuinely different videos | Threshold tuned on a known set; representative always inspectable |
| Local clip-potential quietly worse | Schema validation + escalation + logged pass rate |
| Queue grows unbounded | Age out unprocessed items; cap the backlog |
| Scoring optimises for what's measurable, not what performs | Sub-scores stay visible so you can override — the human is the point of H6 |
