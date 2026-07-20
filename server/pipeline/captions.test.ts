import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmphasis, splitWordsWithTiming, buildWordOverrideTags, buildStyleLine, PALETTES } from "./captions.js";

test("parseEmphasis strips ** markers and flags punch words", () => {
  const result = parseEmphasis("this is **so** cool");
  assert.deepEqual(result, [
    { word: "this", punch: false },
    { word: "is", punch: false },
    { word: "so", punch: true },
    { word: "cool", punch: false },
  ]);
});

test("parseEmphasis handles no markers", () => {
  const result = parseEmphasis("plain text here");
  assert.deepEqual(result, [
    { word: "plain", punch: false },
    { word: "text", punch: false },
    { word: "here", punch: false },
  ]);
});

test("parseEmphasis handles multi-word emphasis spans", () => {
  const result = parseEmphasis("**wait for it**");
  assert.deepEqual(result, [
    { word: "wait", punch: true },
    { word: "for", punch: true },
    { word: "it", punch: true },
  ]);
});

test("splitWordsWithTiming interpolates evenly across the group window", () => {
  const words = splitWordsWithTiming({ start: 10, end: 12, text: "four little test words" });
  assert.equal(words.length, 4);
  assert.equal(words[0].word, "four");
  assert.equal(words[0].start, 10);
  assert.equal(words[3].end, 12);
  // each word gets an equal 0.5s slice of the 2s window
  assert.ok(Math.abs(words[1].start - 10.5) < 0.001);
  assert.ok(Math.abs(words[2].start - 11) < 0.001);
});

test("splitWordsWithTiming carries punch flags through", () => {
  const words = splitWordsWithTiming({ start: 0, end: 1, text: "no **way** dude" });
  assert.deepEqual(words.map((w) => w.punch), [false, true, false]);
});

test("PALETTES has all 6 palettes with valid ASS color format", () => {
  const names = ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"] as const;
  for (const name of names) {
    const p = PALETTES[name];
    assert.ok(p, `missing palette ${name}`);
    for (const key of ["normal", "punch", "outline", "back"] as const) {
      assert.match(p[key], /^&H[0-9A-Fa-f]{8}$/, `${name}.${key} is not a valid ASS color`);
    }
  }
});

test("buildWordOverrideTags applies punch color+scale only to punch words", () => {
  const punch = buildWordOverrideTags({ word: "wow", punch: true, start: 0, end: 1 }, "punch-scale-bounce", "hype-yellow");
  const normal = buildWordOverrideTags({ word: "ok", punch: false, start: 0, end: 1 }, "punch-scale-bounce", "hype-yellow");
  assert.match(punch, /\\fscx1[3-9]\d/); // scaled up
  assert.equal(normal.includes("\\fscx1"), false); // no upscale on normal words
});

test("buildWordOverrideTags produces a distinct tag shape per animation", () => {
  const word = { word: "hi", punch: false, start: 0, end: 1 };
  const karaoke = buildWordOverrideTags(word, "karaoke-reveal", "pop-white-red");
  const typewriter = buildWordOverrideTags(word, "typewriter", "pop-white-red");
  const slide = buildWordOverrideTags(word, "slide-up", "pop-white-red");
  const shake = buildWordOverrideTags(word, "shake", "pop-white-red");
  const glitch = buildWordOverrideTags(word, "glitch-rgb-split", "pop-white-red");
  assert.ok(karaoke.includes("\\fad"));
  assert.equal(typewriter.includes("\\fad"), false); // instant cut-in, no fade
  assert.match(slide, /\\move\(/);
  assert.match(shake, /\\frz/);
  assert.match(glitch, /\\1c&H|\\3c&H/); // color-channel override present
});

test("buildStyleLine embeds font name and size", () => {
  const line = buildStyleLine("minimal-clean", "Inter", 64);
  assert.match(line, /^Style: Cap,Inter,64,/);
});
