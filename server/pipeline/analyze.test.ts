import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePlan, buildPlanPrompt } from "./analyze.js";

test("sanitizePlan clamps clip duration and timestamps", () => {
  const p = sanitizePlan({ index: 0, start: -5, end: 1000, captions: [] } as any, 100);
  assert.equal(p.start, 0);
  // Brief's test expected 100 here, but sanitizePlan (per the brief's own implementation,
  // matching the pre-existing inline clamp and the "20-58s clip" prompt rule) caps clip
  // length at 58s: end - start > 59 => end = start + 58. With start=0 that's 58, not 100.
  assert.equal(p.end, 58);
});

test("sanitizePlan defaults missing enum fields instead of throwing", () => {
  const p = sanitizePlan({ index: 0, start: 0, end: 20 } as any, 100);
  assert.equal(p.contentMode, "funny");
  assert.equal(p.layoutTemplate, "fullscreen");
  assert.equal(p.captionAnimation, "karaoke-reveal");
  assert.equal(p.captionPalette, "pop-white-red");
  assert.equal(p.captionFont, "Anton");
  assert.deepEqual(p.memes, []);
  assert.deepEqual(p.monetizationFlag, { risky: false, reasons: [] });
});

test("sanitizePlan preserves valid provided values", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20, contentMode: "gaming", layoutTemplate: "zoom-punch",
    monetizationFlag: { risky: true, reasons: ["profanity"] },
  } as any, 100);
  assert.equal(p.contentMode, "gaming");
  assert.equal(p.layoutTemplate, "zoom-punch");
  assert.deepEqual(p.monetizationFlag, { risky: true, reasons: ["profanity"] });
});

test("buildPlanPrompt instructs safe selection when controversialMode is false", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: false,
  });
  assert.match(prompt, /avoid clips centered on hate speech/i);
});

test("buildPlanPrompt instructs controversial content is allowed when true", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: true,
  });
  assert.match(prompt, /explicitly permitted/i);
});

test("buildPlanPrompt always requires monetizationFlag in the output schema", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: true,
  });
  assert.match(prompt, /monetizationFlag/);
});
