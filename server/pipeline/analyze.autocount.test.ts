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
  assert.match(p, /GENUINELY supports/);
  assert.match(p, /Do NOT pad/);
});

test("auto caps the range by video length, never below 1", () => {
  // 600s / 90 = 6
  assert.match(buildPlanPrompt({ ...base, clipCount: 0 }), /between 1 and 6\b/);
  // a very short video must still allow one clip rather than zero
  assert.match(buildPlanPrompt({ ...base, clipCount: 0, videoDuration: 40 }), /between 1 and 1\b/);
  // and a very long one is capped at 10 rather than scaling forever
  assert.match(buildPlanPrompt({ ...base, clipCount: 0, videoDuration: 20_000 }), /between 1 and 10\b/);
});
