import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayoutFilter, buildMemeOverlayFilter } from "./layouts.js";
import type { ClipPlan, LayoutTemplate, MemeOverlay, MemeDisplayMode } from "../jobs.js";

function samplePlan(overrides: Partial<ClipPlan> = {}): ClipPlan {
  return {
    index: 0, title: "t", hook: "h", start: 0, end: 10, reason: "r", script: "s",
    hashtags: [], thumbnailText: "t", thumbnailTimestamp: 1,
    captions: [], contentMode: "funny", captionAnimation: "karaoke-reveal",
    captionPalette: "pop-white-red", captionFont: "Anton", layoutTemplate: "fullscreen",
    memes: [], monetizationFlag: { risky: false, reasons: [] },
    ...overrides,
  };
}

const EXPECTED_FILTER_SUBSTRING: Record<LayoutTemplate, string> = {
  "fullscreen": "",
  "blurred-fill": "boxblur",
  "meme-corner": "",
  "zoom-punch": "zoompan",
  "shake-on-beat": "crop=",
  "speed-ramp": "setpts",
  "vignette-pulse": "vignette",
  "glitch-cut": "rgbashift",
  "color-grade-pop": "eq=",
  "split-screen-duo": "vstack",
  "letterbox-cinematic": "pad=",
  "freeze-frame-callout": "tpad",
};

test("every layout template produces a non-throwing filter string", () => {
  for (const template of Object.keys(EXPECTED_FILTER_SUBSTRING) as LayoutTemplate[]) {
    const filter = buildLayoutFilter(template, samplePlan({ layoutTemplate: template }));
    assert.equal(typeof filter, "string");
    const expectedSubstr = EXPECTED_FILTER_SUBSTRING[template];
    if (expectedSubstr) {
      assert.ok(filter.includes(expectedSubstr), `${template} filter missing "${expectedSubstr}": ${filter}`);
    }
  }
});

test("color-grade-pop varies by contentMode", () => {
  const gaming = buildLayoutFilter("color-grade-pop", samplePlan({ layoutTemplate: "color-grade-pop", contentMode: "gaming" }));
  const political = buildLayoutFilter("color-grade-pop", samplePlan({ layoutTemplate: "color-grade-pop", contentMode: "political" }));
  assert.notEqual(gaming, political);
});

function sampleMeme(display: MemeDisplayMode): MemeOverlay {
  return { start: 1, end: 3, query: "shocked cat", display };
}

test("every meme display mode produces a compositing filter referencing base and meme labels", () => {
  const modes: MemeDisplayMode[] = ["corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split"];
  for (const mode of modes) {
    const filter = buildMemeOverlayFilter(sampleMeme(mode), "[meme0]", "[base]", "[out0]");
    assert.ok(filter.includes("[meme0]"), `${mode} missing meme input label`);
    assert.ok(filter.includes("[base]"), `${mode} missing base input label`);
    assert.ok(filter.includes("[out0]"), `${mode} missing output label`);
    assert.ok(filter.includes("overlay") || filter.includes("hstack"), `${mode} missing compositing filter`);
  }
});

test("meme overlay filter respects the start/end timing window", () => {
  const filter = buildMemeOverlayFilter(sampleMeme("corner-overlay"), "[meme0]", "[base]", "[out0]");
  assert.match(filter, /enable='between\(t,1,3\)'/);
});
