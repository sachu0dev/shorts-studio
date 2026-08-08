import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePlan, buildPlanPrompt, detectShowProfile, sanitizeCompilationPlan, buildCompilationPrompt } from "./analyze.js";

test("sanitizePlan clamps clip duration and timestamps", () => {
  const p = sanitizePlan({ index: 0, start: -5, end: 1000, captions: [] } as any, 200);
  assert.equal(p.start, 0);
  // sanitizePlan caps clip length at 120s: end - start > 120 => end = start + 118.
  // videoDuration raised to 200 so that clamp (not the video-length clamp) is
  // the one actually under test.
  assert.equal(p.end, 118);
});

test("sanitizePlan defaults missing enum fields instead of throwing", () => {
  const p = sanitizePlan({ index: 0, start: 0, end: 20 } as any, 100);
  assert.equal(p.contentMode, "funny");
  assert.equal(p.captionAnimation, "karaoke-reveal");
  assert.equal(p.captionPalette, "pop-white-red");
  assert.equal(p.captionFont, "Anton");
  assert.deepEqual(p.memes, []);
  assert.deepEqual(p.monetizationFlag, { risky: false, reasons: [] });
});

test("sanitizePlan preserves valid provided values", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20, contentMode: "gaming",
    monetizationFlag: { risky: true, reasons: ["profanity"] },
  } as any, 100);
  assert.equal(p.contentMode, "gaming");
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

test("detectShowProfile recognizes India's Got Latent from the video title", () => {
  assert.ok(detectShowProfile("INDIA'S GOT LATENT S2 EP4 ft. Karan Aujla, Tanmay Bhat"));
  assert.ok(detectShowProfile("India's Got Latent Episode 12"));
});

test("detectShowProfile returns undefined for an unrelated or missing title", () => {
  assert.equal(detectShowProfile("Some Random Podcast Episode 5"), undefined);
  assert.equal(detectShowProfile(undefined), undefined);
  assert.equal(detectShowProfile(""), undefined);
});

test("buildPlanPrompt includes the show guide when one is detected", () => {
  const withGuide = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: false, showGuide: "SHOW FORMAT — test guide",
  });
  assert.match(withGuide, /SHOW FORMAT — test guide/);

  const withoutGuide = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: false,
  });
  assert.doesNotMatch(withoutGuide, /SHOW FORMAT — test guide/);
});

test("buildPlanPrompt always requires monetizationFlag in the output schema", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: true,
  });
  assert.match(prompt, /monetizationFlag/);
});

test("sanitizePlan strips commas and newlines from captionFont", () => {
  const p = sanitizePlan({ index: 0, start: 0, end: 20, captionFont: "Anton,\nEvil\rInjection" } as any, 100);
  assert.equal(p.captionFont, "AntonEvilInjection");
});

test("sanitizePlan defaults captionFont to Anton when missing", () => {
  const p = sanitizePlan({ index: 0, start: 0, end: 20 } as any, 100);
  assert.equal(p.captionFont, "Anton");
});

test("sanitizePlan drops memes with end <= start", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20,
    memes: [{ start: 5, end: 5, query: "q", display: "corner-overlay" }],
  } as any, 100);
  assert.deepEqual(p.memes, []);
});

test("sanitizePlan drops memes with out-of-range timings", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20,
    memes: [
      { start: -1, end: 5, query: "q", display: "corner-overlay" }, // start < 0
      { start: 5, end: 999, query: "q", display: "corner-overlay" }, // end > clip duration
      { start: NaN, end: 5, query: "q", display: "corner-overlay" }, // non-numeric
    ],
  } as any, 100);
  assert.deepEqual(p.memes, []);
});

test("sanitizePlan defaults an invalid meme display mode to corner-overlay", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20,
    memes: [{ start: 1, end: 3, query: "shocked cat", display: "explode-screen" }],
  } as any, 100);
  assert.equal(p.memes.length, 1);
  assert.equal(p.memes[0].display, "corner-overlay");
});

test("sanitizePlan passes through valid memes unchanged", () => {
  const meme = { start: 1, end: 3, query: "shocked cat", display: "pip-bounce" };
  const p = sanitizePlan({ index: 0, start: 0, end: 20, memes: [meme] } as any, 100);
  assert.deepEqual(p.memes, [meme]);
});

// ── compilations ────────────────────────────────────────────────────────────

test("sanitizeCompilationPlan rejects a single-segment compilation", () => {
  const p = sanitizeCompilationPlan(
    { index: 1, theme: "t", segments: [{ start: 0, end: 5 }] } as any, 100
  );
  assert.equal(p, null);
});

test("sanitizeCompilationPlan keeps valid segments, clamps a too-long one to video duration then the per-moment cap", () => {
  const p = sanitizeCompilationPlan(
    {
      index: 1, theme: "best", title: "Best Moments", hook: "watch", segments: [
        { start: 5, end: 10 }, { start: 20, end: 200 }, { start: 50, end: 55 },
      ],
    } as any, 100
  );
  assert.ok(p);
  assert.equal(p!.segments.length, 3);
  // {20,200} clamps to {20,100} against videoDuration (80s), which itself
  // exceeds the 20s per-moment cap, so it shrinks again to {20,40}.
  assert.equal(p!.segments[1].end, 40);
});

test("sanitizeCompilationPlan drops a segment shorter than the minimum", () => {
  const p = sanitizeCompilationPlan(
    { index: 1, theme: "t", segments: [{ start: 0, end: 0.5 }, { start: 5, end: 10 }, { start: 20, end: 25 }] } as any, 100
  );
  assert.ok(p);
  assert.equal(p!.segments.length, 2); // the 0.5s segment is below the minimum
});

test("sanitizeCompilationPlan caps a segment longer than the per-moment maximum", () => {
  const p = sanitizeCompilationPlan(
    { index: 1, theme: "t", segments: [{ start: 0, end: 40 }, { start: 50, end: 55 }] } as any, 100
  );
  assert.ok(p);
  assert.equal(p!.segments[0].end - p!.segments[0].start, 20); // capped at MAX_SEGMENT
});

test("sanitizeCompilationPlan sorts segments by start time", () => {
  const p = sanitizeCompilationPlan(
    { index: 1, theme: "t", segments: [{ start: 50, end: 55 }, { start: 5, end: 10 }] } as any, 100
  );
  assert.ok(p);
  assert.equal(p!.segments[0].start, 5);
  assert.equal(p!.segments[1].start, 50);
});

test("buildCompilationPrompt asks for 2 to 4 themed compilations and includes the show guide", () => {
  const prompt = buildCompilationPrompt({
    transcript: "t", trendBrief: "b", videoDuration: 3000, controversialMode: false,
    showGuide: "SHOW FORMAT — test guide",
  });
  assert.match(prompt, /2 to 4/);
  assert.match(prompt, /SHOW FORMAT — test guide/);
});
