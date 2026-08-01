import { test } from "node:test";
import assert from "node:assert/strict";
import {
  route, buildComposition, cropWidthFor, assignFrameAspects, ASPECT, ROUTE_THRESHOLDS, type LayoutMode, type LayoutSegment,
} from "./router.js";
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

test("low classifier confidence on a single-face clip still returns static-center", () => {
  // Solo talking-head with low confidence — nothing to group, static is correct.
  const types: CompositionType[] = ["talking-head", "screen-rec", "b-roll"];
  for (const type of types) {
    const r = route(sig({ medianConcurrentFaces: 1, subjectMotion: 0.9 }), type, 0.55);
    assert.deepEqual(r.modes, ["static-center", "blurred-fill"], type);
    assert.match(r.reason, /confidence/);
  }
  // zero faces — also static, nothing to group
  const r0 = route(sig({ medianConcurrentFaces: 0 }), "b-roll", 0.55);
  assert.deepEqual(r0.modes, ["static-center", "blurred-fill"]);
  // and 0.6 itself is not "low"
  assert.notDeepEqual(route(sig({ subjectMotion: 0.09 }), "talking-head", ROUTE_THRESHOLDS.confidence).modes,
    ["static-center", "blurred-fill"]);
});

test("low classifier confidence with 2+ faces returns group-crop, not static-center (phase 31)", () => {
  // The corpus bug: 8-person panel, confidence 0.55 (diarization gated) → was
  // static-center (retains 42.4% of faces). Must now be group-crop.
  const types: CompositionType[] = ["talking-head", "multi-speaker", "screen-rec", "b-roll"];
  for (const type of types) {
    const r = route(sig({ ...twoShot, subjectMotion: 0.9, overlapRatio: 0.9 }), type, 0.55);
    assert.equal(r.modes[0], "group-crop", `${type}: expected group-crop, got ${r.modes[0]}`);
    assert.notEqual(r.modes[0], "static-center", `${type}: static-center must not be the first mode`);
    assert.match(r.reason, /confidence/);
  }
  // 8 faces specifically: the corpus defect case
  const panel8 = route(sig({ medianConcurrentFaces: 8, distinctFaceTracks: 8 }), "multi-speaker", 0.55);
  assert.equal(panel8.modes[0], "group-crop");
  assert.notEqual(panel8.modes[0], "static-center");
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

test("static-center holds on an off-centre subject instead of cropping them out at 0.5", () => {
  const offCenter = analysis({
    signals: sig({ subjectMotion: 0.006 }),
    faceTracks: [{ id: 7, firstSeen: 0, lastSeen: 10, samples: [
      { t: 0, cx: 0.82, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
      { t: 10, cx: 0.82, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 },
    ] }],
  });
  const c = buildComposition("clip1", 10, offCenter, "calm", () => {});
  assert.equal(c.mode, "static-center");
  assert.equal(c.cameraPath.length, 1);
  assert.ok(Math.abs(c.cameraPath[0].cx - 0.82) < 1e-6, `expected the camera on the subject at 0.82, got ${c.cameraPath[0].cx}`);
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

// ── phase 30: adaptive framing window ──────────────────────────────────────────

const SRC_W = 1920, SRC_H = 1080;

function trackAt(id: number, cx: number, t0: number, t1: number, w = 0.1) {
  const samples = [];
  for (let t = t0; t < t1 - 1e-9; t += 0.25) samples.push({ t, cx, cy: 0.5, w, h: 0.2, conf: 0.9 });
  return { id, firstSeen: t0, lastSeen: t1, samples };
}

const SEG30 = (t0: number, t1: number, mode: LayoutMode = "camera-switch"): LayoutSegment => ({ t0, t1, mode });

test("a single centred speaker stays at 9:16 — narrowest wins when it is already safe", () => {
  const out = assignFrameAspects([SEG30(0, 10)], [trackAt(1, 0.5, 0, 10)], SRC_W, SRC_H);
  assert.equal(out[0].frameAspect, "9:16");
});

test("two faces spread wide clear the retention floor only at 16:9", () => {
  const tracks = [trackAt(1, 0.05, 0, 10), trackAt(2, 0.95, 0, 10)];
  const out = assignFrameAspects([SEG30(0, 10)], tracks, SRC_W, SRC_H);
  assert.equal(out[0].frameAspect, "16:9");
});

test("no tracks never guesses a wide aspect — 9:16 by default", () => {
  const out = assignFrameAspects([SEG30(0, 10)], [], SRC_W, SRC_H);
  assert.equal(out[0].frameAspect, "9:16");
});

test("assignFrameAspects only adds fields — segment boundaries and count are untouched", () => {
  const segs = [SEG30(0, 4), SEG30(4, 9), SEG30(9, 10)];
  const out = assignFrameAspects(segs, [trackAt(1, 0.5, 0, 10)], SRC_W, SRC_H);
  assert.deepEqual(out.map((s) => [s.t0, s.t1]), [[0, 4], [4, 9], [9, 10]]);
});

test("a brief crowd cutaway does not earn a widen — too short on both sides of the hold", () => {
  // Wide crowd for only 2s inside a long solo segment: neither the prior 9:16
  // run nor the crowd window itself clears ASPECT.minHold.
  const solo = trackAt(1, 0.5, 0, 10);
  const crowdA = trackAt(2, 0.05, 4, 6);
  const crowdB = trackAt(3, 0.95, 4, 6);
  const segs = [SEG30(0, 4), SEG30(4, 6), SEG30(6, 10)];
  const out = assignFrameAspects(segs, [solo, crowdA, crowdB], SRC_W, SRC_H, undefined, undefined, ASPECT.minHold);
  assert.deepEqual(out.map((s) => s.frameAspect), ["9:16", "9:16", "9:16"]);
});

test("a sustained crowd shot survives ASPECT.minHold on both sides and commits", () => {
  const solo = trackAt(1, 0.5, 0, 5);
  const crowdA = trackAt(2, 0.05, 5, 15);
  const crowdB = trackAt(3, 0.95, 5, 15);
  const out = assignFrameAspects(
    [SEG30(0, 5), SEG30(5, 15)], [solo, crowdA, crowdB], SRC_W, SRC_H, undefined, undefined, ASPECT.minHold
  );
  assert.equal(out[0].frameAspect, "9:16");
  assert.equal(out[1].frameAspect, "16:9");
});

test("speakerRetention below its floor forces an immediate widen inside ASPECT.minHold", () => {
  // A long 9:16 close-up, then a brief 2s cutaway where nine bystanders cluster
  // centre-frame and the talking speaker sits at the far edge — the window
  // that keeps the most FACES keeps the cluster and drops the speaker. 2s is
  // nowhere near ASPECT.minHold, but holding 9:16 anyway crops who is talking.
  const speaker = trackAt(1, 0.95, 0, 20);
  const bystanders = Array.from({ length: 9 }, (_, i) => trackAt(10 + i, 0.5, 8, 10));
  const activeTrack = Array.from({ length: 80 }, () => 1); // speaker talks the whole clip, 20s @ 4Hz
  const out = assignFrameAspects(
    [SEG30(0, 8), SEG30(8, 10), SEG30(10, 20)],
    [speaker, ...bystanders], SRC_W, SRC_H, activeTrack, 0.25, ASPECT.minHold
  );
  assert.notEqual(out[1].frameAspect, "9:16", "held 9:16 through a segment that crops the active speaker");
});

test("frameAspect is buildComposition's real output, not just the unit-level function", () => {
  const wide = analysis({
    signals: sig({ subjectMotion: 0.006 }),
    faceTracks: [trackAt(7, 0.05, 0, 10), trackAt(8, 0.95, 0, 10)],
  });
  const c = buildComposition("clip1", 10, wide, "calm", () => {});
  assert.equal(c.layoutTimeline[0].frameAspect, "16:9");
  assert.deepEqual(c.canvas, { w: 1080, h: 1920 });
});

// ── phase 31: panel framing ─────────────────────────────────────────────────

import { PANEL } from "./router.js";

// Gate 1 from the spec: the corpus defect case.
test("8 faces at confidence 0.55 does NOT route to static-center (the corpus defect)", () => {
  const r = route(
    sig({ medianConcurrentFaces: 8, distinctFaceTracks: 8 }),
    "multi-speaker", 0.55
  );
  assert.notEqual(r.modes[0], "static-center", "8-person panel must never lead with static-center");
  assert.equal(r.modes[0], "group-crop");
  assert.match(r.reason, /group/);
});

// Gate 2: brief reply inside a panel does NOT trigger camera-switch.
test("3+ faces, speaker held < PANEL.monologueSeconds → group-crop stays, no switch", () => {
  // Panel of 4: track 4 talks for 3s (well below the 6s monologue threshold),
  // track 7 talks the rest.  minHold is effectiveMinHold = PANEL.monologueSeconds
  // so a 3s turn must be suppressed.
  const panelTracks = [
    ...twoTracks,
    { id: 5, firstSeen: 0, lastSeen: 10, samples: [{ t: 0, cx: 0.5, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 }] },
    { id: 6, firstSeen: 0, lastSeen: 10, samples: [{ t: 0, cx: 0.6, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 }] },
  ];
  const shortSpeaker: AsdArtifact = {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25, scores: {},
    // Track 4 talks for 3s, track 7 for 4s, track 5 for 3s (all below 6s PANEL.monologueSeconds)
    activeTrack: [
      ...Array(12).fill(4),  // 3s — below PANEL.monologueSeconds
      ...Array(16).fill(7),  // 4s — below PANEL.monologueSeconds
      ...Array(12).fill(5),  // 3s — below PANEL.monologueSeconds
    ],
    speakers: {}, asdSpeakerCount: 4,
  };
  const panelAnalysis = analysis({
    faceTracks: panelTracks,
    signals: sig({ medianConcurrentFaces: 4, distinctFaceTracks: 4, overlapRatio: 0.05 }),
    classification: { type: "multi-speaker", confidence: 0.9, reason: "test" },
  });
  const c = buildComposition("clip1", 10, panelAnalysis, "calm", () => {}, shortSpeaker);
  // route() must have returned group-crop first (panel guard)
  assert.equal(c.allowedModes[0], "group-crop");
  // The 3s speaker turn must be suppressed — all segments must stay group-crop
  assert.ok(
    c.layoutTimeline.every((s) => s.mode !== "camera-switch"),
    `expected no camera-switch, got ${JSON.stringify(c.layoutTimeline.map((s) => s.mode))}`
  );
});

// Gate 3: sustained monologue on a panel DOES earn a camera-switch.
test("3+ faces, speaker held >= PANEL.monologueSeconds → camera-switch on that track", () => {
  const n = 40; // 10s at 4Hz
  const sustainedSpeaker: AsdArtifact = {
    schemaVersion: 1, clipId: "clip1", sampleStep: 0.25, scores: {},
    // Track 4 holds the floor for 7s (28 samples) — clears the 6s bar.
    activeTrack: [
      ...Array(28).fill(4),  // 7s — above PANEL.monologueSeconds
      ...Array(12).fill(7),
    ],
    speakers: {}, asdSpeakerCount: 3,
  };
  const panelOf3 = analysis({
    faceTracks: twoTracks,
    signals: sig({ medianConcurrentFaces: 3, distinctFaceTracks: 3, overlapRatio: 0.05 }),
    classification: { type: "multi-speaker", confidence: 0.9, reason: "test" },
  });
  const c = buildComposition("clip1", 10, panelOf3, "calm", () => {}, sustainedSpeaker);
  assert.equal(c.allowedModes[0], "group-crop", "panel must start with group-crop");
  assert.equal(c.mode, "camera-switch", "7s monologue must earn camera-switch");
  // At least one segment must target the sustained speaker (track 4)
  assert.ok(
    c.layoutTimeline.some((s) => s.target === 4),
    `expected a segment targeting track 4, got ${JSON.stringify(c.layoutTimeline)}`
  );
});

// Gate 4: panel with no dominant speaker at all → group-crop, nobody cropped out.
test("3+ faces with no sustained dominant speaker → group-crop first", () => {
  const r = route(
    sig({ medianConcurrentFaces: 5, distinctFaceTracks: 5, overlapRatio: 0.1 }),
    "multi-speaker", 0.9
  );
  assert.equal(r.modes[0], "group-crop");
  assert.ok(r.modes.includes("camera-switch"), "camera-switch must remain as a secondary option");
  assert.ok(!r.modes.includes("split-screen"), "split-screen is meaningless on 5 people");
});

// Gate 5: two-person podcast is unaffected — ordinary min-hold, NOT PANEL.monologueSeconds.
test("2-person turn-taking still uses ordinary minHold, not PANEL.monologueSeconds", () => {
  // Track 4 talks for 3s — above ordinary calm minHold (2.5s) but below PANEL.monologueSeconds (6s).
  // Must still produce a camera-switch segment on a 2-person clip.
  const c = buildComposition("clip1", 10, multi(), "calm", () => {}, turnTaking());
  assert.equal(c.mode, "camera-switch");
  // Both targets must appear — the switch happened
  const targets = c.layoutTimeline.map((s) => s.target);
  assert.ok(targets.includes(4) && targets.includes(7), `expected both tracks, got ${targets}`);
});

// Gate 6: solo clip is untouched.
test("solo clip is unchanged by phase 31 — same mode, same aspect", () => {
  const c = buildComposition("clip1", 10, analysis({ signals: sig({ subjectMotion: 0.006 }) }), "calm", () => {});
  assert.equal(c.mode, "static-center");
  assert.deepEqual(c.cameraPath, [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

// Gate 7: ASD absent + several faces → group-crop from route(), never static-center.
test("ASD absent with 4 concurrent faces routes to group-crop, not static-center", () => {
  const r = route(
    sig({ medianConcurrentFaces: 4, distinctFaceTracks: 4, overlapRatio: 0.1 }),
    "multi-speaker", 0.9
  );
  assert.equal(r.modes[0], "group-crop");
  assert.notEqual(r.modes[0], "static-center");
  // Without ASD, buildComposition should also land on group-crop (not a switch fallback)
  const noAsd = analysis({
    faceTracks: twoTracks,
    signals: sig({ medianConcurrentFaces: 4, distinctFaceTracks: 4, overlapRatio: 0.1 }),
    classification: { type: "multi-speaker", confidence: 0.9, reason: "test" },
  });
  const c = buildComposition("clip1", 10, noAsd, "calm", () => {});
  // group-crop is in IMPLEMENTED_MODES and does not need ASD, so it should render directly
  assert.equal(c.mode, "group-crop");
  assert.equal(c.fallbackReason, undefined, "group-crop should not need a fallback");
});

// 1-face low-confidence: static-center still correct (phase 31 must not regress this).
test("1 face at low confidence still returns static-center", () => {
  const r = route(sig({ medianConcurrentFaces: 1, distinctFaceTracks: 1 }), "multi-speaker", 0.55);
  assert.deepEqual(r.modes, ["static-center", "blurred-fill"]);
});
