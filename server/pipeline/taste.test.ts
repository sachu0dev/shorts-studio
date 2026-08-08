import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTastePrompt, validateTasteResponse } from "./taste.js";
import type { Composition, LayoutMode } from "./router.js";
import type { TimedWord } from "./captions.js";

function comp(overrides: Partial<Composition> = {}): Composition {
  return {
    schemaVersion: 5,
    clipId: "clip1",
    compositionType: "talking-head",
    allowedModes: ["fullscreen-follow", "static-center"] as LayoutMode[],
    routedReason: "test",
    mode: "fullscreen-follow",
    preset: "calm",
    canvas: { w: 1080, h: 1920 },
    cropWidth: 0.5625,
    layoutTimeline: [
      { t0: 0, t1: 5, mode: "fullscreen-follow", target: 1, frameAspect: "9:16", fill: "blur" },
      { t0: 5, t1: 10, mode: "fullscreen-follow", target: 1, frameAspect: "9:16", fill: "blur" },
    ],
    cameraPath: [],
    heldSegments: 2,
    suppressedSwitches: 0,
    ...overrides,
  };
}

test("mode outside allowedModes is dropped, router's timeline kept", () => {
  const c = comp();
  const raw = { layoutTimeline: [{ t0: 0, t1: 10, mode: "split-screen", target: 1 }], effects: [] };
  const r = validateTasteResponse(raw, c);
  assert.deepEqual(r.layoutTimeline, c.layoutTimeline);
  assert.ok(r.taste.rejected.some((x) => x.why.includes("not in allowedModes")));
});

test("a target that isn't a real track is dropped", () => {
  const c = comp();
  const raw = { layoutTimeline: [{ t0: 0, t1: 10, mode: "fullscreen-follow", target: 999 }] };
  const r = validateTasteResponse(raw, c);
  assert.deepEqual(r.layoutTimeline, c.layoutTimeline);
  assert.ok(r.taste.rejected.some((x) => x.why.includes("not a real track id")));
});

test("a segment below min-hold is merged into its neighbour, not dropped", () => {
  const c = comp();
  const raw = {
    layoutTimeline: [
      { t0: 0, t1: 5, mode: "fullscreen-follow", target: 1 },
      { t0: 5, t1: 5.3, mode: "static-center", target: 1 }, // 0.3s, below calm's 2.5s minHold
      { t0: 5.3, t1: 10, mode: "fullscreen-follow", target: 1 },
    ],
  };
  const r = validateTasteResponse(raw, c);
  // the short middle segment's [5, 5.3) window is absorbed into the segment before it
  assert.equal(r.layoutTimeline.length, 2);
  assert.equal(r.layoutTimeline[0].t1, 5.3);
  assert.equal(r.taste.fellBackToRouter, false);
});

test("a gap in the returned timeline rebuilds from the router timeline", () => {
  const c = comp();
  const raw = { layoutTimeline: [{ t0: 0, t1: 4, mode: "fullscreen-follow", target: 1 }] }; // ends at 4, clip is 10s
  const r = validateTasteResponse(raw, c);
  assert.deepEqual(r.layoutTimeline, c.layoutTimeline);
  assert.equal(r.taste.fellBackToRouter, true);
  assert.ok(r.taste.rejected.some((x) => x.segment === -1));
});

test("unparseable JSON returns the router timeline unchanged, applied: false", () => {
  const c = comp();
  const r = validateTasteResponse("{not json", c);
  assert.deepEqual(r.layoutTimeline, c.layoutTimeline);
  assert.equal(r.taste.applied, false);
  assert.equal(r.taste.fellBackToRouter, true);
  assert.deepEqual(r.effects, []);
});

test("an effect not in the valid list is dropped; the segment (layoutTimeline) survives", () => {
  const c = comp();
  const raw = {
    layoutTimeline: [
      { t0: 0, t1: 5, mode: "fullscreen-follow", target: 1 },
      { t0: 5, t1: 10, mode: "fullscreen-follow", target: 1 },
    ],
    effects: [{ t0: 0, t1: 2, template: "zoom-punch" }], // removed in phase 6, not a valid template
  };
  const r = validateTasteResponse(raw, c);
  assert.equal(r.effects.length, 0);
  assert.equal(r.layoutTimeline.length, 2);
});

test("an effect window outside clip bounds is clamped, not dropped", () => {
  const c = comp();
  const raw = { effects: [{ t0: -5, t1: 999, template: "color-grade-pop" }] };
  const r = validateTasteResponse(raw, c);
  assert.equal(r.effects.length, 1);
  assert.equal(r.effects[0].t0, 0);
  assert.equal(r.effects[0].t1, 10);
});

test("buildTastePrompt includes allowedModes and never includes a disallowed mode", () => {
  // Fixture must stay internally consistent: a real Composition's own
  // current mode always comes from its own allowedModes.
  const c = comp({
    allowedModes: ["static-center"] as LayoutMode[],
    mode: "static-center",
    layoutTimeline: [{ t0: 0, t1: 10, mode: "static-center", target: 1 }],
  });
  const words: TimedWord[] = [{ word: "hi", punch: false, start: 0, end: 1 }];
  const prompt = buildTastePrompt(c, null, words);
  assert.ok(prompt.includes("static-center"));
  const ALL_MODES: LayoutMode[] = [
    "static-center", "fullscreen-follow", "blurred-fill", "group-crop", "camera-switch",
    "split-screen", "gameplay-facecam-stack", "gameplay-facecam-pip", "action-follow",
  ];
  for (const m of ALL_MODES) {
    if (m === "static-center") continue;
    assert.ok(!prompt.includes(`mode=${m}`), `prompt should not offer disallowed mode ${m}`);
  }
});

test("buildTastePrompt never mentions zoom-punch — removed in phase 6, not a real template", () => {
  const prompt = buildTastePrompt(comp(), null, []);
  assert.ok(!prompt.includes("zoom-punch"));
});
