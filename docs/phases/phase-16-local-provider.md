# Phase 16 — Local model provider (Ollama)

**Goal:** local models become just another provider, so tier selection is config
rather than a refactor.

## Why here, not phase 0

The master plan puts this in phase 0 as "foundational plumbing, painful to
retrofit." **It isn't.** `analyze.ts` already has a provider switch
([analyze.ts:66](../../server/pipeline/analyze.ts#L66)) covering Anthropic,
OpenAI and Gemini. Adding Ollama is one `case` in that switch. Cheap now, cheap
later — so do it when it pays, which is when Content Hunt starts running hundreds
of mechanical calls a day.

## The honest framing

The goal is not "eliminate cloud models." It's **stop paying cloud prices for
mechanical work, and be able to run offline.** Full local-only would visibly hurt
the creative decisions.

## Scope

Register Ollama as a provider. One new `case`, one new env var.

## Out of scope

Tier routing and escalation — that arrives with its first real consumer in phase
19. Building the router before anything routes is the mistake this phase is
positioned to avoid.

## Changes

### `server/pipeline/analyze.ts`

```ts
export type AiProvider = "anthropic" | "openai" | "gemini" | "ollama";

async function completeOllama(prompt: string, maxTokens: number): Promise<string> {
  // Ollama exposes an OpenAI-compatible endpoint — reuse the OpenAI client
  // with a different baseURL rather than adding a dependency.
}
```

Ollama's OpenAI-compatible endpoint means the existing `openai` package handles
it with a `baseURL` change. **No new dependency.**

`.env`:
```
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_MODEL=qwen3:8b
```

### Model choice

Two rules of thumb worth internalising:

- Within a fixed memory budget, **a larger model at Q4 generally beats a smaller
  model at Q8.** Prefer quantizing up.
- For **tool-calling reliability**, the Qwen3 family is the most consistently
  recommended local option — it rarely hallucinates calls or drops parameters.

For 6 GB: a ~7–9B class model at Q4 (~5–6 GB) is the practical ceiling.

### The constraint nobody plans for

**A local LLM cannot be co-resident with the CV pipeline.** WhisperX, Light-ASD
and face detection already saturate 6 GB. Naive "just run Ollama alongside" will
OOM or silently spill layers to system RAM.

So: local LLM inference is **its own pipeline stage**, subject to the same
process-per-stage VRAM discipline as everything else. It never overlaps with CV
stages. `systemCheck` should warn if Ollama is serving while a job is running.

**Cap `num_ctx`.** Context length is a VRAM multiplier, and overflow causes
silent CPU fallback that degrades tool-call format reliability — the model still
emits calls, they just get malformed. Set it to what actually fits.

### `server/systemCheck.ts`

Add an Ollama reachability check — `warn`, never `error`. It's optional.

## Gate

1. `aiProvider: "ollama"` runs `researchTrends` and `planClips` end to end.
2. Output is schema-valid — it may be worse, it must not be malformed.
3. Ollama unreachable → clear error naming the provider, not a stack trace.
4. Cloud providers are entirely unaffected.
5. Ollama and a CV stage never hold VRAM simultaneously — confirm from `job.json`.

## Tests

- `analyze.test.ts` — the `ollama` case routes to the right client; unknown
  provider still falls back to Anthropic (existing behaviour preserved).
- Prompt builders are provider-independent — already true, assert it stays true.

## Risks

| Risk | Mitigation |
|---|---|
| Local output silently worse, ships anyway | Phase 19 adds validate-then-escalate. Until then, local is opt-in per job |
| Ollama VRAM collides with a CV stage | Its own stage; `systemCheck` warns |
| `num_ctx` overflow → malformed tool calls | Cap it explicitly; don't rely on defaults |
| Model choice churn | It's an env var |
