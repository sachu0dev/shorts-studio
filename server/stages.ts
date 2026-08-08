import type { Artifact, Store } from "./artifacts.js";

export interface StageTiming {
  name: string;
  status: "done" | "error";
  ms: number;
  peakVramMb: number;
  cached: boolean;
}

export interface StageCtx {
  jobId: string;
  store: Store;
  log: (line: string) => void;
  timings: StageTiming[];
  /** Called after every timing change so job.json stays current on disk. */
  onTiming?: (t: StageTiming) => void | Promise<void>;
  /** If aborted, runStage throws immediately before starting any new stage. */
  signal?: AbortSignal;
}

export interface Stage<I, O extends Artifact> {
  name: string;
  /** Artifact path relative to the job dir, e.g. "transcript.json". */
  output: string;
  schemaVersion: number;
  run(ctx: StageCtx, input: I): Promise<O>;
}

/** Peak VRAM is self-reported by Python stages; CPU/Node stages report 0. */
function peakVramOf(out: Artifact): number {
  const v = (out as { peakVramMb?: unknown }).peakVramMb;
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

async function record(ctx: StageCtx, t: StageTiming): Promise<void> {
  const i = ctx.timings.findIndex((x) => x.name === t.name);
  if (i >= 0) ctx.timings[i] = t;
  else ctx.timings.push(t);
  await ctx.onTiming?.(t);
}

/**
 * Idempotency (CLAUDE.md rule 4) enforced once, here, for every stage:
 * skip if the artifact exists at the right schemaVersion, otherwise run,
 * time it, and write atomically.
 */
export async function runStage<I, O extends Artifact>(
  stage: Stage<I, O>,
  ctx: StageCtx,
  input: I
): Promise<O> {
  // Bail out immediately if the user stopped the job before this stage began.
  if (ctx.signal?.aborted) {
    throw new DOMException("Job stopped by user", "AbortError");
  }

  const existing = await ctx.store.readJson<O>(ctx.jobId, stage.output);
  if (existing && existing.schemaVersion === stage.schemaVersion) {
    ctx.log(`[${stage.name}] cached — skipping`);
    await record(ctx, { name: stage.name, status: "done", ms: 0, peakVramMb: peakVramOf(existing), cached: true });
    return existing;
  }

  const t0 = Date.now();
  try {
    const out = await stage.run(ctx, input);
    if (out.schemaVersion !== stage.schemaVersion) {
      throw new Error(
        `stage "${stage.name}" returned schemaVersion ${out.schemaVersion}, expected ${stage.schemaVersion}`
      );
    }
    await ctx.store.writeJson(ctx.jobId, stage.output, out);
    await record(ctx, {
      name: stage.name,
      status: "done",
      ms: Date.now() - t0,
      peakVramMb: peakVramOf(out),
      cached: false,
    });
    return out;
  } catch (e) {
    await record(ctx, { name: stage.name, status: "error", ms: Date.now() - t0, peakVramMb: 0, cached: false });
    throw e;
  }
}
