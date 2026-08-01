# Phase 25 — Clip quality gate

**Goal:** the system refuses to publish a clip that isn't genuinely a clip.

`[revisit]` — every threshold in this phase is a guess until phase 27 measures
it against real retention. Build the mechanism; expect the numbers to move.

## Why now

Block A made clips *look* right — framed, captioned, cut on clean boundaries.
None of that answers the question that actually matters:

> Is this a self-contained moment worth someone's attention, or is it 40 seconds
> sawn out of the middle of a conversation?

A clip can be perfectly framed, perfectly captioned, cut exactly on a scene
boundary — and still open with *"…and that's why he did it"*, referring to a
name spoken four minutes earlier. The edit is flawless. The clip is worthless.
Nothing built so far can tell the difference, because everything so far measures
the *rendering*, and this is a property of the *content*.

This is also the gate that makes multi-channel (26) survivable. Publishing five
channels of automated output without a quality floor is how a channel gets
buried, and — per phase 26's research — how it fails YouTube's inauthentic
content review.

## Scope

Two layers of scoring, a three-way verdict, and the archive state. Runs after
render, before publish.

## Out of scope

Learning the weights from outcomes — phase 27. Re-editing a bad clip; this phase
judges, it does not fix. Choosing a channel — phase 26.

## The design decision that carries the phase

**Judge the clip with exactly the information a viewer has.**

The obvious implementation hands the model the clip transcript *and* the
surrounding context so it can "understand" the moment. That implementation is
worthless, and predictably so: given the context, the model resolves the dangling
pronoun, follows the argument, and rates the clip coherent. It has just proved
that the clip makes sense *to someone who watched the previous four minutes* —
which is the one audience the clip will never have.

So the judge sees the clip transcript, the first-3-second hook, and nothing else.
No source title, no surrounding transcript, no description, no plan `reason`. If
the judge can't tell what's going on, neither can the viewer.

This is testable, and it should be tested: feed the judge a clip plus its
context, and the same clip alone, and assert the scores differ. If they don't,
context is leaking.

## Changes

### Layer 1 — deterministic disqualifiers (`server/quality/checks.ts`)

`CLAUDE.md` rule 3: deterministic rules own facts. These are facts, they need no
model, and they are what actually catch "random cut from the video". Every one
runs off artifacts that already exist — word-level timings from phase 2,
boundaries from phase 3, signals from phase 4.

| Check | Evidence | Why it disqualifies |
|---|---|---|
| `mid-sentence-start` | phase 3 wrote `snappedTo: "none"`, or the first word is >0.3 s into a word run | The single loudest "random cut" signal |
| `dangling-reference` | first sentence opens with an unbound pronoun or connective — *he, she, they, that, this, so, and, but, because, which, anyway* — with no antecedent in the clip | The actual signature of a mid-conversation cut |
| `unresolved-question` | a question in the first 40% with no answer-shaped clause after it | Sets up a payoff the clip never delivers |
| `orphan-answer` | an answer-shaped opening (*"exactly", "no, definitely not"*) with no question | The inverse, and just as common |
| `dead-air` | words-per-second below the band for its language | Nothing is happening |
| `no-payoff-tail` | >6 s after the last content-bearing sentence | Retention bleeds out the end |
| `speaker-split-open` | speaker changes inside the first sentence | Cut landed mid-exchange |

Disqualifiers are **hard**. A clip carrying one cannot reach `publish` no matter
what the model says. The judge scores taste; it does not get a vote on facts.

Language-aware: the Hinglish corpus needs its own connective list and its own
words-per-second band. Reuse the phase-2 detected language rather than assuming
English — this is the same mistake the phase-4 gate made about face coverage.

### Layer 2 — the judge (`server/quality/judge.ts`)

T2 local via phase 16, escalating to cloud on schema-invalid output — phase 20's
ladder, unchanged. Four sub-scores, 0–1, each with a one-line reason:

| Sub-score | The question | Grounded in |
|---|---|---|
| `hook` | Does the first 3 seconds make a stranger stop scrolling? | Heaviest ranking signal — see below |
| `standalone` | Does this make sense with no prior context? | The dangling-reference family, judged rather than pattern-matched |
| `payoff` | Does it deliver something — a fact, a laugh, a turn? | "Did we waste our time" |
| `pacing` | Does it sustain for its length, or sag? | Watch-through thresholds below |

**Transparent sub-scores, never one opaque number** — the rule phase 20 already
established. "Score 82" is unactionable; "strong hook, no payoff" tells you
whether to publish it.

### Algorithm awareness — what it actually means

The scorer is meant to know how Shorts distribution works. Concretely, from
current published understanding of the ranking signals (see *Research*), that
reduces to four checkable things — not vibes:

1. **The first 3 seconds decide distribution.** Viewed-vs-swiped in the opening
   is the heaviest signal. So `hook` is weighted highest, and a clip whose
   interesting sentence arrives at 0:09 is marked down even if it's excellent —
   it will be swiped before anyone reaches it.
2. **Watch-through thresholds are duration-dependent.** Roughly ~65% for sub-30s
   and ~50% for 30–60s. A 55-second clip whose payoff lands at 0:12 has 43
   seconds of decay ahead of it; the same content cut to 25 seconds clears a
   higher bar more easily. The scorer should therefore recommend a **shorter
   window**, not just reject — a suggestion phase 12 can act on.
3. **No dead tail.** Every second after the payoff is retention lost, and the
   `no-payoff-tail` check exists for exactly this.
4. **Re-watch and share correlate with a single crisp idea**, not with density.
   A clip carrying one surprising claim outperforms one carrying four.

**These numbers are public-domain creator consensus, not measurements from your
channel.** They are starting values in a config file with a comment saying so.
Phase 27 replaces them with your own.

### Verdict — three states, not two

```ts
export type Verdict = "publish" | "review" | "archive";
```

Two states would force a threshold to be right on day one, when it is a guess.
Three states put the guess where it is cheap: the `review` band is handed to a
human, which is exactly what phase 28's dashboard is for.

Start **permissive**. Only clips with a hard disqualifier or a composite far
below the floor go to `archive`; the band is wide on purpose. It narrows as
phase 27 produces evidence, and narrowing it is a config change with a recorded
date and reason.

The failure mode people don't anticipate is over-rejection. A system that quietly
archives good clips generates no complaint and no data — you never see what you
lost. Under-rejection is visible and correctable; over-rejection is neither.

### Archive is a state, never a deletion

`clip.state = 'archived'`. The row stays, the file stays, the reasons stay, and
phase 28 can restore it in one click. Nothing in this phase deletes anything.

An archived clip is also *evidence*: phase 27's exploration slice publishes some
of them deliberately, to find out whether the scorer was right.

## Contracts

`quality/<clipId>.json`:

```jsonc
{
  "schemaVersion": 1,
  "clipId": "clip3",
  "verdict": "review",
  "disqualifiers": [
    { "check": "dangling-reference", "detail": "opens 'and that's why he…' — no antecedent in clip" }
  ],
  "subScores": {
    "hook":       { "score": 0.42, "reason": "opens on a subordinate clause; first claim at 0:07" },
    "standalone": { "score": 0.30, "reason": "'he' is never named" },
    "payoff":     { "score": 0.81, "reason": "concrete number delivered at 0:22" },
    "pacing":     { "score": 0.55, "reason": "12s of setup for a 38s clip" }
  },
  "composite": 0.51,
  "suggestion": { "action": "retrim", "start": 6.4, "reason": "payoff-relative window would clear the 30s threshold" },
  "modelTier": "T2-local",
  "escalated": false,
  "thresholdsVersion": "2026-08-01"
}
```

`thresholdsVersion` is load-bearing. Without it, phase 27 cannot tell which
verdicts came from which calibration, and the whole feedback loop is
uninterpretable.

## Gate

The honest test is a ranking test, not an accuracy test:

1. Take **20 clips you have already produced**. Rank them yourself, blind, worst
   to best. Score them. **Rank correlation is the gate** — absolute scores don't
   matter and shouldn't be tuned.
2. A deliberately sabotaged clip — 40 s cut from the middle of a monologue with
   no boundary snapping — is `archive`, and the reason names the actual defect.
3. A known-good clip is `publish`.
4. The judge **cannot** promote a clip carrying a hard disqualifier. Assert it
   directly.
5. Judge-with-context and judge-without-context produce different scores on a
   context-dependent clip. If they match, context is leaking and gate 1 is
   meaningless.
6. Local T2 handles the majority; escalation is logged with its reason.
7. Every verdict is explainable from `quality/<clipId>.json` alone.
8. Scoring adds **< 5 s per clip** and holds no VRAM while a CV stage runs
   (phase 16's co-residency rule).

## Tests

`checks.test.ts` — pure, fixture transcripts, no model:
- each disqualifier fires on its own fixture and on nothing else
- `dangling-reference` does **not** fire when the antecedent is inside the clip
  (the false-positive case that would reject good clips)
- Hinglish fixture uses the Hinglish connective list, not the English one
- a clip with zero words returns disqualified, never `NaN`

`judge.test.ts` — injected fake model:
- schema-invalid output escalates; valid output does not
- the prompt provably contains no source title, surrounding transcript or plan
  `reason` (assert on the built prompt string — this is the phase's core property)
- a hard disqualifier caps the verdict regardless of returned sub-scores
- composite degrades sanely when one sub-score is missing

## Risks

| Risk | Mitigation |
|---|---|
| **Over-rejection, invisibly** | Three-way verdict; start permissive; archive is restorable; phase 27 publishes an exploration slice specifically to detect this |
| Judge agrees with itself, not with viewers | It is calibrated against realized retention in phase 27 — until then, treat it as a ranker, not an oracle |
| Context leaks into the judge's prompt | Asserted in a test, not documented in a comment |
| Thresholds are creator folklore | Labelled as such in config; replaced by measurement in 27 |
| Local model too weak to judge taste | Escalate on schema failure; log local pass rate and demote the task permanently only if the data supports it |
| Scoring what's measurable rather than what performs | Sub-scores stay visible and the human keeps the override — same answer as phase 20 |
| `[revisit]` Weights guessed at build time | Config with a `thresholdsVersion` stamped into every verdict |

## Research

Signals and thresholds above are drawn from current published analyses of Shorts
ranking, treated as **starting hypotheses to be replaced by phase 27's
measurements**, not as facts about your channel:

- Ranking signal ordering and the viewed-vs-swiped emphasis:
  [Metricool — YouTube Shorts Algorithm](https://metricool.com/youtube-shorts-algorithm/),
  [Socialync — What Pushes Views Now](https://www.socialync.io/blog/youtube-shorts-algorithm-2026)
- Duration-dependent watch-through thresholds (~65% sub-30s, ~50% for 30–60s):
  [Shortimize — Shorts Retention Rate](https://www.shortimize.com/blog/youtube-shorts-retention-rate)
- Hook / flow / value / trend as a scoring decomposition, and "self-contained
  moment" as the selection unit — the incumbent's public description of its own
  virality score:
  [OpusClip — What is the Virality Score](https://help.opus.pro/docs/article/virality-score)
