# Phase 22 — Script system

**Goal:** the product stops being a repurposing tool and starts being a creation
tool.

`[revisit]` — scope this down when you reach it. All three script types below are
real, but they are three different products and shipping the first one well beats
shipping three badly.

## Why now

Three genuinely different things hide under one word. Separating them is most of
the work:

### 1. Clip scripts (repurposing)

Given a chosen clip: hook line, on-screen text beats, caption emphasis, end-card
CTA. **Grounded entirely in existing footage.** Lowest risk, highest immediate
value, and it partly exists already — `planClips` produces `hook` and `script`.

Tier: T3 cloud, with a T2 local draft.

**Build this one first.** It's an upgrade to something that works.

### 2. Original video scripts (creation)

Content Hunt finds a topic → a research pass gathers sources → the script agent
writes a full script: hook, beats, B-roll suggestions, CTA.

This is the step that turns the product from *repurposing* into *creation* — a
substantially larger market position, and **something none of the incumbents in
the competitive table do.**

It's also a different product with a different failure mode. Don't blur it into
the clip-script path.

### 3. Series/format scripts

Given your top-performing formats (learned from phase 21), generate the next N
episodes in an established format. Where the learning engine actually pays off,
and the most defensible feature — it depends on *your accumulated data*, which a
competitor can't copy.

Genuinely needs phase 21 populated. It cannot be built early.

## Grounding is structural, not stylistic

**Scripts must cite their sources into the artifact.** `script/<id>.json` carries
a `sources[]` array, and the schema **requires** it — so an ungrounded claim is a
schema violation, not a style preference.

A script agent free-styling confident facts is the fastest way to burn a
channel's credibility. Making this a schema rule rather than a prompt instruction
is the difference between "we asked it not to" and "it cannot."

## Agents are stages, not a swarm

The master plan lists 8 agents. **Resist making them a free-form multi-agent
chat.** On a 6 GB laptop a chatty swarm is slow, expensive in context, and
non-deterministic in ways that make failures unreproducible.

Instead: **each agent is a pipeline stage with a typed input artifact, a typed
output artifact, and a fixed tier assignment** — the same discipline as the CV
stages. You get resumability, caching, testability, and the ability to swap a
stage's model tier without touching anything else.

| Agent | Job | Tier |
|---|---|---|
| Knowledge | topics, entities, quotes, hooks, beats from transcript | T2 local → T3 escalate |
| Script | the three types above | T3 (T2 for drafts) |
| SEO | titles, descriptions, tags, hashtags | T2 → T3 for finals |
| Research | source gathering for original scripts | T1 + rules |

Note which agents in the master plan's roster have **no LLM at all** — publishing
and quota budgeting. Keep it that way. Reserve model calls for judgment.

**Cap `num_ctx`.** Agent loops are context hogs; an agent that reads, plans,
executes and reviews can burn thousands of tokens per iteration. Overflow causes
silent CPU spill that degrades tool-call format reliability. Design agent tasks
narrow and short-context.

## Scope (recommended slice)

**Clip scripts only.** Types 2 and 3 get their own phases when you reach them.

## Contracts

```jsonc
{
  "schemaVersion": 1,
  "kind": "clip-script",
  "clipId": "clip_2",
  "hook": "ye cheez kisi ne nahi batayi",
  "beats": [ { "t": 0.0, "text": "...", "onScreen": "WAIT FOR IT" } ],
  "cta": "follow for part 2",
  "sources": [ { "type": "transcript", "ref": "clip_2", "span": [142.08, 178.44] } ],
  "tier": "T3", "escalatedFrom": "T2"
}
```

`sources` is **required and non-empty**. For clip scripts it's the transcript
span; for original scripts, URLs. Empty means the artifact is invalid.

## Gate

1. Clip scripts improve on today's `hook`/`script` output — judged against
   published clips' retention from phase 21.
2. Every script has non-empty `sources[]`. A script without them fails validation.
3. T2 local drafts escalate to T3 on schema failure.
4. Scripts sound like your channel — phase 21's voice examples are retrieved and
   used, visible in the logged prompt.
5. Hinglish scripts read naturally in romanized form.

## Tests

- `script.test.ts` — empty `sources[]` fails validation; a claim without a source
  span is rejected.
- Escalation on schema failure; no escalation on success.
- Memory retrieval is included in the prompt when phase 21 has data, and the
  prompt still builds when it doesn't.

## Risks

| Risk | Mitigation |
|---|---|
| Ungrounded confident claims | `sources[]` required by schema, not by prompt |
| Three products conflated into one | Explicitly separated; ship clip scripts alone |
| Agent swarm complexity | Agents are stages with typed artifacts, full stop |
| Context blowup on 6 GB | Narrow single-purpose tasks; capped `num_ctx` |
| `[revisit]` Scope too large | Re-slice on arrival — the recommendation is already "just type 1" |
