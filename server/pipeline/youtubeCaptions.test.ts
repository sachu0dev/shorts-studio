import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJson3 } from "./youtubeCaptions.js";

// Shape taken from a real yt-dlp `--sub-format json3` dump.
const SAMPLE = JSON.stringify({
  events: [
    { tStartMs: 8870, dDurationMs: 3769, segs: [{ utf8: "\n" }] },
    {
      tStartMs: 8880,
      dDurationMs: 6240,
      segs: [
        { utf8: "presents " },
        { utf8: "India's ", tOffsetMs: 840 },
        { utf8: "Got ", tOffsetMs: 1680 },
      ],
    },
    { tStartMs: 20000, dDurationMs: 1000, segs: [{ utf8: "Latent" }] },
  ],
});

test("parseJson3 reads per-word offsets off the event start", () => {
  const w = parseJson3(SAMPLE);
  assert.equal(w.length, 4);
  assert.deepEqual(w.map((x) => x.w), ["presents", "India's", "Got", "Latent"]);
  assert.equal(w[0].start, 8.88);
  assert.equal(w[1].start, 9.72); // 8880 + 840
});

test("parseJson3 drops newline-only spacer events", () => {
  assert.ok(!parseJson3(SAMPLE).some((x) => x.w === ""));
});

test("parseJson3 ends each word where the next begins", () => {
  const w = parseJson3(SAMPLE);
  assert.equal(w[0].end, w[1].start);
  assert.equal(w[1].end, w[2].start);
});

test("parseJson3 caps a trailing word instead of letting it run to the next event", () => {
  const w = parseJson3(SAMPLE);
  // "Got" would otherwise stretch 9.72s to the 20s event; 2s cap applies.
  assert.equal(w[2].end, w[2].start + 2);
  assert.ok(w[3].end > w[3].start);
});

test("parseJson3 returns nothing for malformed input rather than throwing", () => {
  assert.deepEqual(parseJson3("not json"), []);
  assert.deepEqual(parseJson3("{}"), []);
});
