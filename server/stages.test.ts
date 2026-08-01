import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore, type Artifact } from "./artifacts.js";
import { runStage, type Stage, type StageCtx } from "./stages.js";

interface Out extends Artifact { value: number }

function ctx(): StageCtx {
  const s = new LocalStore(mkdtempSync(path.join(tmpdir(), "stages-")));
  return { jobId: "job1", store: s, log: () => {}, timings: [] };
}

const counting = (schemaVersion = 1) => {
  let runs = 0;
  const stage: Stage<void, Out> = {
    name: "count",
    output: "count.json",
    schemaVersion,
    async run() {
      runs++;
      return { schemaVersion, value: runs };
    },
  };
  return { stage, runs: () => runs };
};

test("second run with an existing artifact is skipped", async () => {
  const c = ctx();
  const { stage, runs } = counting();

  const a = await runStage(stage, c, undefined);
  const b = await runStage(stage, c, undefined);

  assert.equal(runs(), 1, "stage body must not run twice");
  assert.deepEqual(a, b);
  assert.equal(c.timings[0].cached, true, "the second run must be recorded as cached");
});

test("a schemaVersion bump forces a re-run", async () => {
  const c = ctx();
  await runStage(counting(1).stage, c, undefined);

  const v2 = counting(2);
  const out = await runStage(v2.stage, c, undefined);

  assert.equal(v2.runs(), 1, "the v2 stage must actually run");
  assert.equal(out.schemaVersion, 2);
});

test("a stage returning the wrong schemaVersion fails loudly", async () => {
  const c = ctx();
  const stage: Stage<void, Out> = {
    name: "wrong",
    output: "wrong.json",
    schemaVersion: 2,
    async run() {
      return { schemaVersion: 1, value: 0 };
    },
  };
  await assert.rejects(() => runStage(stage, c, undefined), /expected 2/);
  assert.equal(await c.store.exists("job1", "wrong.json"), false, "no artifact may be written");
});

test("a crashing stage writes no artifact, so it re-runs rather than caching a lie", async () => {
  const c = ctx();
  const stage: Stage<void, Out> = {
    name: "boom",
    output: "boom.json",
    schemaVersion: 1,
    async run() {
      throw new Error("kaboom");
    },
  };

  await assert.rejects(() => runStage(stage, c, undefined), /kaboom/);
  assert.equal(await c.store.exists("job1", "boom.json"), false);
  assert.equal(c.timings[0].status, "error");

  // and no half-written temp file was left where the skip check could find it
  const dir = (c.store as LocalStore).jobDir("job1");
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
});

test("timings record wall time and peak VRAM, and onTiming fires", async () => {
  const c = ctx();
  const seen: string[] = [];
  c.onTiming = (t) => void seen.push(t.name);

  const stage: Stage<void, Out & { peakVramMb: number }> = {
    name: "gpu",
    output: "gpu.json",
    schemaVersion: 1,
    async run() {
      return { schemaVersion: 1, value: 1, peakVramMb: 3120 };
    },
  };

  await runStage(stage, c, undefined);
  assert.equal(c.timings[0].peakVramMb, 3120);
  assert.equal(typeof c.timings[0].ms, "number");
  assert.deepEqual(seen, ["gpu"]);
});

test("a CPU-only stage reports 0 VRAM instead of failing", async () => {
  const c = ctx();
  const { stage } = counting();
  await runStage(stage, c, undefined);
  assert.equal(c.timings[0].peakVramMb, 0);
});

test("re-running a stage updates its timing in place rather than duplicating it", async () => {
  const c = ctx();
  const { stage } = counting();
  await runStage(stage, c, undefined);
  await runStage(stage, c, undefined);
  assert.equal(c.timings.length, 1);
});
