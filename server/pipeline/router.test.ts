import { test } from "node:test";
import assert from "node:assert/strict";
import { route, buildComposition, cropWidthFor, ROUTE_THRESHOLDS, type LayoutMode } from "./router.js";
import type { Signals, AnalysisArtifact } from "./signals.js";
import type { CompositionType } from "./classify.js";
import type { AsdArtifact } from "./binding.js";

/** Every field zero, so each case names only the signals it is about. */
function sig(overrides: Partial<Signals> = {}): Signals {
  return {
    faceCoverage: 0, distinctFaceTracks: 0, rawTrackCount: 0,
    medianConcurrentFaces: 0, maxConcurrentFaces: 0, subjectMotion: 0,
    facesFitOneCrop: false, faceSizeRatio: 0,
    speakerCount: 0, wordCount: 0, overlapRatio: 0, turnRate: 0, sceneCuts: [],
    ...overrides,
  };
}

const twoShot = { medianConcurrentFaces: 2, distinctFaceTracks: 2 };

const CASES: [string, Signals, CompositionType, number, LayoutMode[]][] = [
  ["b-roll", sig(), "b-roll", 0.9, ["static-center", "blurred-fill"]],
  ["screen-rec", sig(), "screen-rec", 0.9, ["blurred-fill", "static-center"]],
  // 0.0059 and 0.0721 are real solo-corpus measurements either side of the gap.
  ["still talking-head stays static", sig({ subjectMotion: 0.0059 }), "talking-head", 0.9, ["static-center"]],
  ["moving talking-head follows", sig({ subjectMotion: 0.0721 }), "talking-head", 0.9, ["fullscreen-follow", "static-center"]],
  ["two faces in one crop", sig({ ...twoShot, facesFitOneCrop: true }), "multi-speaker", 0.9, ["group-crop", "fullscreen-follow"]],
  ["crosstalk splits", sig({ ...twoShot, overlapRatio: 0.4 }), "multi-speaker", 0.9, ["split-screen", "camera-switch"]],
  ["turn-taking switches", sig({ ...twoShot, overlapRatio: 0.05 }), "multi-speaker", 0.9, ["camera-switch", "split-screen"]],
];

test("each branch of the rule table returns the documented modes", () => {
  for (const [name, s, type, conf, expected] of CASES) {
    assert.deepEqual(route(s, type, conf).modes, expected, name);
  }
});

test("low classifier confidence forces the conservative list from every type", () => {
  const types: CompositionType[] = ["talking-head", "multi-speaker", "screen-rec", "b-roll"];
  for (const type of types) {
    const r = route(sig({ ...twoShot, subjectMotion: 0.9, overlapRatio: 0.9 }), type, 0.55);
    assert.deepEqual(r.modes, ["static-center", "blurred-fill"], type);
    assert.match(r.reason, /confidence/);
  }
  // and 0.6 itself is not "low"
  assert.notDeepEqual(route(sig({ subjectMotion: 0.09 }), "talking-head", ROUTE_THRESHOLDS.confidence).modes,
    ["static-center", "blurred-fill"]);
});

test("split-screen is never returned when fewer than 2 faces are tracked", () => {
  // The factual-impossibility guarantee: no combination of the other signals
  // may produce a two-subject layout on one-subject footage.
  for (const distinctFaceTracks of [0, 1]) {
    for (const overlapRatio of [0, 0.3, 0.9]) {
      for (const facesFitOneCrop of [true, false]) {
        const modes = route(
          sig({ distinctFaceTracks, medianConcurrentFaces: 2, overlapRatio, facesFitOneCrop }),
          "multi-speaker", 0.9
        ).modes;
        assert.ok(!modes.includes("split-screen"), `tracks=${distinctFaceTracks} overlap=${overlapRatio}`);
        assert.ok(!modes.includes("camera-switch"), `tracks=${distinctFaceTracks} overlap=${overlapRatio}`);
      }
    }
  }
});

test("multi-cam footage routes to follow, not split — one face on screen at a time", () => {
  // The real phase-4 podcast measurement: 3 tracks from cuts, 1 face at a time.
  const r = route(sig({ medianConcurrentFaces: 1, distinctFaceTracks: 3, overlapRatio: 0.4 }), "multi-speaker", 0.9);
  assert.deepEqual(r.modes, ["fullscreen-follow", "static-center"]);
  assert.match(r.reason, /multi-cam/);
});

test("cropWidth is the 9:16 window as a fraction of source width", () => {
  assert.equal(Math.round(cropWidthFor(1920, 1080) * 10000) / 10000, 0.3164);
  assert.equal(cropWidthFor(1080, 1920), 1); // already tall: no horizontal room
  assert.equal(cropWidthFor(0, 0), 9 / 16);  // unknown source, never NaN
});

// ── buildComposition ─────────────────────────────────────────────────────────

function analysis(overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return {
    schemaVersion: 2, clipId: "clip1", start: 0, end: 10,
    sourceWidth: 1920, sourceHeight: 1080, sampleStep: 0.25,
    faceTracks: [{ id: 7, firstSeen: 0, lastSeen: 10, samples: [
      { t: 0, cx: 0.5, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
      { t: 10, cx: 0.5, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
    ] }],
    signals: sig({ subjectMotion: 0.072 }),
    classification: { type: "talking-head", confidence: 0.9, reason: "test" },
    ...overrides,
  };
}

test("a mode needing ASD falls back to presence framing when ASD didn't run, rather than crashing", () => {
  const lines: string[] = [];
  const c = buildComposition("clip1", 10, analysis({
    signals: sig({ ...twoShot, overlapRatio: 0.4 }),
    classification: { type: "multi-speaker", confidence: 0.9, reason: "t" },
  }), "calm", (l) => lines.push(l));

  assert.deepEqual(c.allowedModes, ["split-screen", "camera-switch"]);
  assert.equal(c.mode, "fullscreen-follow");
  assert.match(c.fallbackReason!, /active-speaker detection/);
  assert.equal(lines.length, 1);
});

test("a missing analysis still produces a renderable static composition", () => {
  const c = buildComposition("clip1", 10, null, "calm", () => {});
  assert.equal(c.mode, "static-center");
  assert.deepEqual(c.cameraPath, [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
  assert.equal(c.layoutTimeline.length, 1);
});

test("static-center emits a constant path, so the renderer has one code path", () => {
  const c = buildComposition("clip1", 10, analysis({ signals: sig({ subjectMotion: 0.006 }) }), "calm", () => {});
  assert.equal(c.mode, "static-center");
  assert.deepEqual(c.cameraPath, [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

test("the layout timeline breaks at every scene cut and marks the jump", () => {
  const c = buildComposition("clip1", 10, analysis({ signals: sig({ subjectMotion: 0.072, sceneCuts: [3, 7] }) }),
    "calm", () => {});
  assert.deepEqual(c.layoutTimeline.map((s) => [s.t0, s.t1, s.snapped ?? false]),
    [[0, 3, false], [3, 7, true], [7, 10, true]]);
  assert.equal(c.layoutTimeline[0].target, 7); // the face track id, not a speaker label
});

// ── phase 8: the target is measured, not assumed ──────────────────────────────

/** ASD saying track 4 talks for the first 5s and track 7 for the rest. */
function asd(): AsdArtifact {
  const n = 40; // 10s at 4Hz
  return {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25,
    scores: {},
    activeTrack: Array.from({ length: n }, (_, k) => (k * 0.25 < 5 ? 4 : 7)),
    speakers: { SPEAKER_00: { trackId: 4, confidence: 0.8 } },
    asdSpeakerCount: 2,
  };
}

test("layoutTimeline targets the ASD active speaker, not just the most-present face", () => {
  // Track 7 is the only face track, so presence alone would say 7 everywhere.
  const a = analysis({ signals: sig({ subjectMotion: 0.072, sceneCuts: [5] }) });
  const c = buildComposition("clip1", 10, a, "calm", () => {}, asd());

  assert.deepEqual(c.layoutTimeline.map((s) => [s.target, s.targetSource]),
    [[4, "asd"], [7, "asd"]]);
  assert.deepEqual(c.speakers, { SPEAKER_00: { trackId: 4, confidence: 0.8 } });
});

test("without ASD the target falls back to presence and says so", () => {
  const c = buildComposition("clip1", 10, analysis(), "calm", () => {});
  assert.equal(c.layoutTimeline[0].target, 7);
  assert.equal(c.layoutTimeline[0].targetSource, "presence");
  assert.equal(c.speakers, undefined);
});

test("a segment where nobody speaks still frames someone", () => {
  const silent = { ...asd(), activeTrack: Array(40).fill(null) };
  const c = buildComposition("clip1", 10, analysis(), "calm", () => {}, silent);
  assert.equal(c.layoutTimeline[0].target, 7);
  assert.equal(c.layoutTimeline[0].targetSource, "presence");
});

// ── phase 9: camera-switch + group-crop are built ─────────────────────────────

const twoTracks = [
  { id: 4, firstSeen: 0, lastSeen: 10, samples: [
    { t: 0, cx: 0.3, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
    { t: 10, cx: 0.3, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 }] },
  { id: 7, firstSeen: 0, lastSeen: 10, samples: [
    { t: 0, cx: 0.8, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
    { t: 10, cx: 0.8, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 }] },
];

/** Turn-taking multi-speaker: 4 talks for 5s, then 7 does. */
function turnTaking(): AsdArtifact {
  return {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25, scores: {},
    activeTrack: Array.from({ length: 40 }, (_, k) => (k * 0.25 < 5 ? 4 : 7)),
    speakers: {}, asdSpeakerCount: 2,
  };
}

const multi = (over: Partial<Signals> = {}) => analysis({
  faceTracks: twoTracks,
  signals: sig({ medianConcurrentFaces: 2, distinctFaceTracks: 2, overlapRatio: 0.05, ...over }),
  classification: { type: "multi-speaker", confidence: 0.9, reason: "test" },
});

test("turn-taking multi-speaker renders camera-switch, not a fallback", () => {
  const c = buildComposition("clip1", 10, multi(), "calm", () => {}, turnTaking());
  assert.equal(c.mode, "camera-switch");
  assert.equal(c.fallbackReason, undefined);
  assert.deepEqual(c.layoutTimeline.map((s) => [s.t0, s.target]), [[0, 4], [5, 7]]);
  assert.equal(c.heldSegments, 2);
});

test("camera-switch without ASD falls back and names the reason", () => {
  const c = buildComposition("clip1", 10, multi(), "calm", () => {});
  assert.equal(c.mode, "fullscreen-follow");
  assert.match(c.fallbackReason!, /active-speaker detection/);
});

test("faces that fit one crop get group-crop and never switch", () => {
  const c = buildComposition("clip1", 10, multi({ facesFitOneCrop: true }), "calm", () => {}, turnTaking());
  assert.equal(c.mode, "group-crop");
  assert.equal(c.cameraPath.length, 1, "group-crop moved the camera");
  // centred between the two faces (0.3 and 0.8), not on the frame centre
  assert.ok(Math.abs(c.cameraPath[0].cx - 0.55) < 1e-6);
  assert.equal(c.suppressedSwitches, 0);
});

test("crosstalk falls back to camera-switch when ASD found no concurrent speaker", () => {
  // turnTaking()'s scores are empty — nobody clears the ASD speaking-time bar,
  // so there is nobody to bind either half of a split to.
  const c = buildComposition("clip1", 10, multi({ overlapRatio: 0.4 }), "calm", () => {}, turnTaking());
  assert.equal(c.mode, "camera-switch");
  assert.match(c.fallbackReason!, /active-speaker detection/);
});

// ── phase 10: split-screen ────────────────────────────────────────────────────

/** Both tracks 4 and 7 clear the ASD speaking bar throughout — genuine crosstalk. */
function bothSpeaking(): AsdArtifact {
  const hi = Array(40).fill(0.9);
  return {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25,
    scores: { "4": hi, "7": hi },
    activeTrack: Array.from({ length: 40 }, (_, k) => (k % 2 ? 7 : 4)),
    speakers: {}, asdSpeakerCount: 2,
  };
}

test("crosstalk with two ASD-confirmed speakers renders split-screen", () => {
  const c = buildComposition("clip1", 10, multi({ overlapRatio: 0.4 }), "calm", () => {}, bothSpeaking());
  assert.equal(c.mode, "split-screen");
  assert.equal(c.fallbackReason, undefined);
  assert.ok(c.layoutTimeline.some((s) => s.mode === "split-screen" && s.arrangement === "stacked"));
  assert.ok(c.splitPath);
});

test("crosstalk with only one ASD-confirmed speaker still falls back to camera-switch", () => {
  const oneSpeaker: AsdArtifact = {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25,
    scores: { "4": Array(40).fill(0.9), "7": Array(40).fill(0.1) },
    activeTrack: Array(40).fill(4), speakers: {}, asdSpeakerCount: 1,
  };
  const c = buildComposition("clip1", 10, multi({ overlapRatio: 0.4 }), "calm", () => {}, oneSpeaker);
  assert.equal(c.mode, "camera-switch");
  assert.match(c.fallbackReason!, /active-speaker detection/);
});

test("split-screen targets are ordered by first-seen and stable for the whole clip", () => {
  // Track 7 first-seen before track 4, so 7 must lead despite the higher id.
  const lateTrack4 = twoTracks.map((t) => (t.id === 4 ? { ...t, firstSeen: 3 } : t));
  const a = { ...multi({ overlapRatio: 0.4 }), faceTracks: lateTrack4 };
  const c = buildComposition("clip1", 10, a, "calm", () => {}, bothSpeaking());
  const splitSeg = c.layoutTimeline.find((s) => s.mode === "split-screen");
  assert.deepEqual(splitSeg?.targets, [7, 4]);
});
