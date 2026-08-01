import assert from "node:assert/strict";
import test from "node:test";
import { classify, CLASSIFY_THRESHOLDS, type CompositionType } from "./classify.js";
import type { Signals } from "./signals.js";

/** Everything absent is "nothing measured"; each case overrides only what it means. */
function sig(over: Partial<Signals>): Signals {
  return {
    faceCoverage: 0,
    distinctFaceTracks: 0,
    rawTrackCount: 0,
    medianConcurrentFaces: 0,
    maxConcurrentFaces: 0,
    subjectMotion: 0,
    facesFitOneCrop: true,
    faceSizeRatio: 0,
    speakerCount: 0,
    wordCount: 0,
    overlapRatio: 0,
    turnRate: 0,
    sceneCuts: [],
    ...over,
  };
}

// The first three rows are the real phase-4 corpus measurements, not invented
// numbers. If the detector or its thresholds move, these are what must still hold.
const cases: { name: string; s: Partial<Signals>; expect: CompositionType }[] = [
  {
    name: "solo talking-head (measured)",
    s: { faceCoverage: 0.51, faceSizeRatio: 0.2, medianConcurrentFaces: 1, subjectMotion: 0.052, wordCount: 90 },
    expect: "talking-head",
  },
  {
    name: "podcast (measured)",
    s: { faceCoverage: 1.0, faceSizeRatio: 0.29, medianConcurrentFaces: 2, distinctFaceTracks: 3, wordCount: 120 },
    expect: "multi-speaker",
  },
  {
    name: "gaming with facecam (measured) — coverage looks like a talking head",
    s: { faceCoverage: 0.99, faceSizeRatio: 0.12, medianConcurrentFaces: 1, wordCount: 80 },
    expect: "screen-rec",
  },
  {
    name: "gaming without facecam",
    s: { faceCoverage: 0.02, faceSizeRatio: 0, medianConcurrentFaces: 0, wordCount: 80 },
    expect: "screen-rec",
  },
  {
    name: "silent montage",
    s: { faceCoverage: 0.05, wordCount: 0 },
    expect: "b-roll",
  },
  {
    name: "interview: one speaker, silent listener in frame",
    s: { faceCoverage: 0.95, faceSizeRatio: 0.25, medianConcurrentFaces: 2, speakerCount: 1, wordCount: 100 },
    expect: "talking-head",
  },
];

for (const c of cases) {
  test(`classify: ${c.name}`, () => {
    const got = classify(sig(c.s));
    assert.equal(got.type, c.expect);
    assert.ok(got.reason.length > 0, "reason must be non-empty");
    assert.ok(got.confidence > 0 && got.confidence <= 1);
  });
}

test("exactly on the faceCoverage threshold is NOT screen-rec", () => {
  // `< 0.2` is exclusive, so 0.2 falls through to the face branches. Documented
  // so the boundary can't drift silently.
  const got = classify(sig({ faceCoverage: CLASSIFY_THRESHOLDS.faceCoverage, faceSizeRatio: 0.25, medianConcurrentFaces: 1, wordCount: 10 }));
  assert.equal(got.type, "talking-head");
});

test("ambiguous coverage band reports low confidence", () => {
  const got = classify(sig({ faceCoverage: 0.18, wordCount: 40 }));
  assert.equal(got.type, "screen-rec");
  assert.ok(got.confidence < 0.6, `expected low confidence, got ${got.confidence}`);
});

test("facecam right on the size boundary reports low confidence", () => {
  const got = classify(sig({ faceCoverage: 0.9, faceSizeRatio: 0.14, medianConcurrentFaces: 1, wordCount: 40 }));
  assert.equal(got.type, "screen-rec");
  assert.ok(got.confidence < 0.6, `expected low confidence, got ${got.confidence}`);
});

test("two faces with no speaker labels is multi-speaker, but under 0.6", () => {
  // Today's real state: diarization is gated, so speakerCount reads 0 on every
  // job. CV is trusted, and the confidence says why it shouldn't be trusted much.
  const got = classify(sig({ faceCoverage: 1.0, faceSizeRatio: 0.29, medianConcurrentFaces: 2, speakerCount: 0, wordCount: 120 }));
  assert.equal(got.type, "multi-speaker");
  assert.ok(got.confidence < 0.6);
  assert.match(got.reason, /no speaker labels/);
  assert.match(got.reason, /diarization unavailable/);
});

test("all-zero signals never throw", () => {
  const got = classify(sig({}));
  assert.equal(got.type, "b-roll");
  assert.ok(got.reason.length > 0);
});

// ── phase 8: ASD is a speaker count that owes nothing to diarization ──────────

test("ASD lifts a two-face clip past the routing floor while pyannote stays gated", () => {
  // What every real job looks like today: faces on screen, zero speaker labels.
  const gated = sig({ faceCoverage: 0.98, faceSizeRatio: 0.29, medianConcurrentFaces: 2, speakerCount: 0 });
  const before = classify(gated);
  assert.equal(before.confidence, 0.55, "the pre-ASD ceiling moved — the test below is meaningless now");

  const after = classify({ ...gated, asdSpeakerCount: 2 });
  assert.equal(after.type, "multi-speaker");
  assert.ok(after.confidence >= 0.6, `ASD left confidence at ${after.confidence}`);
});

test("ASD hearing one voice on two faces means a listener in frame, not a debate", () => {
  const s = sig({ faceCoverage: 0.98, faceSizeRatio: 0.29, medianConcurrentFaces: 2, speakerCount: 2 });
  // Diarization says two speakers; ASD measured only one of the faces talking.
  assert.equal(classify({ ...s, asdSpeakerCount: 1 }).type, "talking-head");
  assert.equal(classify(s).type, "multi-speaker");
});
