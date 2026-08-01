import { test } from "node:test";
import assert from "node:assert/strict";
import {
  speakerCount, turnRate, overlapRatio, cutsInWindow, wordsInWindow, transcriptSignals,
} from "./signals.js";
import type { TranscriptWord } from "./transcribe.js";

const W = (w: string, start: number, end: number, speaker: string | null = null): TranscriptWord =>
  ({ w, wNative: w, start, end, speaker });

test("speakerCount counts distinct labelled speakers", () => {
  assert.equal(speakerCount([W("a", 0, 1, "S0"), W("b", 1, 2, "S1"), W("c", 2, 3, "S0")]), 2);
});

test("speakerCount is 0 when diarization produced no labels", () => {
  // the real case today: pyannote is gated, so every speaker is null
  assert.equal(speakerCount([W("a", 0, 1), W("b", 1, 2)]), 0);
});

test("turnRate counts speaker switches per minute", () => {
  // 3 switches over a 30s window => 6 per minute
  const words = [W("a", 0, 1, "S0"), W("b", 2, 3, "S1"), W("c", 4, 5, "S0"), W("d", 6, 7, "S1")];
  assert.equal(turnRate(words, 30), 6);
});

test("turnRate is 0 for a single speaker, never NaN", () => {
  assert.equal(turnRate([W("a", 0, 1, "S0"), W("b", 1, 2, "S0")], 30), 0);
  assert.equal(turnRate([], 30), 0);
  assert.equal(turnRate([W("a", 0, 1, "S0")], 0), 0, "zero-length window must not divide by zero");
});

test("overlapRatio measures genuine crosstalk", () => {
  // S1 talks 4-6 while S0 talks 0-5 => 1s of overlap in a 10s window
  const words = [W("a", 0, 5, "S0"), W("b", 4, 6, "S1")];
  assert.equal(overlapRatio(words, 0, 10), 0.1);
});

test("overlapRatio ignores one speaker's own overlapping words", () => {
  // same speaker twice must never look like two people talking
  const words = [W("a", 0, 5, "S0"), W("b", 4, 6, "S0")];
  assert.equal(overlapRatio(words, 0, 10), 0);
});

test("overlapRatio is 0 with no speaker labels rather than NaN", () => {
  assert.equal(overlapRatio([W("a", 0, 5), W("b", 4, 6)], 0, 10), 0);
  assert.equal(overlapRatio([], 0, 10), 0);
  assert.equal(overlapRatio([W("a", 0, 5, "S0")], 5, 5), 0, "zero-length window");
});

test("overlapRatio clamps words that extend past the window", () => {
  const words = [W("a", -10, 50, "S0"), W("b", -10, 50, "S1")];
  assert.equal(overlapRatio(words, 0, 10), 1, "fully overlapped window is 1.0, not >1");
});

test("cutsInWindow returns clip-relative cuts and drops the rest", () => {
  assert.deepEqual(cutsInWindow([5, 12.4, 30.1, 99], 10, 40), [2.4, 20.1]);
});

test("wordsInWindow keeps words straddling either edge", () => {
  const words = [W("before", 0, 5), W("straddle", 9, 11), W("in", 20, 21), W("after", 50, 51)];
  assert.deepEqual(wordsInWindow(words, 10, 40).map((w) => w.w), ["straddle", "in"]);
});

test("transcriptSignals bundles the non-CV signals for one window", () => {
  const words = [W("a", 10, 15, "S0"), W("b", 14, 16, "S1"), W("c", 20, 21, "S0")];
  const s = transcriptSignals(words, [12, 99], 10, 40);
  assert.equal(s.speakerCount, 2);
  assert.ok(s.overlapRatio > 0);
  assert.deepEqual(s.sceneCuts, [2]);
  assert.ok(s.turnRate > 0);
});
