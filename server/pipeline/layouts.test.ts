import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMemeOverlayFilter } from "./layouts.js";
import { VALID_EFFECTS } from "./taste.js";
import type { LayoutTemplate, MemeOverlay, MemeDisplayMode } from "../jobs.js";

/**
 * The layout list lives in TypeScript and the renderers live in Python, so
 * nothing but this test stops the two drifting. A template the LLM may pick
 * with no renderer behind it does not fail — it silently renders fullscreen,
 * which is exactly the kind of wrong number that sits unnoticed for a month.
 */
test("every layout template has a renderer in render.py, and vice versa", () => {
  const py = readFileSync(new URL("../../worker/stages/render.py", import.meta.url), "utf8");
  const table = py.slice(py.indexOf("\nEFFECTS = {"));
  const keys = [...table.slice(0, table.indexOf("}")).matchAll(/"([a-z-]+)":/g)].map((m) => m[1]);

  assert.ok(keys.length > 0, "could not parse the EFFECTS table out of render.py");
  for (const template of VALID_EFFECTS) {
    assert.ok(keys.includes(template), `layout "${template}" has no renderer in render.py`);
  }
  for (const key of keys) {
    assert.ok(
      VALID_EFFECTS.includes(key as LayoutTemplate),
      `render.py renders "${key}", which is not a layout the planner can pick`
    );
  }
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

test("side-by-side-split also respects its start/end timing window (not the full clip)", () => {
  const filter = buildMemeOverlayFilter(sampleMeme("side-by-side-split"), "[meme0]", "[base]", "[out0]");
  assert.match(filter, /enable='between\(t,1,3\)'/);
});
