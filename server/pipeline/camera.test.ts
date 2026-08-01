import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCameraPath, buildFramedPath, buildSplitPath, groupCenter, staticCenter, primaryTrack, PRESETS, SPLIT_HALF_HEIGHT } from "./camera.js";
import type { FaceTrack } from "./signals.js";

const CROP = 0.3164; // a 9:16 window on a 16:9 source
const SRC_W = 1920, SRC_H = 1080; // a 16:9 source — cropWidthFor(..., "9:16") === CROP

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

// ── phase 9: camera-switch + group-crop ───────────────────────────────────────

const SEG = (t0: number, t1: number, target?: number) =>
  ({ t0, t1, mode: "camera-switch" as const, ...(target != null ? { target } : {}) });

test("switching between two people is a cut, not a pan", () => {
  const a = track(10, () => 0.25, 1);
  const b = track(10, () => 0.75, 2);
  const p = buildFramedPath([SEG(0, 5, 1), SEG(5, 10, 2)], [a, b], SRC_W, SRC_H, PRESETS.calm);

  // two keyframes share t=5: the old position and the new one. The renderer's
  // interpolator resolves a zero span to a jump, so nothing pans between them.
  const at5 = p.filter((k) => Math.abs(k.t - 5) < 1e-9);
  assert.equal(at5.length, 2, `expected a duplicated keyframe at the switch, got ${at5.length}`);
  assert.ok(Math.abs(at5[0].cx - 0.25) < 0.02, `held at ${at5[0].cx}`);
  assert.ok(Math.abs(at5[1].cx - 0.75) < 0.02, `jumped to ${at5[1].cx}`);
  // and nothing before the switch drifted toward the second speaker
  assert.ok(p.filter((k) => k.t < 5).every((k) => k.cx < 0.4));
});

test("a segment whose target has no track still yields a renderable path", () => {
  const p = buildFramedPath([SEG(0, 5, 99), SEG(5, 10)], [], SRC_W, SRC_H, PRESETS.calm);
  assert.ok(p.length > 0);
  assert.ok(p.every((k) => k.cx === 0.5), "expected a centred fallback");
});

test("the switch path covers every segment and stays inside the frame", () => {
  const a = track(12, () => 0.05, 1); // hard against the left edge
  const b = track(12, () => 0.95, 2);
  const p = buildFramedPath([SEG(0, 4, 1), SEG(4, 8, 2), SEG(8, 12, 1)], [a, b], SRC_W, SRC_H, PRESETS.dynamic);
  const half = CROP / 2;
  assert.ok(p[0].t === 0 && p[p.length - 1].t >= 11.9);
  for (const k of p) assert.ok(k.cx >= half - 1e-9 && k.cx <= 1 - half + 1e-9, `cx ${k.cx}`);
});

test("static-center holds on the subject's actual position, not an assumed frame centre", () => {
  // A subject sitting off to the right must not be cropped by a camera that
  // assumes 0.5 and never bothers to look at the measured face.
  const p = staticCenter(track(10, () => 0.8, 1), CROP);
  assert.equal(p.length, 1);
  assert.ok(Math.abs(p[0].cx - 0.8) < 1e-6, `expected 0.8, got ${p[0].cx}`);
});

test("static-center clamps to the frame and survives having no track at all", () => {
  assert.equal(staticCenter(track(10, () => 0.02, 1), CROP)[0].cx, CROP / 2);
  assert.deepEqual(staticCenter(null, CROP), [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

test("group-crop is one still keyframe centred between the faces", () => {
  const p = groupCenter([track(10, () => 0.3, 1), track(10, () => 0.6, 2)], CROP);
  assert.equal(p.length, 1);
  assert.ok(Math.abs(p[0].cx - 0.45) < 1e-6);
});

test("group-crop clamps to the frame and survives having no faces at all", () => {
  assert.equal(groupCenter([track(10, () => 0.02, 1)], CROP)[0].cx, CROP / 2);
  assert.deepEqual(groupCenter([], CROP), [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }]);
});

// ── phase 10: split-screen ─────────────────────────────────────────────────────

/** A track whose vertical centre also moves, for the split-path tests. */
function trackXY(duration: number, cxAt: (t: number) => number, cyAt: (t: number) => number, id: number): FaceTrack {
  const samples = [];
  for (let t = 0; t <= duration + 1e-9; t += 0.25) {
    samples.push({ t: Math.round(t * 1000) / 1000, cx: cxAt(t), cy: cyAt(t), w: 0.1, h: 0.2, conf: 0.9 });
  }
  return { id, firstSeen: 0, lastSeen: duration, samples };
}

const SPLIT_SEG = (t0: number, t1: number) =>
  ({ t0, t1, mode: "split-screen" as const, targets: [1, 2] as [number, number], arrangement: "stacked" as const });

test("split halves track their own subjects independently", () => {
  const top = trackXY(10, (t) => 0.2 + 0.02 * t, () => 0.5, 1); // drifts right
  const bottom = trackXY(10, () => 0.8, () => 0.5, 2); // stays put
  const { top: tp, bottom: bp } = buildSplitPath([SPLIT_SEG(0, 10)], [top, bottom], [1, 2], CROP, PRESETS.dynamic);

  assert.ok(new Set(tp.map((k) => k.cx)).size > 1, "top half never moved");
  assert.ok(bp.every((k) => k.cx === bp[0].cx), "bottom half moved despite a static subject");
});

test("split halves stay within the half-height frame", () => {
  const top = trackXY(10, () => 0.5, () => 0.02, 1); // pinned to the top edge
  const bottom = trackXY(10, () => 0.5, () => 0.5, 2);
  const { top: tp } = buildSplitPath([SPLIT_SEG(0, 10)], [top, bottom], [1, 2], CROP, PRESETS.dynamic);

  const halfY = SPLIT_HALF_HEIGHT / 2;
  for (const k of tp) assert.ok(k.cy >= halfY - 1e-9 && k.cy <= 1 - halfY + 1e-9, `cy ${k.cy}`);
});

test("only split-screen segments contribute keyframes — a camera-switch segment in between is skipped", () => {
  const top = trackXY(12, () => 0.5, () => 0.5, 1);
  const bottom = trackXY(12, () => 0.5, () => 0.5, 2);
  const segments = [SPLIT_SEG(0, 4), { t0: 4, t1: 8, mode: "camera-switch" as const, target: 1 }, SPLIT_SEG(8, 12)];
  const { top: tp } = buildSplitPath(segments, [top, bottom], [1, 2], CROP, PRESETS.dynamic);

  assert.ok(tp.every((k) => k.t <= 4 + 1e-9 || k.t >= 8 - 1e-9), "keyframes leaked into the camera-switch segment");
});

test("a track missing for one half still yields a renderable path", () => {
  const { top, bottom } = buildSplitPath([SPLIT_SEG(0, 5)], [], [1, 2], CROP, PRESETS.calm);
  assert.ok(top.every((k) => k.cx === 0.5 && k.cy === 0.5));
  assert.ok(bottom.every((k) => k.cx === 0.5 && k.cy === 0.5));
});

test("a segment that is not a whole number of steps still cuts rather than pans", () => {
  const a = track(10, () => 0.25, 1);
  const b = track(10, () => 0.75, 2);
  const p = buildFramedPath([SEG(0, 4.7, 1), SEG(4.7, 10, 2)], [a, b], SRC_W, SRC_H, PRESETS.calm);
  const at = p.filter((k) => Math.abs(k.t - 4.7) < 1e-9);
  assert.equal(at.length, 2, `expected a hold and a jump at 4.7, got ${at.length}`);
  assert.ok(Math.abs(at[0].cx - 0.25) < 0.02 && Math.abs(at[1].cx - 0.75) < 0.02);
});
