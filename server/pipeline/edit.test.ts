import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAss, renderClip, renderThumbnail, escapeDrawtext } from "./edit.js";
import type { TimedWord } from "./captions.js";
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
    memes: [],
    monetizationFlag: { risky: false, reasons: [] },
    ...overrides,
  };
}

/**
 * Phase 12: effects are per-segment data the compose stage writes to
 * composition/<clipId>.json, not a field on the plan. renderClip reads that
 * file back in (spread onto its own defaults) before rendering, so these
 * tests write it directly the same way a real compose stage would.
 */
function writeEffects(jobDir: string, clipId: string, effects: { t0: number; t1: number; template: string }[]) {
  const compDir = path.join(jobDir, "composition");
  mkdirSync(compDir, { recursive: true });
  writeFileSync(path.join(compDir, `${clipId}.json`), JSON.stringify({ effects }));
}

const words: TimedWord[] = [
  { word: "this", punch: false, start: 0, end: 0.9 },
  { word: "is", punch: false, start: 0.9, end: 1.02 },
  { word: "so", punch: true, start: 1.02, end: 1.5 },
  { word: "cool", punch: false, start: 1.5, end: 2.0 },
];

test("buildAss writes one Dialogue event per word plus the hook", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan(), outPath, words);
  const content = readFileSync(outPath, "utf8");
  const dialogueLines = content.split("\n").filter((l) => l.startsWith("Dialogue:"));
  // 4 words + 1 hook line = 5
  assert.equal(dialogueLines.length, 5);
});

test("buildAss emits each word at its real transcript timing, not an even split", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan(), outPath, words);
  const caps = readFileSync(outPath, "utf8").split("\n")
    .filter((l) => l.startsWith("Dialogue: 0,"))
    .map((l) => l.split(",").slice(1, 3));

  // "this" runs 0 -> 0.90 while "is" runs 0.90 -> 1.02; an even split would
  // have given both the same duration.
  assert.deepEqual(caps[0], ["0:00:00.00", "0:00:00.90"]);
  assert.deepEqual(caps[1], ["0:00:00.90", "0:00:01.02"]);
});

test("buildAss with no aligned words still writes the hook rather than throwing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan(), outPath, []);
  const lines = readFileSync(outPath, "utf8").split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(lines.length, 1);
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
  buildAss(samplePlan(), outPath, [{ word: "weird{text}\\here", punch: false, start: 0, end: 1 }]);
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

  const templates = [
    "fullscreen", "blurred-fill", "meme-corner",
    "vignette-pulse", "glitch-cut", "color-grade-pop",
    "letterbox-cinematic", "freeze-frame-callout",
  ];

  for (const [i, template] of templates.entries()) {
    const plan = samplePlan({ index: i, start: 0, end: 3, captions: [{ start: 0, end: 2, text: "test **word**" }] });
    const clipId = `clip${plan.index}`;
    writeEffects(dir, clipId, [{ t0: 0, t1: 3, template }]);
    const outPath = await renderClip(sourcePath, plan, dir, dir, () => {}, [], clipId);
    assert.ok(existsSync(outPath), `${template} did not produce an output file`);
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
      captions: [{ start: 0, end: 2, text: "test **word**" }],
      memes: [{ start: 0, end: 1, query: "shocked cat", display: "corner-overlay" }],
    });
    writeEffects(dir, `clip${plan.index}`, [{ t0: 0, t1: 3, template: "blurred-fill" }]);
    const outPath = await renderClip(sourcePath, plan, dir, dir, () => {});
    assert.ok(existsSync(outPath), "meme-compositing render did not produce an output file");
  } finally {
    (globalThis as any).fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GIPHY_API_KEY;
    else process.env.GIPHY_API_KEY = originalApiKey;
  }
});

test("escapeDrawtext neutralises text that would break the filtergraph", () => {
  // the real failure: "80% Traders Lose" made ffmpeg exit 234 mid-run
  assert.equal(escapeDrawtext("80% Traders Lose"), "80% TRADERS LOSE");
  assert.equal(escapeDrawtext("When The 0.1% Takes All"), "WHEN THE 0.1% TAKES ALL");
  // a quote or backslash would close the quoted argument early
  assert.equal(escapeDrawtext("It's \\ gone"), "ITS  GONE");
  assert.equal(escapeDrawtext("First Salary: 8.5K"), "FIRST SALARY  8.5K");
  assert.equal(escapeDrawtext("two\nlines"), "TWO LINES");
});

test("renderThumbnail survives a percent sign in the title", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "thumb-pct-"));
  const sourcePath = path.join(dir, "source.mp4");
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x480:rate=30",
    "-t", "2", "-c:v", "libx264", sourcePath,
  ]);
  const out = await renderThumbnail(
    sourcePath,
    samplePlan({ thumbnailText: "80% Traders Lose", thumbnailTimestamp: 1 }),
    dir,
    () => {}
  );
  assert.ok(existsSync(out), "a percent sign must not fail the thumbnail render");
});
