import { test } from "node:test";
import assert from "node:assert/strict";
import { snapWindow, snapPlans, MIN_CLIP, MAX_CLIP } from "./boundaries.js";
import type { TranscriptWord } from "./transcribe.js";

/** Words every 0.5s from 0 to 200s — a dense floor so "word" is always reachable. */
const words: TranscriptWord[] = Array.from({ length: 400 }, (_, i) => ({
  w: `w${i}`,
  wNative: `w${i}`,
  start: i * 0.5,
  end: i * 0.5 + 0.4,
}));

test("snaps to a scene cut when one is inside the budget", () => {
  const r = snapWindow(10.4, 40.4, [10.0], [], words);
  assert.equal(r.start, 10.0);
  assert.equal(r.snappedTo, "scene-cut");
});

test("prefers a scene cut over a nearer silence", () => {
  // silence midpoint is 10.35 (nearer) but the cut at 10.0 must win
  const r = snapWindow(10.4, 40.4, [10.0], [{ start: 10.3, end: 10.4 }], words);
  assert.equal(r.start, 10.0, "priority is cut > silence, not nearest-wins");
});

test("snaps to the MIDDLE of a silence, not its edge", () => {
  // a real silence sits BETWEEN words, so the fixture must leave an actual gap
  const gapped: TranscriptWord[] = [
    { w: "before", wNative: "before", start: 9.2, end: 10.0 },
    { w: "after", wNative: "after", start: 10.6, end: 11.2 },
    { w: "later", wNative: "later", start: 40.0, end: 40.4 },
  ];
  const r = snapWindow(10.4, 40.4, [], [{ start: 10.0, end: 10.6 }], gapped);
  assert.equal(r.start, 10.3);
  assert.equal(r.snappedTo, "silence");
});

test("falls through to a word boundary when nothing else is in budget", () => {
  const r = snapWindow(10.4, 40.4, [500], [{ start: 900, end: 901 }], words);
  assert.equal(r.snappedTo, "word");
  // 10.4 -> nearest word.start (10.5)
  assert.equal(r.start, 10.5);
});

test("a clip never starts or ends mid-word — the whole point of the phase", () => {
  const starts = new Set(words.map((w) => w.start));
  const ends = new Set(words.map((w) => w.end));
  for (const t of [10.21, 33.87, 51.02, 77.49]) {
    const r = snapWindow(t, t + 30, [], [], words);
    assert.ok(starts.has(r.start), `start ${r.start} is not a word boundary`);
    assert.ok(ends.has(r.end), `end ${r.end} is not a word boundary`);
  }
});

test("never shifts further than maxShiftSec", () => {
  const r = snapWindow(10.4, 40.4, [8.0], [], words, 1.2);
  assert.ok(Math.abs(r.start - 10.4) <= 1.2, "a cut 2.4s away is outside the budget");
  assert.notEqual(r.start, 8.0);
});

test("a snap that would push duration past the max is rejected, not applied", () => {
  // start 10, end 67 -> 57s. A cut at 9.0 would make it 58.x, over the limit.
  const r = snapWindow(10.0, 67.0, [9.0], [], []);
  assert.ok(r.end - r.start <= MAX_CLIP, `duration ${r.end - r.start} exceeds ${MAX_CLIP}`);
});

test("a snap that would drop duration below the min is rejected", () => {
  // 21s clip; snapping the start forward 1.2s would take it under 20s
  const r = snapWindow(10.0, 31.0, [11.2], [], []);
  assert.ok(r.end - r.start >= MIN_CLIP, `duration ${r.end - r.start} is under ${MIN_CLIP}`);
});

test("two adjacent clips cannot be snapped into an overlap", () => {
  const plans = [
    { index: 1, start: 10, end: 40 },
    { index: 2, start: 40.5, end: 75 },
  ];
  // a cut at 39.8 pulls clip 2's start back into clip 1
  const out = snapPlans(plans, { cuts: [39.8, 40.6], silences: [] }, words);
  const ordered = [...out].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(ordered[i].start >= ordered[i - 1].end, "clips must not overlap after snapping");
  }
});

test("snapPlans records why each boundary moved, and by how much", () => {
  const out = snapPlans([{ index: 1, start: 10.4, end: 40.4 }], { cuts: [10.0], silences: [] }, words);
  assert.equal(out[0].snappedTo, "scene-cut");
  assert.ok(out[0].shiftedBy > 0);
});

test("snapPlans is a no-op-ish passthrough when there are no signals at all", () => {
  const out = snapPlans([{ index: 1, start: 10, end: 40 }], null, []);
  assert.equal(out[0].start, 10);
  assert.equal(out[0].end, 40);
  assert.equal(out[0].snappedTo, "none");
});

test("a scene cut that lands MID-WORD is rejected, not preferred", () => {
  // the real failure: a multi-cam podcast cuts while the speaker is mid-sentence,
  // so the cut sits inside a word. 3 of 5 corpus clips started mid-word this way.
  const w: TranscriptWord[] = [
    { w: "hello", wNative: "hello", start: 10.0, end: 10.9 },
    { w: "there", wNative: "there", start: 11.0, end: 11.6 },
    { w: "friend", wNative: "friend", start: 40.0, end: 40.8 },
  ];
  const r = snapWindow(10.95, 40.8, [10.5], [], w); // 10.5 is inside "hello"
  assert.notEqual(r.start, 10.5, "must not snap into the middle of a word");
  assert.equal(r.start, 11.0, "should fall through to the word boundary");
  assert.equal(r.snappedTo, "word");
});

test("a scene cut on a word boundary is still preferred", () => {
  const w: TranscriptWord[] = [
    { w: "a", wNative: "a", start: 10.0, end: 10.4 },
    { w: "b", wNative: "b", start: 11.0, end: 11.4 },
    { w: "c", wNative: "c", start: 40.0, end: 40.5 },
  ];
  // 10.7 is in the GAP between words — a legal place to cut
  const r = snapWindow(11.0, 40.5, [10.7], [], w);
  assert.equal(r.start, 10.7);
  assert.equal(r.snappedTo, "scene-cut");
});

test("the duration fallback lands on a word boundary, never the raw LLM value", () => {
  const w: TranscriptWord[] = Array.from({ length: 200 }, (_, i) => ({
    w: `w${i}`, wNative: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4,
  }));
  // 10.23 / 68.77 are mid-word and 58.54s apart — over MAX_CLIP, forcing fallback
  const r = snapWindow(10.23, 68.77, [], [], w);
  const inside = (t: number) => w.some((x) => t > x.start + 1e-6 && t < x.end - 1e-6);
  assert.ok(!inside(r.start), `fallback start ${r.start} is mid-word`);
  assert.ok(!inside(r.end), `fallback end ${r.end} is mid-word`);
});
