# Phase 17 — T0 embeddings service (CPU)

**Goal:** cheap semantic similarity, always available, running on CPU.

## Why now

Everything in Content Hunt depends on this, and it's the one local workload that
is genuinely free: **CPU-only, so it runs concurrently with GPU stages.** That
property is the whole reason embeddings sit at tier 0 — high-volume, mechanical,
objectively checkable work that never competes for the 6 GB.

## Scope

An embedding function, a local vector store, and similarity search. No consumers
yet.

## Out of scope

Content Hunt itself (19–20). Creator Memory (21). This phase builds the
capability those spend.

## Changes

### `server/embeddings.ts` (new)

```ts
export async function embed(texts: string[]): Promise<Float32Array[]>;
export function cosineSim(a: Float32Array, b: Float32Array): number;
```

Model: a small sentence-embedding model (BGE / MiniLM / nomic-embed class),
384–768 dims. **CPU only — explicitly, not incidentally.** If it ever touches
CUDA, the property that makes it useful is gone.

Two runtime options:
- Via Ollama (phase 16) with an embedding model — no new dependency, reuses the
  provider work.
- Via `transformers.js` / ONNX in-process — one dependency, no service to run.

Prefer Ollama if phase 16 is already working. Fewer moving parts beats fewer
network hops.

Batch aggressively. Embedding 500 titles one at a time is the difference between
seconds and minutes, and 500/day is the actual Content Hunt volume.

### Vector store

SQLite with a `vectors` table: `id`, `kind`, `dims`, `vec` (BLOB), `meta` (JSON).
Brute-force cosine scan over the whole table.

> `# ponytail: brute-force O(n) scan. Fine to ~100k vectors on this CPU.
> Upgrade path: sqlite-vec or a real ANN index if the corpus outgrows it.`

At Content Hunt's volume — hundreds of videos a day — brute force is correct.
An ANN index here would be complexity bought against a problem that doesn't exist.

> **Superseded by phase 24.** SQLite now arrives in
> [phase 24](phase-24-source-catalog.md), which runs before phase 6 — the source
> catalog needs a queryable store earlier than Content Hunt does. **Open that
> database and add a `vectors` table to it; do not create a second file.** Two
> SQLite databases in one project is two backup stories and two places to look
> when a number is wrong. Phase 23 still migrates the one DB to Postgres.

Job state stays files regardless — artifacts are authoritative for anything a
stage produces (`CLAUDE.md` rule 1). The database holds what a per-job file
cannot answer: cross-job queries.

### Cache by content hash

Embedding the same text twice is pure waste, and Content Hunt re-screens the same
videos daily. Key on a hash of the input text — this is `CLAUDE.md` rule 4
applied to a non-pipeline component.

## Contracts

```jsonc
{ "id": "yt:dQw4w9WgXcQ:title", "kind": "video-title", "dims": 384,
  "meta": { "videoId": "dQw4w9WgXcQ", "embeddedAt": 1753900000000, "model": "bge-small" } }
```

Store the model name. Vectors from different models are not comparable, and
mixing them silently produces nonsense similarity scores.

## Gate

1. 500 short texts embed in **under 30 s on CPU**.
2. Runs concurrently with a GPU render stage with no VRAM impact — confirm from
   `job.json`.
3. Similarity is sane: near-duplicate titles score >0.9, unrelated <0.4.
4. Re-embedding identical text is a cache hit.
5. Query over 10k stored vectors returns in well under a second.

## Tests

- `embeddings.test.ts` — `cosineSim` is 1.0 for identical vectors, 0 for
  orthogonal, symmetric, and handles zero vectors without `NaN`.
- Cache hit on repeated text.
- Store round-trips a vector without precision loss.
- Vectors from a different model are excluded from search results.

## Risks

| Risk | Mitigation |
|---|---|
| Model quietly uses GPU | Assert CPU-only device at load |
| Brute-force scan too slow later | Documented upgrade path; the `ponytail:` comment names the ceiling |
| Mixing models in one store | Model name stored and filtered on |
| Embedding quality poor for Hinglish | Test with romanized Hinglish titles specifically — this is the actual corpus |
