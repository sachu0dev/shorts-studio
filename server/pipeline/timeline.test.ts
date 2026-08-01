import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayoutTimeline, buildSplitAwareTimeline, TIMELINE } from "./timeline.js";
import { PRESETS } from "./camera.js";
import type { AsdScores } from "./binding.js";

const STEP = 0.25;

/** activeTrack samples: [trackId, seconds] runs, concatenated. */
function active(...runs: [number | null, number][]): (number | null)[] {
  return runs.flatMap(([id, secs]) => Array(Math.round(secs / STEP)).fill(id));
}

const tl = (a: (number | null)[], cuts: number[], duration: number, fallback: number | null = 1) =>
  buildLayoutTimeline(a, STEP, cuts, duration, "camera-switch", fallback);

/** Every gap or overlap in the timeline is a black frame in the render. */
function assertContiguous(segments: { t0: number; t1: number }[], duration: number) {
  assert.ok(segments.length > 0, "empty timeline");
  assert.equal(segments[0].t0, 0);
  assert.equal(segments[segments.length - 1].t1, duration);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].t0, segments[i - 1].t1, `gap or overlap at segment ${i}`);
  }
  for (const s of segments) assert.ok(s.t1 > s.t0, `zero-length segment at ${s.t0}`);
}

test("a backchannel shorter than min-hold produces no segment", () => {
  // Speaker 1 holds; speaker 2 says "yeah" for 0.5s. This is the phase's
  // headline failure mode, and the whole reason min-hold exists.
  const a = active([1, 6], [2, 0.5], [1, 5.5]);
  const t = tl(a, [], 12);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].target, 1);
  assert.equal(t.suppressedSwitches > 0, true);
  assertContiguous(t.segments, 12);
});

test("a turn longer than min-hold does become a segment", () => {
  const a = active([1, 6], [2, 6]);
  const t = tl(a, [], 12);
  assert.deepEqual(t.segments.map((s) => [s.t0, s.target]), [[0, 1], [6, 2]]);
  assert.equal(t.suppressedSwitches, 0);
  assert.equal(t.heldSegments, 2);
  assertContiguous(t.segments, 12);
});

test("a switch inside the opening min-hold window is deferred, not dropped", () => {
  // Speaker 2 takes over 1s in, before the first segment has earned its hold —
  // so the cut waits until min-hold elapses instead of never happening.
  const a = active([1, 1], [2, 11]);
  const t = tl(a, [], 12);
  assert.deepEqual(t.segments.map((s) => [s.t0, s.target]), [[0, 1], [TIMELINE.minHold, 2]]);
  assert.equal(t.suppressedSwitches, 1, "one rejected turn, not one per sample");
});

test("a scene cut always begins a new segment, even mid-hold", () => {
  // The cut lands 1s in — well inside min-hold. The cut is a fact about the
  // source; min-hold is a preference, and it does not get to override one.
  const a = active([1, 12]);
  const t = tl(a, [1], 12);
  assert.deepEqual(t.segments.map((s) => [s.t0, s.t1, s.snapped ?? false]), [[0, 1, false], [1, 12, true]]);
  assertContiguous(t.segments, 12);
});

test("a cut re-decides the target immediately rather than waiting out the hold", () => {
  const a = active([1, 4], [2, 8]);
  const t = tl(a, [4], 12);
  assert.deepEqual(t.segments.map((s) => [s.t0, s.target]), [[0, 1], [4, 2]]);
  assert.equal(t.segments[1].snapped, true);
});

test("a null active track holds the previous target instead of emitting a segment", () => {
  // Nobody speaking, or a speaker bound off-camera. Cutting to the nearest
  // visible face is confidently wrong; being late is merely late.
  const a = active([1, 4], [null, 4], [1, 4]);
  const t = tl(a, [], 12);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].target, 1);
});

test("an all-null active track falls back to presence and says so", () => {
  const t = tl(active([null, 12]), [], 12, 9);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].target, 9);
  assert.equal(t.segments[0].targetSource, "presence");
});

test("with no ASD target and no fallback, the segment simply has none", () => {
  const t = tl(active([null, 6]), [], 6, null);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].target, undefined);
  assert.equal(t.segments[0].targetSource, undefined);
});

test("fast crosstalk suppresses many switches and still covers the clip", () => {
  const runs: [number | null, number][] = [];
  for (let i = 0; i < 24; i++) runs.push([i % 2 ? 2 : 1, 0.5]);
  const t = tl(active(...runs), [], 12);
  assert.ok(t.suppressedSwitches > 5, `only ${t.suppressedSwitches} suppressed`);
  assertContiguous(t.segments, 12);
  // and every segment it did emit is at least min-hold long
  for (const s of t.segments.slice(0, -1)) {
    assert.ok(s.t1 - s.t0 >= TIMELINE.minHold - 1e-9, `segment ${s.t0}-${s.t1} is under min-hold`);
  }
});

test("cuts closer together than min-hold still each get a segment", () => {
  const t = tl(active([1, 12]), [1, 2, 3], 12);
  assertContiguous(t.segments, 12);
  assert.equal(t.segments.length, 4);
});

test("duplicate and out-of-range cuts do not produce zero-length segments", () => {
  const t = tl(active([1, 12]), [-1, 0, 5, 5, 12, 99], 12);
  assertContiguous(t.segments, 12);
  assert.equal(t.segments.length, 2);
});

// ── phase 10: split-screen ────────────────────────────────────────────────────

/** [value, seconds] runs, concatenated — the score-array analogue of `active()`. */
function scoreRuns(...runs: [number, number][]): number[] {
  return runs.flatMap(([v, secs]) => Array(Math.round(secs / STEP)).fill(v));
}

const SPEAKING = 0.9;
const QUIET = 0.1;
const split = (activeTrack: (number | null)[], scores: AsdScores, duration: number, cuts: number[] = []) =>
  buildSplitAwareTimeline(activeTrack, scores, [1, 2], STEP, cuts, duration, 1);

test("a split segment shorter than min-hold is absorbed", () => {
  const scores: AsdScores = {
    1: scoreRuns([SPEAKING, 12]),
    2: scoreRuns([QUIET, 5], [SPEAKING, 1], [QUIET, 6]),
  };
  const t = split(active([1, 12]), scores, 12);
  assert.equal(t.segments.length, 1);
  assert.equal(t.segments[0].mode, "camera-switch");
  assert.equal(t.suppressedSwitches > 0, true);
});

test("targets ordering is stable across every split segment in the clip", () => {
  // Two separate crosstalk windows, each long enough to earn a segment,
  // separated by turn-taking in between.
  const scores: AsdScores = {
    1: scoreRuns([SPEAKING, 3], [QUIET, 4], [SPEAKING, 3], [QUIET, 2]),
    2: scoreRuns([SPEAKING, 3], [QUIET, 4], [SPEAKING, 3], [QUIET, 2]),
  };
  const t = split(active([1, 12]), scores, 12);
  const splits = t.segments.filter((s) => s.mode === "split-screen");
  assert.ok(splits.length >= 2, `expected at least 2 split segments, got ${splits.length}`);
  for (const s of splits) assert.deepEqual(s.targets, [1, 2]);
});

test("a scene cut inside a split segment ends it", () => {
  const scores: AsdScores = { 1: scoreRuns([SPEAKING, 8]), 2: scoreRuns([SPEAKING, 8]) };
  const t = split(active([1, 8]), scores, 8, [4]);
  assert.deepEqual(
    t.segments.map((s) => [s.t0, s.t1, s.mode, s.snapped ?? false]),
    [[0, 4, "split-screen", false], [4, 8, "split-screen", true]]
  );
});

test("calm cuts less than dynamic on the same turn-taking clip", () => {
  // 12 alternating 1.8s turns: long enough for dynamic (1.5s), short for calm (2.5s).
  const runs: [number | null, number][] = [];
  for (let i = 0; i < 12; i++) runs.push([i % 2 ? 2 : 1, 1.8]);
  const a = active(...runs);
  const calm = buildLayoutTimeline(a, STEP, [], 21.6, "camera-switch", 1, PRESETS.calm.minHold);
  const dyn = buildLayoutTimeline(a, STEP, [], 21.6, "camera-switch", 1, PRESETS.dynamic.minHold);
  assert.ok(calm.heldSegments < dyn.heldSegments,
    `calm ${calm.heldSegments} should cut less than dynamic ${dyn.heldSegments}`);
  assert.ok(calm.suppressedSwitches > dyn.suppressedSwitches);
});
