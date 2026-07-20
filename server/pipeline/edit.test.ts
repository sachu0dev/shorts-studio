import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAss, renderClip } from "./edit.js";
import type { ClipPlan } from "../jobs.js";

function samplePlan(overrides: Partial<ClipPlan> = {}): ClipPlan {
  return {
    index: 0,
    title: "t",
    hook: "watch this",
    start: 0,
    end: 10,
    reason: "r",
    script: "s",
    hashtags: [],
    thumbnailText: "t",
    thumbnailTimestamp: 1,
    captions: [{ start: 0, end: 2, text: "this is **so** cool" }],
    contentMode: "funny",
    captionAnimation: "punch-scale-bounce",
    captionPalette: "pop-white-red",
    captionFont: "Anton",
    layoutTemplate: "fullscreen",
    memes: [],
    monetizationFlag: { risky: false, reasons: [] },
    ...overrides,
  };
}

test("buildAss writes one Dialogue event per word plus the hook", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan(), outPath);
  const content = readFileSync(outPath, "utf8");
  const dialogueLines = content.split("\n").filter((l) => l.startsWith("Dialogue:"));
  // 4 words ("this","is","so","cool") + 1 hook line = 5
  assert.equal(dialogueLines.length, 5);
});

test("buildAss embeds the chosen font and palette in the style line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan({ captionFont: "Bebas Neue" }), outPath);
  const content = readFileSync(outPath, "utf8");
  assert.match(content, /Style: Cap,Bebas Neue,/);
});

test("buildAss escapes braces and backslashes in caption text", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan({ captions: [{ start: 0, end: 1, text: "weird{text}\\here" }] }), outPath);
  const content = readFileSync(outPath, "utf8");
  assert.equal(content.includes("{text}"), false);
});

test("renderClip produces a valid mp4 for every layout template using a synthetic source", { timeout: 120_000 }, async () => {
  // Generate a tiny synthetic source video via ffmpeg's lavfi testsrc — no
  // checked-in video fixture needed.
  const dir = mkdtempSync(path.join(tmpdir(), "render-test-"));
  const sourcePath = path.join(dir, "source.mp4");
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=5:size=1280x720:rate=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "5", "-c:v", "libx264", "-c:a", "aac", sourcePath,
  ]);

  const templates: ClipPlan["layoutTemplate"][] = [
    "fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat",
    "speed-ramp", "vignette-pulse", "glitch-cut", "color-grade-pop",
    "split-screen-duo", "letterbox-cinematic", "freeze-frame-callout",
  ];

  for (const layoutTemplate of templates) {
    const plan = samplePlan({ start: 0, end: 3, layoutTemplate, captions: [{ start: 0, end: 2, text: "test **word**" }] });
    const outPath = await renderClip(sourcePath, plan, dir, () => {});
    assert.ok(existsSync(outPath), `${layoutTemplate} did not produce an output file`);
  }
});

test("renderClip composites a meme overlay into a compound layout filter_complex", { timeout: 120_000 }, async () => {
  // renderClip's meme-compositing branch (filter_complex with named pads from the
  // layout filter chained into overlay filters) never executes in the layout-template
  // smoke test above (its samplePlan always has memes: []). Exercise it for real here
  // with a synthetic source + synthetic "meme" video, using "blurred-fill" as the layout
  // since it's the compound multi-stage filter (split/named pads/`;`) the review flagged
  // as highest risk to compose incorrectly alongside meme overlay filters.
  const dir = mkdtempSync(path.join(tmpdir(), "render-meme-test-"));
  const { execFileSync } = await import("node:child_process");

  const sourcePath = path.join(dir, "source.mp4");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=5:size=1280x720:rate=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "5", "-c:v", "libx264", "-c:a", "aac", sourcePath,
  ]);

  const memeSourcePath = path.join(dir, "meme.mp4");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=red:size=320x240:duration=1:rate=30",
    "-c:v", "libx264", memeSourcePath,
  ]);
  const memeBytes = readFileSync(memeSourcePath);

  // fetchMemeAsset (called internally by renderClip with no injectable opts) hits the
  // real Giphy API + global fetch by default. Monkey-patch global.fetch for the duration
  // of this test so its default fetchFn path resolves to our synthetic local meme file
  // without any network call — same fake-response idiom memes.test.ts already uses.
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GIPHY_API_KEY;
  process.env.GIPHY_API_KEY = "test-fake-key";
  (globalThis as any).fetch = (async (url: string) => {
    if (url.includes("api.giphy.com")) {
      return new Response(JSON.stringify({
        data: [{ images: { original: { mp4: "https://giphy.example/meme.mp4" } } }],
      }));
    }
    if (url === "https://giphy.example/meme.mp4") {
      return new Response(memeBytes);
    }
    throw new Error("unexpected fetch url in test: " + url);
  }) as unknown as typeof fetch;

  try {
    const plan = samplePlan({
      start: 0,
      end: 3,
      layoutTemplate: "blurred-fill",
      captions: [{ start: 0, end: 2, text: "test **word**" }],
      memes: [{ start: 0, end: 1, query: "shocked cat", display: "corner-overlay" }],
    });
    const outPath = await renderClip(sourcePath, plan, dir, () => {});
    assert.ok(existsSync(outPath), "meme-compositing render did not produce an output file");
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GIPHY_API_KEY;
    else process.env.GIPHY_API_KEY = originalApiKey;
  }
});
