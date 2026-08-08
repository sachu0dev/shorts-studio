import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFacecam } from "./gaming.js";
import { route } from "./router.js";
import type { Signals } from "./signals.js";
import type { FaceTrack } from "./signals.js";

function sig(overrides: Partial<Signals> = {}): Signals {
  return {
    faceCoverage: 0, distinctFaceTracks: 0, rawTrackCount: 0,
    medianConcurrentFaces: 0, maxConcurrentFaces: 0, subjectMotion: 0,
    facesFitOneCrop: false, faceSizeRatio: 0,
    speakerCount: 0, wordCount: 0, overlapRatio: 0, turnRate: 0, sceneCuts: [],
    ...overrides,
  };
}

/** A track parked in the bottom-right corner, small and steady — a textbook facecam. */
function cornerTrack(id = 1): FaceTrack {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    t: i * 0.25, cx: 0.84 + (i % 2) * 0.002, cy: 0.82 - (i % 2) * 0.002, w: 0.14, h: 0.12, conf: 0.9,
  }));
  return { id, firstSeen: 0, lastSeen: 4.75, samples };
}

/** A large face dead centre — a talking-head with gameplay behind it, not a facecam. */
function centeredTrack(id = 1): FaceTrack {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    t: i * 0.25, cx: 0.5, cy: 0.5, w: 0.32, h: 0.35, conf: 0.9,
  }));
  return { id, firstSeen: 0, lastSeen: 4.75, samples };
}

test("small + cornered + stable → facecam", () => {
  const fc = detectFacecam([cornerTrack()]);
  assert.ok(fc, "expected a facecam");
  assert.equal(fc!.trackId, 1);
  // Padded box must still sit inside the frame and stay in the corner.
  assert.ok(fc!.x > 0.5 && fc!.y > 0.5);
  assert.ok(fc!.confidence >= 0.5 && fc!.confidence <= 0.95);
});

test("large + centred face → not a facecam", () => {
  assert.equal(detectFacecam([centeredTrack()]), null);
});

test("no face → no facecam, no error", () => {
  assert.equal(detectFacecam([]), null);
});

test("a moving cornered face fails the stability check", () => {
  const drifting: FaceTrack = {
    id: 2, firstSeen: 0, lastSeen: 4.75,
    samples: Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.25, cx: 0.8 + i * 0.01, cy: 0.8, w: 0.14, h: 0.12, conf: 0.9,
    })),
  };
  assert.equal(detectFacecam([drifting]), null);
});

test("two facecam candidates: the more stable one wins", () => {
  const shaky: FaceTrack = {
    id: 5, firstSeen: 0, lastSeen: 4.75,
    samples: Array.from({ length: 20 }, (_, i) => ({
      t: i * 0.25, cx: 0.86 + (i % 4) * 0.006, cy: 0.15 - (i % 4) * 0.006, w: 0.13, h: 0.11, conf: 0.9,
    })),
  };
  const fc = detectFacecam([shaky, cornerTrack(9)]);
  assert.ok(fc);
  assert.equal(fc!.trackId, 9, "the steadier corner track should win");
});

test("screen-rec routing: actionConfidence < 0.5 with no facecam always includes blurred-fill first", () => {
  const r = route(sig(), "screen-rec", 0.9, { hasFacecam: false, actionConfidence: 0.2 });
  assert.equal(r.modes[0], "blurred-fill");
});

test("screen-rec routing: no facecam, decent actionConfidence → action-follow first", () => {
  const r = route(sig(), "screen-rec", 0.9, { hasFacecam: false, actionConfidence: 0.8 });
  assert.deepEqual(r.modes, ["action-follow", "blurred-fill"]);
});

test("screen-rec routing: facecam alone (no action check) → facecam-pip first", () => {
  const r = route(sig(), "screen-rec", 0.9, { hasFacecam: true, actionConfidence: 0.1 });
  assert.deepEqual(r.modes, ["gameplay-facecam-pip", "blurred-fill"]);
});

test("screen-rec routing: facecam + strong action → stacked, then pip, then blurred-fill", () => {
  const r = route(sig(), "screen-rec", 0.9, { hasFacecam: true, actionConfidence: 0.9 });
  assert.deepEqual(r.modes, ["gameplay-facecam-stack", "gameplay-facecam-pip", "blurred-fill"]);
});

test("screen-rec routing: no screenRec info at all falls back to the old blurred-fill default", () => {
  const r = route(sig(), "screen-rec", 0.9);
  assert.deepEqual(r.modes, ["blurred-fill", "static-center"]);
});
