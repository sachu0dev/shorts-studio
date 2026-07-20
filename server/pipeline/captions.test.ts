import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmphasis, splitWordsWithTiming } from "./captions.js";

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
