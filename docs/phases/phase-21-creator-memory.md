# Phase 21 — Creator Memory

**Goal:** the system knows what *your* channel sounds like, and every agent
retrieves from it before generating.

`[revisit]` — this depends on having published enough clips with real analytics
to learn from. Don't start it before phase 15 has been running for a while.

## Why now

The local-model killer app, and the only genuinely defensible thing in the plan.
Everything else in the roadmap a competitor can copy; **accumulated data about
your channel they cannot.**

Four reasons it belongs local:
- Queried constantly — every agent needs it, so cloud calls would be wasteful.
- Private data you may not want leaving the machine.
- Embeddings are T0: free, CPU, always available.
- It grows monotonically and gets more valuable over time.

## Scope

Structured brand profile, embedded past outputs with their analytics, retrieval,
and analytics collection.

## Out of scope

Automatic strategy changes. Memory informs generation; it doesn't take decisions
on its own.

## Changes

### Structured profile

Hand-edited, small, and read by everything: brand voice notes, target audience,
topics you cover and topics you avoid, caption presets, fonts and colours,
posting schedule, and the composition preset (`calm` / `dynamic`) you prefer.

Plain JSON in SQLite — phase 24's database. It's a config file that happens to
live in a database.

**One profile per channel, not per install** ([phase 26](phase-26-multi-channel.md)
stores it on the `channel` row). "What your channel sounds like" is a different
sentence for the comedy channel and the gaming channel; a shared profile blurs
both toward the mean, which is how several channels quietly become one channel
wearing several names.

### Embedded stores

| Store | Content | Used for |
|---|---|---|
| Past outputs | title, hook, script, hashtags + **their analytics** | "what worked for me" |
| Voice examples | your best-performing scripts and hooks | tone matching |
| Topic profile | what you cover | brand fit in phase 20 |

The analytics attachment is what makes this more than a style guide. An embedded
hook with 400k views and an embedded hook with 800 views are not the same
retrieval result.

### Analytics collection

> **Moved to [phase 27](phase-27-performance-loop.md).** Collection, scheduling
> and the quota question are built there; this phase *consumes* the result. Two
> corrections carried over: the Analytics API has its own quota (phase 18's
> 1,000-unit own-channel line was reserving the wrong budget), and the retention
> report cannot batch video IDs — one query per video, which is why 27 spreads
> pulls over day 1/3/7/28 instead of bursting.

Per published clip: views, watch time, retention curve, likes, comments —
read from 27's stored pulls rather than fetched here.

**Retention is the signal that matters.** Views measure the thumbnail and title;
retention measures the edit. Since Block A was entirely about edit quality,
retention is the only number that tells you whether it worked.

Capture retention shape, not just the average — where viewers drop is more
useful than how many.

### Retrieval

```ts
export async function recall(query: string, kind: MemoryKind, k = 5): Promise<MemoryHit[]>;
```

Agents call this before generating. Cheap enough to call every time, which is the
point of it being T0.

Weight by performance, not just similarity: a semantically-close hook that
flopped is a negative example and should be retrievable as such.

### Feeding it back

- **Phase 20's brand fit** becomes a real measurement instead of a guess.
- **Clip selection** can be shown "clips like this performed well/badly for you."
- **Phase 20's weights** get tuned from outcomes — this is what removes the
  `[revisit]` from that phase.

## Contracts

```jsonc
{
  "kind": "past-output",
  "clipId": "clip_2", "videoId": "dQw4w9WgXcQ",
  "text": "hook + title + script",
  "analytics": { "views": 41200, "avgViewPct": 0.68,
                 "retentionCurve": [1.0, 0.82, 0.71, 0.68],
                 "likes": 3100, "comments": 210, "collectedAt": 1753900000000 },
  "performance": 0.84
}
```

`performance` is a normalized composite **relative to your own channel's
baseline**, not absolute. A 40k-view clip is excellent or disappointing depending
entirely on the channel it's on.

## Gate

1. Profile is retrievable by every agent in a single cheap call.
2. Analytics collect automatically for published clips, inside the 1,000-unit budget.
3. `recall` returns relevant past outputs — spot-check against ones you'd have
   picked yourself.
4. Retrieval weights by performance, not similarity alone.
5. Runs entirely locally; nothing in memory reaches a cloud API except as
   retrieved context in a prompt you can inspect.
6. Phase 20's brand-fit score visibly improves after memory is populated.

## Tests

- `memory.test.ts` — `recall` ranks by similarity × performance; a high-similarity
  low-performance item ranks below a slightly-less-similar high performer.
- Empty memory returns empty, never throws — the cold-start case is the normal
  case on day one.
- `performance` normalizes against channel baseline, not absolute views.
- Analytics collection is idempotent per clip per day.

## Risks

| Risk | Mitigation |
|---|---|
| Cold start — nothing to recall | Degrade to the structured profile alone; agents must work with zero hits |
| Memory reinforces past choices, output converges | Cap memory's influence; keep some exploration in clip selection |
| Analytics API quota | Budgeted line in phase 18's ledger |
| Private data leaking into prompts unnoticed | Retrieved context is logged with the prompt so you can see exactly what was sent |
| `[revisit]` Too few published clips to learn from | Don't start until phase 15 has real history |
