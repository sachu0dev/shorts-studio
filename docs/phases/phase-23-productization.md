# Phase 23 — Productization

**Goal:** the same code runs for 500 customers that ran on your laptop.

`[revisit]` — the largest and least certain phase in the plan. Everything here
should be re-planned when reached; market conditions and your own product will
have moved. Treat this as a direction, not a specification.

## Why it's last, and why it's not a rewrite

Every design rule enforced from phase 1 exists so this phase is **configuration
rather than reconstruction**:

| Concern | Phase 1 (laptop) | Phase 23 (SaaS) | What changes |
|---|---|---|---|
| Queue | in-process / SQLite | Redis + BullMQ | config — jobs already serialize to JSON |
| Artifacts | local disk | S3 / Cloudflare R2 | one storage adapter implementation |
| DB | SQLite | Postgres | a migration |
| Workers | 1 local | N GPU workers, autoscaled | stages already isolated |
| GPU | RTX 4050 | rented L4 / A10G, or serverless | same container image |
| Trigger | manual link paste | PubSubHubbub push | new ingress route |
| Auth | none | OAuth per channel + token vault | new module |

If any row above turns out to be a rewrite rather than a swap, one of the four
rules was broken earlier: stages must never assume local disk, never assume
another stage's memory, always be idempotent and content-addressed, and the LLM
provider stays behind the existing interface.

## The pieces

### Storage adapter
`LocalStore` from phase 1 gains an `S3Store` sibling. This is the second
implementation the phase-1 interface was justified by. If it needs more than a
new class, phase 1 leaked.

### Queue
BullMQ over Redis. Jobs already serialize to JSON, so the change is where the
queue lives and how many workers consume it.

### Database
SQLite (phases 17–21) → Postgres via Prisma or Drizzle.

### Workers
Stages are already separate process invocations with their own VRAM lifecycle —
that was never only about the 6 GB ceiling, it was about this. Package the worker
as a container; run N of them on rented GPUs.

### Multi-tenant auth + token vault
Per-channel OAuth. Refresh tokens encrypted at rest — the `chmod 600` file from
phase 15 is a single-user answer and does not survive contact with tenants.

### PubSubHubbub push
For customers' channel-upload triggers, use **push notifications** rather than
cron-polling every channel. Near-instant, and it doesn't scale API cost linearly
with customer count. (The reference implementation studied uses polling — you can
do better.)

### Composition review UI
Let users edit the `layoutTimeline` before render: *"no, keep it fullscreen
here."* Cheap, because the artifact already exists and has since phase 7 — it is
a complete, inspectable edit decision record. **A product feature the incumbents
largely don't expose.**

## Pricing — the actual wedge

Market research finding 1: **credit metering is the market's open wound.** The
dominant reason creators switch tools isn't clip quality — it's that credits run
out mid-month and cost scales linearly with source length (commonly 1 credit =
1 minute of source video). A 60-minute podcast burns 60 credits.

Because you run inference yourself rather than reselling an API, you can price on
**output clips, not source minutes**. A 3-hour podcast producing 5 Shorts costs
you ~5 renders, not 180 credits.

This only works if you know your marginal cost. **Inference time is that cost** —
which is why phase 1 logs GPU-seconds per stage from the first commit. By this
phase you have months of real numbers, and pricing is grounded rather than guessed.

## The differentiated position

> **Content-aware composition + word-perfect captions in one pass, with a pricing
> model that doesn't punish long-form.**

Two market findings support it:

- **Multi-speaker footage is where incumbents visibly break.** Clip quality holds
  for straightforward talking-head content, but users still drop into a separate
  editor for complex multi-speaker footage. Phases 7–10 target exactly that.
- **Nobody has merged "find the moment" and "make it look incredible."** OpusClip
  finds moments; creators add Submagic on top for captions. The workflow most
  creators run is *two paid subscriptions stapled together.*

## Gate

1. The same container runs a job on a rented GPU with no code change.
2. Switching to `S3Store` requires no change in any stage.
3. Two tenants' artifacts and tokens are provably isolated.
4. A tenant's channel upload triggers a job via push within a minute.
5. The review UI can edit a `layoutTimeline` and re-render **without re-running
   inference** — the artifact-based architecture's payoff, made visible.
6. Billing per output clip reconciles against measured GPU-seconds.

## Risks

| Risk | Mitigation |
|---|---|
| Some row in the table is a rewrite | The phase-1 rules exist to prevent this; if one broke, fix it there |
| Marginal cost misjudged at launch | GPU-seconds per clip tracked since phase 1 |
| **Licensing of research-origin models** | Light-ASD, pyannote, TalkNet — **verify commercial terms before selling anything.** Flagged since phase 2 and phase 8; this is where it becomes real |
| Reference repo licences | Master plan §7: lift architectural patterns and tuning constants, write your own implementation |
| Multi-tenant security bugs | Token vault encrypted at rest; tenant isolation tested explicitly |
| `[revisit]` Plan is stale by arrival | Re-plan on arrival. This file is a direction |

## Before any of this

Two licence questions must be answered before a single customer pays you:

1. **Light-ASD / LR-ASD** — commercial use terms.
2. **pyannote 3.1** — commercial use terms.

Both are load-bearing for the quality tier that is the entire selling
proposition. Research-origin models sometimes restrict commercial use, and
finding out after launch is not recoverable. Neither blocks local single-user
work, which is why the plan defers the question — but it must be answered here.
