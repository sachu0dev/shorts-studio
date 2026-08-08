import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmphasis, wordsForClip, buildWordOverrideTags, buildStyleLine, groupWordsIntoPhrases, PALETTES } from "./captions.js";
import type { TranscriptWord } from "./transcribe.js";

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

const W = (w: string, start: number, end: number): TranscriptWord => ({ w, wNative: w, start, end });

test("wordsForClip uses real transcript timings, NOT an even split", () => {
  // deliberately uneven: "aaaa" is long, the rest are short
  const words = [W("aaaa", 10.0, 11.4), W("b", 11.4, 11.6), W("c", 11.6, 11.75), W("d", 11.75, 12.0)];
  const out = wordsForClip(words, { start: 10, end: 12, captions: [] });

  assert.equal(out.length, 4);
  assert.deepEqual(out.map((w) => w.word), ["aaaa", "b", "c", "d"]);
  // clip-relative
  assert.equal(out[0].start, 0);
  assert.equal(out[3].end, 2);
  // the old interpolation would have made every word exactly 0.5s
  const durations = out.map((w) => +(w.end - w.start).toFixed(3));
  assert.deepEqual(durations, [1.4, 0.2, 0.15, 0.25]);
  assert.ok(new Set(durations).size > 1, "durations must not be uniform");
});

test("wordsForClip holds a word through a short silence so captions do not flicker", () => {
  // 80ms of real silence between the two words
  const words = [W("hello", 0, 0.32), W("there", 0.40, 0.70)];
  const out = wordsForClip(words, { start: 0, end: 5, captions: [] });
  assert.equal(out[0].end, 0.40, "the first word should hold until the second starts");
  assert.equal(out[0].start, 0, "the start — which is what drives sync — must be untouched");
});

test("wordsForClip leaves a real pause as a real pause", () => {
  const words = [W("before", 0, 0.4), W("after", 3.0, 3.4)];
  const out = wordsForClip(words, { start: 0, end: 5, captions: [] });
  assert.equal(out[0].end, 0.4, "a 2.6s silence must not be papered over");
});

test("wordsForClip applies the LLM's punch marks to aligned words", () => {
  const words = [W("no", 0, 0.4), W("way", 0.4, 1.0), W("dude", 1.0, 1.4)];
  const out = wordsForClip(words, { start: 0, end: 2, captions: [{ text: "no **way** dude" }] });
  assert.deepEqual(out.map((w) => w.punch), [false, true, false]);
});

test("wordsForClip matches punch marks ignoring case and punctuation", () => {
  const words = [W("Way,", 0, 0.5)];
  const out = wordsForClip(words, { start: 0, end: 2, captions: [{ text: "**way**" }] });
  assert.equal(out[0].punch, true);
});

test("wordsForClip keeps only words inside the clip window and clamps overlaps", () => {
  const words = [W("before", 0, 5), W("inside", 12, 13), W("straddle", 19.5, 21), W("after", 30, 31)];
  const out = wordsForClip(words, { start: 10, end: 20, captions: [] });
  assert.deepEqual(out.map((w) => w.word), ["inside", "straddle"]);
  assert.equal(out[1].end, 10, "a word crossing the end is clamped to the clip length");
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

test("groupWordsIntoPhrases groups 1-word tokens into 3-4 word phrase cards", () => {
  const words = [
    { word: "Karan,", punch: false, start: 0, end: 0.28 },
    { word: "thank", punch: false, start: 0.28, end: 0.47 },
    { word: "you", punch: false, start: 0.47, end: 0.86 },
    { word: "so", punch: false, start: 0.86, end: 0.98 },
    { word: "much", punch: false, start: 0.98, end: 1.56 },
  ];
  const groups = groupWordsIntoPhrases(words, 4);
  assert.ok(groups.length >= 2);
  assert.ok(
    groups[0].words.length >= 2,
    `"Karan," must not be orphaned as its own one-word card, got ${groups[0].words.length} word(s)`
  );
});

test("a comma-ending word does not orphan itself as a one-word card", () => {
  // Real-world regression: "Karan," is the FIRST word after a break and ends
  // in a comma — the old rule closed the group right there, producing a
  // one-word flash disconnected from the sentence. Measured on a real
  // 19-clip batch: 37.7% of all caption cards were a single word before this
  // fix. It must merge with at least one more word instead.
  const words = [
    { word: "buddy.", punch: false, start: 4.88, end: 5.10 },
    { word: "Thank", punch: false, start: 5.10, end: 5.20 },
    { word: "you", punch: false, start: 5.20, end: 5.30 },
  ];
  const groups = groupWordsIntoPhrases(words, 4);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].words.length, 3);
});

test("groupWordsIntoPhrases still breaks on punctuation once the group has at least 2 words", () => {
  const words = [
    { word: "okay", punch: false, start: 0, end: 0.2 },
    { word: "cool,", punch: false, start: 0.2, end: 0.4 },
    { word: "let's", punch: false, start: 0.4, end: 0.6 },
    { word: "go", punch: false, start: 0.6, end: 0.8 },
  ];
  const groups = groupWordsIntoPhrases(words, 4);
  assert.equal(groups[0].words.length, 2); // "okay cool," closes on the comma once the 2-word minimum is met
  assert.equal(groups[1].words.length, 2); // "let's go"
});

test("a genuine trailing single word at the end of the clip is still its own card — nothing left to merge with", () => {
  const words = [
    { word: "one", punch: false, start: 0, end: 0.2 },
    { word: "two", punch: false, start: 0.2, end: 0.4 },
    { word: "three", punch: false, start: 0.4, end: 0.6 },
    { word: "four", punch: false, start: 0.6, end: 0.8 },
    { word: "five", punch: false, start: 1.5, end: 1.7 },
  ];
  const groups = groupWordsIntoPhrases(words, 4);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].words.length, 4);
  assert.equal(groups[1].words.length, 1); // ran out of words after the maxWords break — unavoidable
});
