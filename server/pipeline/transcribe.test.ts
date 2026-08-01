import { test } from "node:test";
import assert from "node:assert/strict";
import { wordsToSegments, type TranscriptWord } from "./transcribe.js";

const W = (
  w: string,
  start: number,
  end: number,
  speaker: string | null = null,
  wNative = w
): TranscriptWord => ({ w, wNative, start, end, speaker });

test("wordsToSegments never lets one segment span two speakers", () => {
  const segs = wordsToSegments([
    W("hello", 0, 0.4, "SPEAKER_00"),
    W("there", 0.4, 0.8, "SPEAKER_00"),
    W("hi", 0.85, 1.2, "SPEAKER_01"),
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, "hello there");
  assert.equal(segs[0].speaker, "SPEAKER_00");
  assert.equal(segs[1].speaker, "SPEAKER_01");
});

test("wordsToSegments breaks on a long pause", () => {
  const segs = wordsToSegments([W("one", 0, 0.3), W("two", 0.3, 0.6), W("later", 5.0, 5.4)]);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].text, "later");
});

test("wordsToSegments breaks on sentence-final punctuation", () => {
  const segs = wordsToSegments([W("done.", 0, 0.3), W("next", 0.35, 0.7)]);
  assert.equal(segs.length, 2);
});

test("wordsToSegments carries segment boundaries from the real word timings", () => {
  const segs = wordsToSegments([W("a", 1.25, 1.5), W("b", 1.5, 2.75)]);
  assert.equal(segs[0].start, 1.25);
  assert.equal(segs[0].end, 2.75);
});

test("wordsToSegments keeps native text alongside the romanized text", () => {
  const segs = wordsToSegments([W("namaste", 0, 0.4, null, "नमस्ते"), W("dosto", 0.4, 0.8, null, "दोस्तों")]);
  assert.equal(segs[0].text, "namaste dosto");
  assert.equal(segs[0].textNative, "नमस्ते दोस्तों");
});

test("wordsToSegments splits runs that would otherwise get too long", () => {
  // 20 words, no pauses, no punctuation — must still be chunked
  const words = Array.from({ length: 20 }, (_, i) => W(`w${i}`, i * 0.2, i * 0.2 + 0.2));
  const segs = wordsToSegments(words);
  assert.ok(segs.length > 1, "a 20-word run must not become one segment");
  for (const s of segs) assert.ok(s.text.split(" ").length <= 14);
});

test("wordsToSegments returns nothing for an empty transcript", () => {
  assert.deepEqual(wordsToSegments([]), []);
});
