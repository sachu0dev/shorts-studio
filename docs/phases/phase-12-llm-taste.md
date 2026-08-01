# Phase 12 — LLM taste layer (per-segment)

**Goal:** the LLM refines the edit — which layout inside what's allowed, which
effect on which beat — without ever being able to choose something impossible.

## Why now

Everything before this made the edit *correct*. This makes it *good*. It comes
last in the composition work because the LLM needs facts to reason over, and
phases 4–11 are what produce them.

## Decision 5 — effects are per-segment, synced to the layoutTimeline

Today the LLM picks **one** `layoutTemplate` for a whole clip. That changes to
per-segment choices aligned to the router's segments and scene cuts — zoom-punch
on the hook, colour-grade on the payoff. Much closer to a human edit.

## Carried over from phase 6 — `speed-ramp`, if it is worth reviving

Phase 6 deleted the template rather than ship its desync again. Reviving it is
**only sensible here**, because this is where effects become per-segment data
and a ramp is exactly that: `[{t0, t1, factor}]`.

The audio fix alone is not enough, and that is the trap. Slowing video shifts
every burned `.ass` event after the ramp *and* every meme window, so a correct
`speed-ramp` needs one piecewise time map applied in three places:

1. video — emit `factor` copies of each frame inside the window (`render.py`);
2. audio — `atrim`/`atempo`/`concat` over the same windows, not one global `atempo`;
3. **timings** — word starts/ends and the hook in `buildAss`, plus `MemeOverlay`
   `start`/`end`, all mapped through the same function.

If any of the three is skipped the result is the phase-6 bug wearing a different
hat. It is one decorative template out of eleven; skipping it permanently is a
legitimate answer.

## Carried over from phase 1 — fix `plan.index` here

`sanitizePlan` passes the model's `index` through unvalidated, and `edit.ts`
names files `clip<index>.mp4`. **Two plans claiming the same index silently
overwrite each other's clip** — you get fewer outputs than you asked for with no
error. Observed values are inconsistent already: the live run returned `1` while
the existing tests use `0`.

Fix when this phase rewrites the planning path: **take the index from the array
position (1-based), never from the model.** Deliberately deferred in phase 1 to
keep that phase's "changes nothing a viewer can see" gate honest.

## The contract with the model

The router hands the LLM **facts + allowed modes, never raw video**:

> "2 face tracks. 31% speech overlap. 8.2 turns/min. Motion moderate. Scene cuts
> at 12.4s, 30.1s. Composition type: multi-speaker. Allowed modes:
> `camera-switch`, `split-screen`. Segments proposed: [0–12.4 →SPEAKER_00],
> [12.4–20.1 overlap], [20.1–36.3 →SPEAKER_01]. Transcript with word timings and
> speakers: …"

It returns a refined `layoutTimeline` and per-segment effects. **It cannot invent
a mode outside `allowedModes`** — the validator drops anything that isn't in the
list. That is `CLAUDE.md` rule 3, enforced in code rather than in the prompt.

## Graceful degradation is structural

If the LLM call fails, times out, or returns malformed JSON, **the deterministic
output from phases 7–11 is already a valid shippable layout.** Not a fallback
that has to be built — it is what the pipeline produced before this phase
existed. That's the entire architectural argument for doing the taste layer last.

## Scope

Prompt, response validation, and merging the LLM's choices onto the router's
timeline.

## Out of scope

Clip selection and captions — that's the existing `planClips`, unchanged.
Caption styling polish is phase 13.

## Changes

### `server/pipeline/taste.ts` (new)

```ts
export function buildTastePrompt(comp: Composition, analysis: Analysis, words: Word[]): string;
export function validateTasteResponse(raw: unknown, comp: Composition): Composition;
```

Both pure. `buildTastePrompt` is a pure string builder for the same reason
`buildPlanPrompt` already is in [analyze.ts:180](../../server/pipeline/analyze.ts#L180) —
it makes the prompt testable without an API call.

`validateTasteResponse` is where the guarantees live. Every rule below drops the
offending item and keeps the router's value, and every drop is logged:

| Check | On failure |
|---|---|
| Mode ∈ `allowedModes` | drop segment, keep router's |
| `target` is a real track id from phase 4 | drop segment |
| `split-screen` only when both tracks are bound | drop segment |
| Segments contiguous, no gaps, no overlaps | rebuild from router timeline |
| Segment ≥ min-hold | merge into neighbour |
| Segment boundaries within ~0.2 s of a scene cut, where one exists | snap to the cut |
| Effect template ∈ the valid list | drop the effect, keep the segment |
| Effect windows within clip bounds | clamp, mirroring `sanitizeMemes` |
| Whole response unparseable | **keep the router timeline entirely** |

This mirrors `sanitizePlan`'s existing philosophy — default-fill and clamp
everything, never throw. Extend that function's approach rather than inventing a
second validation style.

### `server/pipeline/analyze.ts` — remove `layoutTemplate` from `planClips`

The per-clip `layoutTemplate` field and its prompt line are deleted. Effects are
now chosen here, per segment, with the composition facts in hand — choosing them
during clip planning meant choosing them blind.

`ClipPlan.layoutTemplate` is removed; `Composition.effects[]` replaces it.

### Effect selection guidance in the prompt

Constrain, don't just offer a list of 12:

- At most **one effect per segment**. Stacked effects look cheap.
- `zoom-punch` belongs on hooks and payoffs, not throughout.
- `color-grade-pop` is clip-wide or not at all — flickering grade looks broken.
- `glitch-cut` and `shake-on-beat` only at scene cuts or punch words.
- Effects may align to `**punch**` words already marked in the captions — the
  emphasis markers are a beat map that already exists.

### Emphasis refinement

The LLM may also revise which words are `punch`. Cheap, and it's now making that
call with the composition in front of it rather than from the transcript alone.

## Contracts

`composition/<clipId>.json` extended:

```jsonc
{
  "layoutTimeline": [ /* ... refined, same shape ... */ ],
  "effects": [
    { "t0": 0.0,  "t1": 2.2,  "template": "zoom-punch", "reason": "hook" },
    { "t0": 8.2,  "t1": 19.6, "template": "color-grade-pop" }
  ],
  "taste": {
    "applied": true,
    "provider": "anthropic",
    "rejected": [ { "segment": 2, "why": "mode 'split-screen' not in allowedModes" } ],
    "fellBackToRouter": false
  }
}
```

`rejected[]` is the honest record of what the model tried and the validator
refused. It is how you find out the prompt needs work.

## Gate

1. **A malformed LLM response still renders** — force it with a stubbed provider
   returning garbage, confirm the clip renders using router output and
   `fellBackToRouter: true`.
2. **A response requesting `split-screen` on a one-face clip is rejected** and
   logged in `rejected[]`. Test it explicitly with a stubbed response.
3. Effects change through a clip and align to scene cuts or punch words.
4. Side by side with phase 11 output on the corpus: the taste pass is a visible
   improvement, not just a change. If it isn't, refine the prompt before moving on.
5. No segment gaps or overlaps after merging — same assertion as phase 9.
6. Timeline is unchanged when the provider is unreachable (offline test).

## Tests

`taste.test.ts` — pure, no API:
- mode outside `allowedModes` → dropped, router's kept
- `target` that isn't a real track → dropped
- segment below min-hold → merged
- gap in returned timeline → rebuilt from router
- unparseable JSON → router timeline returned unchanged, `applied: false`
- effect not in the valid list → dropped, segment survives
- effect window outside clip bounds → clamped
- `buildTastePrompt` includes `allowedModes` and never includes a disallowed mode

## Risks

| Risk | Mitigation |
|---|---|
| LLM output looks worse than the deterministic edit | Gate item 4; `applied: false` is a supported outcome, not a defeat |
| Prompt grows unwieldy with per-segment detail | Send signals and segment summaries, not raw tracks — it never sees video |
| Validation drops so much the pass is pointless | `rejected[]` measures exactly that; fix the prompt, never loosen the validator |
| Token cost per clip rises | It's one call per clip on facts, not frames; phase 16 can demote it to a local tier |
| Effects overlap layout transitions awkwardly | Effect windows are validated against segment boundaries |
