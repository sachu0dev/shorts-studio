import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCameraPath, primaryTrack, PRESETS } from "./camera.js";
import type { FaceTrack } from "./signals.js";

const CROP = 0.3164; // a 9:16 window on a 16:9 source

/** A track whose horizontal centre follows `cxAt`, sampled at 4 Hz. */
function track(duration: number, cxAt: (t: number) => number, id = 1): FaceTrack {
  const samples = [];
  for (let t = 0; t <= duration + 1e-9; t += 0.25) {
    samples.push({ t: Math.round(t * 1000) / 1000, cx: cxAt(t), cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 });
  }
  return { id, firstSeen: 0, lastSeen: duration, samples };
}

const moves = (path: { cx: number }[]) =>
  path.filter((k, i) => i > 0 && Math.abs(k.cx - path[i - 1].cx) > 1e-6).length;

test("movement inside the deadzone produces no camera movement at all", () => {
  // The face wanders ±0.02 — the measured static-window drift, inside calm's 0.06.
  const p = buildCameraPath(track(10, (t) => 0.5 + 0.02 * Math.sin(t * 4)), [], 10, CROP, PRESETS.calm);
  assert.equal(moves(p), 0);
  assert.ok(p.every((k) => k.cx === p[0].cx));
});

test("a delta above track_snap jumps rather than easing", () => {
  // Jump from 0.35 to 0.75 at t=5 — 0.40, well above calm's 0.12 snap.
  const p = buildCameraPath(track(10, (t) => (t < 5 ? 0.35 : 0.75)), [], 10, CROP, PRESETS.calm);
  const at5 = p.findIndex((k) => k.t >= 5);
  const jump = Math.abs(p[at5].cx - p[at5 - 1].cx);
  // an eased step would be smooth (0.18) x delta ~ 0.07; a snap covers it all
  assert.ok(jump > 0.3, `expected a snap, got a ${jump.toFixed(3)} step`);
});

test("a scene cut always produces a discontinuity — no pan across a cut", () => {
  // Drift stays inside the deadzone, so easing never moves the camera on its own.
  const p = buildCameraPath(track(10, (t) => 0.5 + 0.004 * t), [5], 10, CROP, PRESETS.calm);
  const at5 = p.findIndex((k) => k.t >= 5);
  assert.notEqual(p[at5].cx, p[at5 - 1].cx, "camera did not move at the cut");
  // and it landed on the target, not part-way there
  assert.ok(Math.abs(p[at5].cx - (0.5 + 0.004 * p[at5].t)) < 1e-3);
});

test("calm produces fewer camera movements than dynamic on the same track", () => {
  const t = track(20, (x) => 0.5 + 0.14 * Math.sin(x));
  const calm = moves(buildCameraPath(t, [], 20, CROP, PRESETS.calm));
  const dyn = moves(buildCameraPath(t, [], 20, CROP, PRESETS.dynamic));
  assert.ok(calm < dyn, `calm ${calm} should be below dynamic ${dyn}`);
});

test("an empty face track returns a valid centred path rather than throwing", () => {
  assert.deepEqual(buildCameraPath(null, [], 10, CROP, PRESETS.calm), [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
  const empty: FaceTrack = { id: 1, firstSeen: 0, lastSeen: 0, samples: [] };
  assert.deepEqual(buildCameraPath(empty, [], 10, CROP, PRESETS.calm), [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

test("the crop window never leaves the frame", () => {
  // A face pinned to the extreme edge would put half the window outside it.
  const p = buildCameraPath(track(10, () => 0.02), [], 10, CROP, PRESETS.dynamic);
  const half = CROP / 2;
  for (const k of p) {
    assert.ok(k.cx >= half - 1e-9 && k.cx <= 1 - half + 1e-9, `cx ${k.cx} outside [${half}, ${1 - half}]`);
  }
});

test("a dropped track holds position, then recentres", () => {
  // Face at 0.30 for 2s, then gone for the rest of a 10s clip.
  const t: FaceTrack = { id: 1, firstSeen: 0, lastSeen: 2, samples: [] };
  for (let x = 0; x <= 2.0001; x += 0.25) t.samples.push({ t: x, cx: 0.3, cy: 0.5, w: 0.1, h: 0.2, conf: 0.9 });

  const p = buildCameraPath(t, [], 10, CROP, PRESETS.dynamic);
  const held = p.find((k) => Math.abs(k.t - 3) < 1e-6)!; // inside the 1.2s hold
  assert.ok(Math.abs(held.cx - 0.3) < 0.02, `held at ${held.cx}`);
  assert.ok(Math.abs(p[p.length - 1].cx - 0.5) < Math.abs(held.cx - 0.5), "never started recentring");
  // recentring eases: the 0.2 gap back to centre exceeds dynamic's 0.1 snap, and
  // jumping to the middle the instant a face is lost is the jarring version
  const steps = p.filter((k) => k.t > 3.2).map((k, i, a) => (i ? Math.abs(k.cx - a[i - 1].cx) : 0));
  assert.ok(Math.max(...steps) < PRESETS.dynamic.snap, "recentring snapped instead of easing");
});

test("primaryTrack picks the most-present face, ignoring empty tracks", () => {
  const a = track(2, () => 0.3, 1);
  const b = track(8, () => 0.7, 2);
  assert.equal(primaryTrack([a, b])!.id, 2);
  assert.equal(primaryTrack([{ id: 9, firstSeen: 0, lastSeen: 0, samples: [] }]), null);
  assert.equal(primaryTrack([]), null);
});
