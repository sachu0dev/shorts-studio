import { test } from "node:test";
import assert from "node:assert/strict";
import {
  retentionOver, speakerRetentionOver, narrowestSafe, summarizeRetention, cropWidthFor, CANDIDATE_ASPECTS, RETENTION,
} from "./retention.js";
import type { FaceTrack } from "./signals.js";

const W = 1920, H = 1080;

/** One face, constant position, sampled every 0.25s from `t0` to `t1`. */
function track(id: number, cx: number, t0: number, t1: number, w = 0.1): FaceTrack {
  const samples = [];
  for (let t = t0; t < t1 - 1e-9; t += 0.25) samples.push({ t, cx, cy: 0.5, w, h: 0.2, conf: 0.9 });
  return { id, firstSeen: t0, lastSeen: t1, samples };
}

test("one centred face is retained whole at every aspect", () => {
  const t = [track(1, 0.5, 0, 4)];
  for (const a of CANDIDATE_ASPECTS) assert.equal(retentionOver(t, W, H, 0, 4, a), 1);
});

test("two faces at opposite edges are lost at 9:16, kept at 16:9", () => {
  const tracks = [track(1, 0.1, 0, 4), track(2, 0.9, 0, 4)];
  assert.ok(retentionOver(tracks, W, H, 0, 4, "9:16") < 1, "9:16 should lose at least one face");
  assert.equal(retentionOver(tracks, W, H, 0, 4, "16:9"), 1);
});

test("a face straddling the window edge counts as lost, not partial", () => {
  // window centred on track 1 (cx=0.5) is exactly half-width; track 2 sits just
  // outside centre so its box straddles the edge rather than clearing it.
  const half = (9 / 16 / (W / H)) / 2;
  const tracks = [track(1, 0.5, 0, 1), track(2, 0.5 + half + 0.02, 0, 1, 0.1)];
  const r = retentionOver(tracks, W, H, 0, 1, "9:16");
  assert.ok(r < 1, `expected the straddling face to be lost, got ${r}`);
});

test("no faces in range retains everything — nothing to lose", () => {
  assert.equal(retentionOver([], W, H, 0, 4, "9:16"), 1);
});

test("narrowestSafe returns the narrowest aspect clearing the floor, not the best score", () => {
  // 9:16 clears the floor on its own (single centred face); narrower must win
  // even though wider aspects score just as well.
  const t = [track(1, 0.5, 0, 4)];
  assert.equal(narrowestSafe(t, W, H, 0, 4), "9:16");
});

test("narrowestSafe widens when nothing clears the floor at 9:16", () => {
  const tracks = [track(1, 0.05, 0, 4), track(2, 0.95, 0, 4)];
  const a = narrowestSafe(tracks, W, H, 0, 4);
  assert.notEqual(a, "9:16");
  assert.ok(retentionOver(tracks, W, H, 0, 4, a) >= RETENTION.floor);
});

test("the time-range test the whole block rests on: retention differs across ranges of the same clip", () => {
  const tracks = [
    track(1, 0.5, 0, 8),               // alone for the first 8s
    track(2, 0.1, 8, 20), track(3, 0.9, 8, 20), track(4, 0.3, 8, 20),
    track(5, 0.7, 8, 20), track(6, 0.2, 8, 20), track(7, 0.8, 8, 20),
    track(8, 0.5, 8, 20),              // eight tracks crowd in from 8-20s
  ];
  const solo = retentionOver(tracks, W, H, 0, 8, "9:16");
  const crowd = retentionOver(tracks, W, H, 8, 20, "9:16");
  assert.equal(solo, 1);
  assert.ok(crowd < 0.5, `expected the crowded range to lose faces at 9:16, got ${crowd}`);
  assert.notEqual(solo, crowd);
});

test("the whole-clip summary equals retentionOver over [0, duration)", () => {
  const tracks = [track(1, 0.1, 0, 10), track(2, 0.9, 0, 10)];
  const whole = retentionOver(tracks, W, H, 0, 10, "4:3");
  const same = retentionOver(tracks, W, H, 0, 10, "4:3"); // same call, same range
  assert.equal(whole, same);
});

// ── speakerRetentionOver ───────────────────────────────────────────────────────

test("speakerRetention is strictly higher than retention when the speaker is central and a bystander is not", () => {
  const tracks = [track(1, 0.5, 0, 4), track(2, 0.05, 0, 4)]; // speaker centred, bystander at the edge
  const activeTrack = Array(16).fill(1); // 4Hz * 4s
  const sr = speakerRetentionOver(tracks, W, H, 0, 4, "9:16", activeTrack, 0.25);
  const r = retentionOver(tracks, W, H, 0, 4, "9:16");
  assert.ok(sr > r, `speakerRetention ${sr} should exceed retention ${r}`);
});

test("no identified speaker in range has nothing to violate", () => {
  const tracks = [track(1, 0.05, 0, 4), track(2, 0.95, 0, 4)];
  const activeTrack = Array(16).fill(null);
  assert.equal(speakerRetentionOver(tracks, W, H, 0, 4, "9:16", activeTrack, 0.25), 1);
});

// ── summarizeRetention ─────────────────────────────────────────────────────────

test("summarizeRetention is absent when the clip has no real face — not a spurious 1.0", () => {
  assert.equal(summarizeRetention([], W, H, 10), undefined);
  // two 1-sample blips: below MIN_TRACK_SAMPLES, so still "no real face"
  const noise = [track(1, 0.1, 0, 0.25), track(2, 0.9, 0, 0.25)];
  assert.equal(summarizeRetention(noise, W, H, 10), undefined);
});

test("summarizeRetention matches retentionOver over [0, duration) at every aspect", () => {
  const tracks = [track(1, 0.1, 0, 10), track(2, 0.9, 0, 10)];
  const s = summarizeRetention(tracks, W, H, 10)!;
  for (const a of CANDIDATE_ASPECTS) assert.equal(s.retention[a], retentionOver(tracks, W, H, 0, 10, a));
  assert.equal(s.speakerRetention, undefined, "no ASD given, so no speakerRetention row");
});

test("summarizeRetention includes speakerRetention only when ASD data is given", () => {
  const tracks = [track(1, 0.5, 0, 4)];
  const activeTrack = Array(16).fill(1);
  const s = summarizeRetention(tracks, W, H, 4, activeTrack, 0.25)!;
  assert.ok(s.speakerRetention);
  assert.equal(s.speakerRetention!["9:16"], 1);
});

// ── phase 30: cropWidthFor per aspect ───────────────────────────────────────────

test("cropWidthFor widens monotonically from 9:16 to 16:9 on a 16:9 source", () => {
  const widths = CANDIDATE_ASPECTS.map((a) => cropWidthFor(W, H, a));
  for (let i = 1; i < widths.length; i++) assert.ok(widths[i] > widths[i - 1], `${CANDIDATE_ASPECTS[i]} did not widen`);
  assert.ok(Math.abs(widths[0] - 9 / 16 / (W / H)) < 1e-9, "9:16 regressed from the pre-phase-30 formula");
  assert.equal(cropWidthFor(W, H, "16:9"), 1, "16:9 on a 16:9 source should be the whole frame");
});

test("a wide window on a 9:16 source still clamps to 1 — never exceeds the frame", () => {
  for (const a of CANDIDATE_ASPECTS) assert.equal(cropWidthFor(1080, 1920, a), 1);
});

test("cropWidthFor defaults to 9:16 and never NaNs on an unknown source", () => {
  assert.equal(cropWidthFor(0, 0), Math.min(1, 9 / 16));
  assert.equal(cropWidthFor(0, 0, "16:9"), 1);
});
