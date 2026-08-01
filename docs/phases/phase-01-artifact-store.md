# Phase 1 — Artifact store + stage runner

**Goal:** every pipeline stage reads and writes typed JSON on disk, and a stage
whose output already exists is skipped.

> **Status: built 2026-08-01. All four gates pass.** Measured: a `kill -9`
> mid-render followed by resume skipped 45s of download + LLM work and re-ran
> only the render; a second full run took **0s**; the re-render was
> **byte-identical**. See *What actually happened*.

## Why now

This is the spine. Rule 1 of `CLAUDE.md` — *stages talk through artifacts, never
memory* — is what makes stages resumable now and distributable in phase 23.
Retrofitting it after six stages exist is a rewrite; building it before any of
them exist is a day.

The immediate payoff is concrete: today a crash in render re-runs transcription.

## Scope

Storage adapter, artifact schemas v1, stage runner, instrumentation. **No change
to what the pipeline produces** — same clips out, same quality.

## Out of scope

WhisperX (phase 2). Any new stage. The Python worker's *models* — this phase
builds the harness they plug into and one trivial Python stage to prove it works.

## Changes

### `server/artifacts.ts` (new)

```ts
export interface Artifact { schemaVersion: number }

export interface Store {
  path(jobId: string, rel: string): string;
  exists(jobId: string, rel: string): Promise<boolean>;
  readJson<T extends Artifact>(jobId: string, rel: string): Promise<T | null>;
  writeJson<T extends Artifact>(jobId: string, rel: string, v: T): Promise<void>;
  writeStream(jobId: string, rel: string): NodeJS.WritableStream;
}
```

One implementation, `LocalStore`, wrapping `fs` under `STORAGE_DIR`. **Never let
a stage touch `fs` or `path.join(STORAGE, ...)` directly** — that single rule is
what makes S3 a config change in phase 23 rather than a refactor.

> Yes, this is an interface with one implementation, which phase rules normally
> forbid. It earns the exception because master plan §5 names it as the one
> abstraction that must exist from day one, and because the second
> implementation is already specified.

### `server/stages.ts` (new)

```ts
export interface Stage<I, O extends Artifact> {
  name: string;
  output: string;              // e.g. "transcript.json" or "analysis/{clipId}.json"
  run(ctx: StageCtx, input: I): Promise<O>;
}

export async function runStage<I, O extends Artifact>(
  stage: Stage<I, O>, ctx: StageCtx, input: I
): Promise<O>
```

`runStage` does exactly four things:
1. If `output` exists and its `schemaVersion` matches, read and return it — **skip**.
2. Otherwise run, timing wall clock and sampling peak VRAM.
3. Write the artifact atomically (temp file + `rename`, so a crash mid-write
   never leaves a half-artifact that the skip check would then trust).
4. Append a `StageTiming` to `job.json`.

Idempotency is `CLAUDE.md` rule 4 and it is enforced here, once, for everyone.

### `server/pipeline/python.ts` (new)

One helper that invokes `$WORKER_PYTHON worker/stages/<name>.py --job <dir>` via
the existing `run()` from `download.ts`, and surfaces a readable error when the
worker exits non-zero. Every Python stage from phase 2 on goes through this.

### `worker/stages/_base.py` (new)

Argument parsing, artifact read/write, timing + `torch.cuda.max_memory_allocated()`
reporting, and the mandatory teardown from master plan §2.2:

```python
del model; gc.collect(); torch.cuda.empty_cache()
```

Plus `worker/stages/probe.py` — a trivial stage that writes `{"schemaVersion":1,
"ok":true}` and reports VRAM. It exists only to prove the Node↔Python↔artifact
loop before phase 2 puts a 3 GB model behind it.

### `server/index.ts`

`runPipeline` is rewritten to call `runStage` per step. Job dir layout becomes
the contract:

```
storage/<jobId>/
  job.json                    # status, stages[], timings, peak VRAM
  source.mp4                  # normalized ≤1080p
  audio.wav                   # 16 kHz mono
  transcript.json             # phase 2
  clips.json                  # LLM-chosen windows
  analysis/<clipId>.json      # phase 4
  composition/<clipId>.json   # phase 7
  out/<clipId>.mp4
  out/<clipId>_thumb.jpg
```

Job state moves from the in-memory `Map` in `jobs.ts` to `job.json` on disk. The
`Map` stays as a cache and the SSE `EventEmitter` is unchanged — the UI keeps
working exactly as it does.

## Contracts

`job.json`:

```jsonc
{
  "schemaVersion": 1,
  "id": "abc123",
  "status": "running",
  "input": { "url": "...", "clipCount": 3, "aiProvider": "anthropic" },
  "stages": [
    { "name": "ingest", "status": "done", "ms": 41200, "peakVramMb": 0, "cached": false },
    { "name": "transcribe", "status": "done", "ms": 98400, "peakVramMb": 3120, "cached": true }
  ]
}
```

**`schemaVersion` is mandatory on every artifact.** A version mismatch means the
skip check misses and the stage re-runs — which is the correct, safe behaviour.

## Gate

1. Start a job, `kill -9` during render, restart with the same job id → download,
   transcribe and planning are all skipped; only render re-runs. Verify from
   `job.json` that `cached: true` on the skipped stages.
2. Same input twice → second run is a near-no-op.
3. Output clips are byte-identical to phase 0's baseline. **This phase must
   change nothing a viewer can see.**
4. `job.json` shows a wall time and peak VRAM for every stage.

## Tests

- `stages.test.ts` — skip-on-existing-artifact; re-run on `schemaVersion` bump;
  crash mid-write leaves no artifact (atomic rename).
- `artifacts.test.ts` — `LocalStore` path containment: a `clipId` of `../../etc`
  must not escape the job dir.

## What actually happened

Built as planned: `artifacts.ts` (`Store` + `LocalStore`), `stages.ts`
(`runStage`), `pipeline/python.ts`, `worker/stages/_base.py` + `probe.py`, and
`runPipeline` rewritten into five stages. The probe reported **11 MiB peak VRAM**
through the Node→Python→artifact→timing path, so the harness phase 2 plugs into
is proven before a 3 GB model goes behind it.

### Gate results

| Gate | Result |
|---|---|
| `kill -9` mid-render → only render re-runs | ✅ ingest/transcribe/trends/plan all `cached: true` |
| Same input twice → near-no-op | ✅ **0s**, all five stages cached |
| Output byte-identical | ✅ same md5 after deleting only the render artifact |
| Wall time + peak VRAM per stage | ✅ in `job.json` |

Skipped work on resume: ingest 11.7s + trends 13.3s + plan 20.0s ≈ **45s**, plus
the LLM calls that cost money.

### Deviations from the plan

- **`transcript.json` exists now**, not in phase 2. Gate 1 requires transcription
  to be skippable, which requires it to be an artifact. Phase 2 replaces its
  *producer*, not its existence.
- **`POST /api/jobs/:id/resume` added.** The gate says "restart with the same job
  id" but no endpoint could do that. `loadJobs()` rebuilds the map from disk at
  boot, and a job left `running` by a crash is restored as `error` — a dead
  process is not still working.
- **Artifact paths are relative to the job dir**, not absolute. Absolute paths
  would not survive the move to object storage in phase 23.

### Two bugs the gate caught

1. **`clipId` was `clip${plan.index + 1}` while `edit.ts` writes
   `clip${plan.index}`.** `plan.index` is 1-based, so the artifact key and the
   real filename disagreed — caching would have keyed off a file that did not
   exist. The same off-by-one was in the UI, which read *"Editing clip 2/1"*.
   Both fixed.
2. **The first gate run was invalid** and looked like a pass. `kill -9` hit the
   `npx` wrapper rather than the node child, so the server never died and the
   "restarted" run was the original process still going. The gate script now
   kills whatever holds the port and verifies the port is actually free.

`plan.index` is passed through from the LLM unvalidated (`sanitizePlan`), so two
clips sharing an index would collide on filename. Pre-existing, out of scope
here, worth fixing when phase 12 rewrites the planning path.

## Risks

| Risk | Mitigation |
|---|---|
| Over-abstracting the runner before real stages exist | Exactly one implementation of each interface until phase 23 forces a second |
| Half-written artifact trusted by the skip check | Atomic temp+rename; assert it in a test |
| Peak VRAM unreadable when a stage is CPU-only | Report `0`, don't fail |
| Job state on disk drifting from the in-memory map | Disk is authoritative; the map is a read cache rebuilt from disk on boot |
