import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanPrompt } from "./analyze.js";

const base = {
  transcript: "[0.0-5.0] hello",
  trendBrief: "brief",
  descriptionSection: "",
  videoDuration: 600,
  controversialMode: false,
};

test("a fixed clipCount still asks for exactly that many", () => {
  const p = buildPlanPrompt({ ...base, clipCount: 3 });
  assert.match(p, /choose exactly 3 clips/);
  assert.match(p, /JSON array of 3 objects/);
});

test("clipCount 0 means auto — the model judges how many the video supports", () => {
  const p = buildPlanPrompt({ ...base, clipCount: 0 });
  assert.doesNotMatch(p, /choose exactly/);
  assert.match(p, /HIGH EXTRACTION EFFORT/);
  assert.match(p, /Never pad the count/);
});

test("auto caps the range by video length, never below 1", () => {
  // 600s / 90 = 6 max, 600s / 240 = 2 min
  assert.match(buildPlanPrompt({ ...base, clipCount: 0 }), /between 2 and 6\b/);
  // a very short video must still allow at least one clip
  assert.match(buildPlanPrompt({ ...base, clipCount: 0, videoDuration: 40 }), /between 1 and 2\b/);
  // and a long one is capped at 30, not left unbounded
  assert.match(buildPlanPrompt({ ...base, clipCount: 0, videoDuration: 20_000 }), /between 30 and 30\b/);
});

test("windowed auto planning scopes the range to the section, not the whole video", () => {
  // A 15-minute (900s) window of a much longer video gets its own range —
  // not the full video's — so a long show doesn't get told "find 30" in
  // every single section.
  const p = buildPlanPrompt({ ...base, clipCount: 0, videoDuration: 5400, autoRangeDuration: 900 });
  assert.match(p, /between 3 and 10\b/);
});
