# AI Editing Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Shorts Studio's 3-style static caption/layout system with an AI-chosen combinatorial system — 36 caption looks, 12 layout/effect templates, 5 meme display modes, cached Google Fonts, content-mode targeting, and a monetization-risk gate.

**Architecture:** No new services. Extends the existing single-AI-call pipeline (`researchTrends` → `planClips` → `renderClip`/`renderThumbnail`). Two new small modules (`fonts.ts`, `memes.ts`) for external asset fetching with local caching and DI'd fetch functions for testability. `edit.ts` gains pure string-building functions (caption ASS generation, layout filter graphs, meme overlay filters) that are unit-tested without invoking ffmpeg, plus one real-ffmpeg smoke test at the end using synthetic `lavfi` sources (no checked-in video fixtures needed).

**Tech Stack:** TypeScript (Node 20+, ESM, `tsx`), Express, ffmpeg/ffprobe (CLI, `node:child_process`), Node's built-in `node:test` + `node:assert` (zero new test dependency), Giphy API v1, Google Fonts Developer API v1.

## Global Constraints

- Node 20+, ESM (`"type": "module"` in package.json) — all imports use `.js` extensions per existing pattern (see `edit.ts` importing `./download.js`).
- No new runtime dependencies beyond what's already installed — font/meme fetching uses global `fetch` (Node 20 built-in), test runner is Node's built-in `node:test`.
- `.env` gains two new keys: `GIPHY_API_KEY`, `GOOGLE_FONTS_API_KEY`. Both optional at startup — missing key degrades gracefully (skip meme/font fetch, fall back), never crashes the job.
- `monetizationFlag` never blocks rendering — informational only, every clip renders regardless of `risky`.
- All new ffmpeg filter-graph builders are pure functions (string in, string out) — no ffmpeg invocation inside them — so they're unit-testable without spawning processes. Only the final integration task runs real ffmpeg, using `lavfi` synthetic sources so no video fixture files are needed in the repo.
- Follow existing code patterns: `Record<Type, ...>` lookup tables (like current `STYLES`), `run()` from `download.ts` for spawning ffmpeg/ffprobe, `.js` import extensions, no classes — plain functions and interfaces throughout, matching the existing pipeline files.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/jobs.ts` | *(modify)* type definitions: `ContentMode`, `CaptionAnimation`, `CaptionPalette`, `LayoutTemplate`, `MemeDisplayMode`, `MemeOverlay`, updated `ClipPlan`/`Job` |
| `server/pipeline/captions.ts` | *(new)* pure ASS-text generation: emphasis-word parsing, word-timing interpolation, animation/palette tag builders, dynamic style-line builder |
| `server/pipeline/fonts.ts` | *(new)* `resolveFont()` — local cache check → Google Fonts API fetch → fallback |
| `server/pipeline/layouts.ts` | *(new)* pure filter-graph string builders, one per `LayoutTemplate`, plus meme-overlay filter builders per `MemeDisplayMode` |
| `server/pipeline/memes.ts` | *(new)* `fetchMemeAsset()` — Giphy API search + download |
| `server/pipeline/edit.ts` | *(modify)* `buildAss` rewritten to use `captions.ts`; `renderClip` wired to use `layouts.ts` + `fonts.ts` + `memes.ts` |
| `server/pipeline/analyze.ts` | *(modify)* prompt extended with new fields; sanity-clamp loop extracted into testable `sanitizePlan()`; prompt string extracted into testable `buildPlanPrompt()` |
| `server/index.ts` | *(modify)* accept `controversialMode` from request body, pass through to `createJob`/`planClips` |
| `public/index.html` | *(modify)* controversial-content checkbox, content-mode/layout/risk badges on output cards |
| `package.json` | *(modify)* add `"test"` script using `node --import tsx --test` |
| `*.test.ts` files | co-located next to each new/modified pipeline file |

---

### Task 1: Test runner setup

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `npm test` command every later task's tests run under.

- [ ] **Step 1: Add the test script**

In `package.json`, add to `"scripts"`:

```json
"test": "node --import tsx --test 'server/**/*.test.ts'"
```

Full `scripts` block becomes:

```json
"scripts": {
  "dev": "tsx watch server/index.ts",
  "start": "tsx server/index.ts",
  "test": "node --import tsx --test 'server/**/*.test.ts'"
}
```

- [ ] **Step 2: Write a throwaway smoke test to verify the runner works**

Create `server/smoke.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

Run: `npm test`
Expected: `# pass 1`, exit code 0.

- [ ] **Step 4: Delete the throwaway test and commit**

```bash
rm server/smoke.test.ts
git add package.json
git commit -m "test: add node:test runner (no new dependency)"
```

---

### Task 2: Data model types

**Files:**
- Modify: `server/jobs.ts`

**Interfaces:**
- Produces: `ContentMode`, `CaptionAnimation`, `CaptionPalette`, `LayoutTemplate`, `MemeDisplayMode` (all string union types), `MemeOverlay` interface, updated `ClipPlan` interface, `Job.controversialMode: boolean`, updated `createJob` input to accept `controversialMode`.

- [ ] **Step 1: Replace `CaptionStyle` and add the new unions**

In `server/jobs.ts`, replace line 4 (`export type CaptionStyle = "pop" | "minimal" | "hype";`) with:

```ts
export type ContentMode = "funny" | "gaming" | "political";

export type CaptionAnimation =
  | "karaoke-reveal"
  | "punch-scale-bounce"
  | "typewriter"
  | "slide-up"
  | "shake"
  | "glitch-rgb-split";

export type CaptionPalette =
  | "gaming-neon"
  | "meme-comic"
  | "news-serious"
  | "hype-yellow"
  | "pop-white-red"
  | "minimal-clean";

export type LayoutTemplate =
  | "fullscreen"
  | "blurred-fill"
  | "meme-corner"
  | "zoom-punch"
  | "shake-on-beat"
  | "speed-ramp"
  | "vignette-pulse"
  | "glitch-cut"
  | "color-grade-pop"
  | "split-screen-duo"
  | "letterbox-cinematic"
  | "freeze-frame-callout";

export type MemeDisplayMode =
  | "corner-overlay"
  | "full-cutaway"
  | "pip-bounce"
  | "sticker-pop"
  | "side-by-side-split";

export interface MemeOverlay {
  start: number;   // seconds, relative to clip start
  end: number;
  query: string;   // Giphy search term
  display: MemeDisplayMode;
}
```

- [ ] **Step 2: Update `ClipPlan`**

Replace the `ClipPlan` interface (lines 8-21) with:

```ts
export interface ClipPlan {
  index: number;
  title: string;
  hook: string;
  start: number;
  end: number;
  reason: string;
  script: string;
  hashtags: string[];
  thumbnailText: string;
  thumbnailTimestamp: number;
  captions: { start: number; end: number; text: string }[]; // text may contain **punch words**
  contentMode: ContentMode;
  captionAnimation: CaptionAnimation;
  captionPalette: CaptionPalette;
  captionFont: string;              // Google Fonts family name, AI-chosen
  layoutTemplate: LayoutTemplate;
  memes: MemeOverlay[];
  monetizationFlag: { risky: boolean; reasons: string[] };
}
```

- [ ] **Step 3: Update `Job` and `createJob`**

In the `Job` interface, add after `description: string;`:

```ts
  controversialMode: boolean; // default false — safe clip-selection bias
```

In `createJob`'s input type, add `controversialMode: boolean;` alongside the other fields (it's spread via `...input` into `job`, no other change needed there).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors in `edit.ts` and `analyze.ts` (they still reference the old `CaptionStyle`/`captionStyle`) — this is expected, those get fixed in Tasks 4 and 8. Confirm `jobs.ts` itself has no errors by checking the output doesn't mention `jobs.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/jobs.ts
git commit -m "feat: replace CaptionStyle with combinatorial caption/layout/meme types"
```

---

### Task 3: Caption emphasis parsing + word timing interpolation

**Files:**
- Create: `server/pipeline/captions.ts`
- Test: `server/pipeline/captions.test.ts`

**Interfaces:**
- Produces:
  - `parseEmphasis(text: string): { word: string; punch: boolean }[]`
  - `splitWordsWithTiming(group: { start: number; end: number; text: string }): { word: string; punch: boolean; start: number; end: number }[]`
- Consumes: nothing (pure functions, first module in the chain).

- [ ] **Step 1: Write the failing tests**

Create `server/pipeline/captions.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEmphasis, splitWordsWithTiming } from "./captions.js";

test("parseEmphasis strips ** markers and flags punch words", () => {
  const result = parseEmphasis("this is **so** cool");
  assert.deepEqual(result, [
    { word: "this", punch: false },
    { word: "is", punch: false },
    { word: "so", punch: true },
    { word: "cool", punch: false },
  ]);
});

test("parseEmphasis handles no markers", () => {
  const result = parseEmphasis("plain text here");
  assert.deepEqual(result, [
    { word: "plain", punch: false },
    { word: "text", punch: false },
    { word: "here", punch: false },
  ]);
});

test("parseEmphasis handles multi-word emphasis spans", () => {
  const result = parseEmphasis("**wait for it**");
  assert.deepEqual(result, [
    { word: "wait", punch: true },
    { word: "for", punch: true },
    { word: "it", punch: true },
  ]);
});

test("splitWordsWithTiming interpolates evenly across the group window", () => {
  const words = splitWordsWithTiming({ start: 10, end: 12, text: "four little test words" });
  assert.equal(words.length, 4);
  assert.equal(words[0].word, "four");
  assert.equal(words[0].start, 10);
  assert.equal(words[3].end, 12);
  // each word gets an equal 0.5s slice of the 2s window
  assert.ok(Math.abs(words[1].start - 10.5) < 0.001);
  assert.ok(Math.abs(words[2].start - 11) < 0.001);
});

test("splitWordsWithTiming carries punch flags through", () => {
  const words = splitWordsWithTiming({ start: 0, end: 1, text: "no **way** dude" });
  assert.deepEqual(words.map((w) => w.punch), [false, true, false]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="parseEmphasis|splitWordsWithTiming"`
Expected: FAIL — `Cannot find module './captions.js'`

- [ ] **Step 3: Implement**

Create `server/pipeline/captions.ts`:

```ts
export interface EmphasisWord {
  word: string;
  punch: boolean;
}

export interface TimedWord extends EmphasisWord {
  start: number;
  end: number;
}

/** Strip **markers** from caption text and flag which words were emphasized. */
export function parseEmphasis(text: string): EmphasisWord[] {
  const tokens: EmphasisWord[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const isPunch = part.startsWith("**") && part.endsWith("**");
    const clean = isPunch ? part.slice(2, -2) : part;
    for (const word of clean.trim().split(/\s+/).filter(Boolean)) {
      tokens.push({ word, punch: isPunch });
    }
  }
  return tokens;
}

/**
 * Split a transcript-timed caption group into per-word events, linearly
 * interpolating each word's sub-timestamp across the group's window.
 *
 * ponytail: no real per-word alignment exists from platform subtitles —
 * this is an even-split approximation. Upgrade path: forced alignment
 * (e.g. whisper word timestamps) if visual quality demands tighter sync.
 */
export function splitWordsWithTiming(group: { start: number; end: number; text: string }): TimedWord[] {
  const words = parseEmphasis(group.text);
  if (words.length === 0) return [];
  const slice = (group.end - group.start) / words.length;
  return words.map((w, i) => ({
    ...w,
    start: group.start + i * slice,
    end: group.start + (i + 1) * slice,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all 5 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/captions.ts server/pipeline/captions.test.ts
git commit -m "feat: caption emphasis parsing and per-word timing interpolation"
```

---

### Task 4: Animation/palette ASS tag builders + dynamic style line

**Files:**
- Modify: `server/pipeline/captions.ts`
- Modify: `server/pipeline/captions.test.ts`

**Interfaces:**
- Consumes: `TimedWord` from Task 3.
- Produces:
  - `PALETTES: Record<CaptionPalette, { normal: string; punch: string; outline: string; back: string }>` (ASS `&HAABBGGRR` color strings)
  - `buildWordOverrideTags(word: TimedWord, animation: CaptionAnimation, palette: CaptionPalette): string` — returns the ASS override-tag block (`{...}`) for one word event
  - `buildStyleLine(palette: CaptionPalette, font: string, fontsize: number): string` — one `Style:` line for the `[V4+ Styles]` section

- [ ] **Step 1: Write the failing tests**

Append to `server/pipeline/captions.test.ts`:

```ts
import { buildWordOverrideTags, buildStyleLine, PALETTES } from "./captions.js";

test("PALETTES has all 6 palettes with valid ASS color format", () => {
  const names = ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"] as const;
  for (const name of names) {
    const p = PALETTES[name];
    assert.ok(p, `missing palette ${name}`);
    for (const key of ["normal", "punch", "outline", "back"] as const) {
      assert.match(p[key], /^&H[0-9A-Fa-f]{8}$/, `${name}.${key} is not a valid ASS color`);
    }
  }
});

test("buildWordOverrideTags applies punch color+scale only to punch words", () => {
  const punch = buildWordOverrideTags({ word: "wow", punch: true, start: 0, end: 1 }, "punch-scale-bounce", "hype-yellow");
  const normal = buildWordOverrideTags({ word: "ok", punch: false, start: 0, end: 1 }, "punch-scale-bounce", "hype-yellow");
  assert.match(punch, /\\fscx1[3-9]\d/); // scaled up
  assert.equal(normal.includes("\\fscx1"), false); // no upscale on normal words
});

test("buildWordOverrideTags produces a distinct tag shape per animation", () => {
  const word = { word: "hi", punch: false, start: 0, end: 1 };
  const karaoke = buildWordOverrideTags(word, "karaoke-reveal", "pop-white-red");
  const typewriter = buildWordOverrideTags(word, "typewriter", "pop-white-red");
  const slide = buildWordOverrideTags(word, "slide-up", "pop-white-red");
  const shake = buildWordOverrideTags(word, "shake", "pop-white-red");
  const glitch = buildWordOverrideTags(word, "glitch-rgb-split", "pop-white-red");
  assert.ok(karaoke.includes("\\fad"));
  assert.equal(typewriter.includes("\\fad"), false); // instant cut-in, no fade
  assert.match(slide, /\\move\(/);
  assert.match(shake, /\\frz/);
  assert.match(glitch, /\\1c&H|\\3c&H/); // color-channel override present
});

test("buildStyleLine embeds font name and size", () => {
  const line = buildStyleLine("minimal-clean", "Inter", 64);
  assert.match(line, /^Style: Cap,Inter,64,/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `buildWordOverrideTags`, `buildStyleLine`, `PALETTES` not exported.

- [ ] **Step 3: Implement**

Append to `server/pipeline/captions.ts`:

```ts
import type { CaptionAnimation, CaptionPalette } from "../jobs.js";

/** ASS colors are &HAABBGGRR (alpha, blue, green, red — note the reversed order). */
export const PALETTES: Record<CaptionPalette, { normal: string; punch: string; outline: string; back: string }> = {
  "gaming-neon":    { normal: "&H00FFFFFF", punch: "&H00FF00D7", outline: "&H00000000", back: "&H96000000" },
  "meme-comic":     { normal: "&H00FFFFFF", punch: "&H000080FF", outline: "&H00000000", back: "&H96000000" },
  "news-serious":   { normal: "&H00F0F0F0", punch: "&H00E0E0E0", outline: "&H00202020", back: "&HB4000000" },
  "hype-yellow":    { normal: "&H0000FFFF", punch: "&H000000FF", outline: "&H00000000", back: "&H96000000" },
  "pop-white-red":  { normal: "&H00FFFFFF", punch: "&H000000FF", outline: "&H00000000", back: "&H96000000" },
  "minimal-clean":  { normal: "&H00FFFFFF", punch: "&H00FFFFFF", outline: "&H00000000", back: "&HB4000000" },
};

/** Build the ASS override-tag block ({...}) for one word event. */
export function buildWordOverrideTags(
  word: { word: string; punch: boolean },
  animation: CaptionAnimation,
  palette: CaptionPalette
): string {
  const colors = PALETTES[palette];
  const colorTag = word.punch ? `\\c${colors.punch}` : `\\c${colors.normal}`;
  const punchScale = word.punch ? "\\fscx135\\fscy135" : "";

  switch (animation) {
    case "karaoke-reveal":
      return `{${colorTag}${punchScale}\\fad(50,0)}`;
    case "punch-scale-bounce":
      return word.punch
        ? `{${colorTag}\\t(0,120,\\fscx145\\fscy145)\\t(120,220,\\fscx100\\fscy100)}`
        : `{${colorTag}}`;
    case "typewriter":
      return `{${colorTag}${punchScale}}`; // no \fad — instant cut-in
    case "slide-up":
      return `{${colorTag}${punchScale}\\move(540,1000,540,940,0,120)}`;
    case "shake":
      return word.punch
        ? `{${colorTag}\\t(0,60,\\frz-4)\\t(60,120,\\frz4)\\t(120,180,\\frz0)}`
        : `{${colorTag}}`;
    case "glitch-rgb-split":
      return `{${colorTag}${punchScale}\\1c&H00FF00\\3c&H00FFFF\\fad(0,40)}`;
    default:
      return `{${colorTag}}`;
  }
}

/** One [V4+ Styles] "Style:" line for a given palette+font+size. */
export function buildStyleLine(palette: CaptionPalette, font: string, fontsize: number): string {
  const c = PALETTES[palette];
  return `Style: Cap,${font},${fontsize},${c.normal},&H000000FF,${c.outline},${c.back},-1,0,0,0,100,100,0,0,1,5,2,2,60,60,260,1`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/captions.ts server/pipeline/captions.test.ts
git commit -m "feat: per-animation ASS tag builders and dynamic style line"
```

---

### Task 5: Rewrite `buildAss` to use word-level events

**Files:**
- Modify: `server/pipeline/edit.ts`
- Test: `server/pipeline/edit.test.ts`

**Interfaces:**
- Consumes: `splitWordsWithTiming`, `buildWordOverrideTags`, `buildStyleLine` from `captions.ts` (Tasks 3-4).
- Produces: `buildAss(plan: ClipPlan, outPath: string, fontFile: string): void` (signature gains a `fontFile` param — the resolved local font path's family name, wired in Task 8).

- [ ] **Step 1: Write the failing test**

Create `server/pipeline/edit.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAss } from "./edit.js";
import type { ClipPlan } from "../jobs.js";

function samplePlan(overrides: Partial<ClipPlan> = {}): ClipPlan {
  return {
    index: 0,
    title: "t",
    hook: "watch this",
    start: 0,
    end: 10,
    reason: "r",
    script: "s",
    hashtags: [],
    thumbnailText: "t",
    thumbnailTimestamp: 1,
    captions: [{ start: 0, end: 2, text: "this is **so** cool" }],
    contentMode: "funny",
    captionAnimation: "punch-scale-bounce",
    captionPalette: "pop-white-red",
    captionFont: "Anton",
    layoutTemplate: "fullscreen",
    memes: [],
    monetizationFlag: { risky: false, reasons: [] },
    ...overrides,
  };
}

test("buildAss writes one Dialogue event per word plus the hook", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan(), outPath);
  const content = readFileSync(outPath, "utf8");
  const dialogueLines = content.split("\n").filter((l) => l.startsWith("Dialogue:"));
  // 4 words ("this","is","so","cool") + 1 hook line = 5
  assert.equal(dialogueLines.length, 5);
});

test("buildAss embeds the chosen font and palette in the style line", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan({ captionFont: "Bebas Neue" }), outPath);
  const content = readFileSync(outPath, "utf8");
  assert.match(content, /Style: Cap,Bebas Neue,/);
});

test("buildAss escapes braces and backslashes in caption text", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ass-test-"));
  const outPath = path.join(dir, "test.ass");
  buildAss(samplePlan({ captions: [{ start: 0, end: 1, text: "weird{text}\\here" }] }), outPath);
  const content = readFileSync(outPath, "utf8");
  assert.equal(content.includes("{text}"), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — current `buildAss` produces phrase-level events (2 Dialogue lines: hook + 1 phrase), test expects 5.

- [ ] **Step 3: Implement**

In `server/pipeline/edit.ts`, replace the `STYLES` constant, `assTime`, `esc`, and `buildAss` (lines 6-61) with:

```ts
import { splitWordsWithTiming, buildWordOverrideTags, buildStyleLine } from "./captions.js";

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function esc(t: string) {
  return t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

/** Build an .ass subtitle file for one clip (word-level captions + 2s opening hook). */
export function buildAss(plan: ClipPlan, outPath: string) {
  const dur = plan.end - plan.start;
  const events: string[] = [];
  const fontsize = plan.captionPalette === "news-serious" ? 58 : 72;

  // opening hook with a pop-in scale animation
  events.push(
    `Dialogue: 1,${assTime(0)},${assTime(Math.min(2.2, dur))},Hook,,0,0,0,,{\\fad(120,150)\\t(0,180,\\fscx110\\fscy110)\\t(180,320,\\fscx100\\fscy100)}${esc(plan.hook)}`
  );

  for (const group of plan.captions) {
    const start = Math.max(0, Math.min(group.start, dur));
    const end = Math.max(start + 0.2, Math.min(group.end, dur));
    const words = splitWordsWithTiming({ start, end, text: group.text });
    for (const w of words) {
      const tags = buildWordOverrideTags(w, plan.captionAnimation, plan.captionPalette);
      events.push(
        `Dialogue: 0,${assTime(w.start)},${assTime(w.end)},Cap,,0,0,0,,${tags}${esc(w.word)}`
      );
    }
  }

  const capStyle = buildStyleLine(plan.captionPalette, plan.captionFont, fontsize);
  const hookStyle = `Style: Hook,${plan.captionFont},${fontsize + 14},&H0000D7FF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,8,60,60,120,1`;

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${capStyle}
${hookStyle}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
  writeFileSync(outPath, ass, "utf8");
}
```

Leave `renderClip`, `renderThumbnail`, `getDuration` untouched for now — they're updated in Task 8.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all `edit.test.ts` and `captions.test.ts` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/edit.ts server/pipeline/edit.test.ts
git commit -m "feat: word-level karaoke-style ASS caption rendering"
```

---

### Task 6: Font resolution with local cache

**Files:**
- Create: `server/pipeline/fonts.ts`
- Test: `server/pipeline/fonts.test.ts`

**Interfaces:**
- Produces: `resolveFont(family: string, opts?: { fontsDir?: string; fetchFn?: typeof fetch; apiKey?: string }): Promise<string>` — returns a local `.ttf` file path. Always succeeds (falls back to bundled `Anton` on any failure).

- [ ] **Step 1: Write the failing tests**

Create `server/pipeline/fonts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFont } from "./fonts.js";

test("resolveFont returns the cached file without fetching on cache hit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fake-font-bytes");
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;

  const result = await resolveFont("Anton", { fontsDir: dir, fetchFn: fakeFetch });
  assert.equal(result, path.join(dir, "Anton.ttf"));
  assert.equal(fetchCalled, false);
});

test("resolveFont fetches and caches on cache miss", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes"); // bundled fallback present

  const fakeFetch = (async (url: string) => {
    if (url.includes("googleapis.com/webfonts")) {
      return new Response(JSON.stringify({
        items: [{ family: "Bebas Neue", files: { regular: "https://fonts.example/bebas.ttf" } }],
      }));
    }
    if (url === "https://fonts.example/bebas.ttf") {
      return new Response(new Uint8Array([1, 2, 3]));
    }
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const result = await resolveFont("Bebas Neue", { fontsDir: dir, fetchFn: fakeFetch, apiKey: "fake-key" });
  assert.equal(result, path.join(dir, "Bebas Neue.ttf"));
  assert.ok(existsSync(result));
});

test("resolveFont falls back to Anton when fetch fails and no cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes");

  const fakeFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const result = await resolveFont("SomeObscureFont", { fontsDir: dir, fetchFn: fakeFetch, apiKey: "fake-key" });
  assert.equal(result, path.join(dir, "Anton.ttf"));
});

test("resolveFont falls back to Anton when no API key configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes");

  const result = await resolveFont("SomeFont", { fontsDir: dir, apiKey: undefined });
  assert.equal(result, path.join(dir, "Anton.ttf"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './fonts.js'`

- [ ] **Step 3: Implement**

Create `server/pipeline/fonts.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_FONTS_DIR = path.resolve("fonts");
const FALLBACK_FAMILY = "Anton";

interface ResolveFontOpts {
  fontsDir?: string;
  fetchFn?: typeof fetch;
  apiKey?: string;
}

/**
 * Resolve a Google Fonts family name to a local .ttf path.
 * Cache hit -> return immediately. Cache miss -> fetch from the Google
 * Fonts Developer API and cache. Any failure (missing key, network error,
 * unknown family) -> fall back to the bundled "Anton" font so rendering
 * never blocks on network.
 */
export async function resolveFont(family: string, opts: ResolveFontOpts = {}): Promise<string> {
  const fontsDir = opts.fontsDir ?? DEFAULT_FONTS_DIR;
  mkdirSync(fontsDir, { recursive: true });
  const cachedPath = path.join(fontsDir, `${family}.ttf`);
  const fallbackPath = path.join(fontsDir, `${FALLBACK_FAMILY}.ttf`);

  if (existsSync(cachedPath)) return cachedPath;

  const apiKey = opts.apiKey ?? process.env.GOOGLE_FONTS_API_KEY;
  if (!apiKey) return fallbackPath;

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const metaRes = await fetchFn(
      `https://www.googleapis.com/webfonts/v1/webfonts?key=${apiKey}&family=${encodeURIComponent(family)}`
    );
    const meta = await metaRes.json() as { items?: { family: string; files: Record<string, string> }[] };
    const item = meta.items?.[0];
    if (!item) return fallbackPath;
    const fileUrl = item.files["700"] ?? item.files["regular"];
    if (!fileUrl) return fallbackPath;

    const fontRes = await fetchFn(fileUrl);
    const bytes = new Uint8Array(await fontRes.arrayBuffer());
    writeFileSync(cachedPath, bytes);
    return cachedPath;
  } catch {
    return fallbackPath;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all `fonts.test.ts` tests PASS.

- [ ] **Step 5: Download the bundled fallback font**

The `fonts/` directory needs a real `Anton.ttf` checked in so the fallback path always works even with zero network. Run:

```bash
mkdir -p fonts
curl -sL -o fonts/Anton.ttf "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf"
```

Verify: `file fonts/Anton.ttf` should report a TrueType font, not an HTML error page.

- [ ] **Step 6: Commit**

```bash
git add server/pipeline/fonts.ts server/pipeline/fonts.test.ts fonts/Anton.ttf
git commit -m "feat: cached Google Fonts resolution with offline fallback"
```

Note: `.gitignore` currently excludes `fonts/` (added for generated/cached fonts). Add an exception so the bundled fallback is tracked while cache downloads stay ignored — update `.gitignore`:

```
fonts/*
!fonts/Anton.ttf
```

```bash
git add .gitignore
git commit -m "chore: track bundled Anton fallback font, ignore cached downloads"
```

---

### Task 7: Layout/effect filter-graph builders

**Files:**
- Create: `server/pipeline/layouts.ts`
- Test: `server/pipeline/layouts.test.ts`

**Interfaces:**
- Consumes: `LayoutTemplate`, `ClipPlan` from `jobs.ts`.
- Produces: `buildLayoutFilter(template: LayoutTemplate, plan: ClipPlan): string` — returns an ffmpeg `-vf`-compatible filter chain (comma-joined, no `crop`/`scale`/`ass` — those get prepended by the caller in Task 8).

- [ ] **Step 1: Write the failing tests**

Create `server/pipeline/layouts.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLayoutFilter } from "./layouts.js";
import type { ClipPlan, LayoutTemplate } from "../jobs.js";

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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './layouts.js'`

- [ ] **Step 3: Implement**

Create `server/pipeline/layouts.ts`:

```ts
import type { ClipPlan, LayoutTemplate } from "../jobs.js";

/**
 * Pure ffmpeg filter-chain builders per layout template. Each returns a
 * comma-joinable filter fragment (no crop/scale/ass — the caller composes
 * those around this). Empty string means "no extra filter beyond the base
 * crop/scale" (fullscreen, meme-corner reserve no extra filter here — the
 * meme-corner reservation happens via the meme overlay step in layouts.ts's
 * overlay builders, not here).
 */
export function buildLayoutFilter(template: LayoutTemplate, plan: ClipPlan): string {
  switch (template) {
    case "fullscreen":
      return "";
    case "meme-corner":
      return "";
    case "blurred-fill":
      return "split=2[bg][fg];[bg]scale=1080:1920,boxblur=20:5[bgblur];[fg]scale=1080:960[fgsharp];[bgblur][fgsharp]overlay=0:0";
    case "zoom-punch":
      return "zoompan=z='if(lte(mod(t,2),0.3),1.08,1.0)':d=1:s=1080x1920";
    case "shake-on-beat":
      return "crop=iw-20:ih-20:10+5*sin(t*30):10+5*cos(t*30)";
    case "speed-ramp":
      return "setpts=if(lt(mod(t\\,10)\\,1)\\,2.0*PTS\\,PTS)";
    case "vignette-pulse":
      return "vignette=PI/4+0.1*sin(t*3)";
    case "glitch-cut":
      return "rgbashift=rh=4:bh=-4:rv=2:bv=-2";
    case "color-grade-pop":
      return plan.contentMode === "gaming"
        ? "eq=saturation=1.5:contrast=1.15"
        : plan.contentMode === "political"
          ? "curves=preset=cross_process,eq=saturation=0.9"
          : "eq=saturation=1.3:contrast=1.1"; // funny
    case "split-screen-duo":
      return "split=2[top][bottom];[top]crop=iw:ih/2:0:0,scale=1080:960[t2];[bottom]crop=iw:ih/2:0:ih/2,scale=1080:960[b2];[t2][b2]vstack";
    case "letterbox-cinematic":
      return "pad=1080:1920:0:120:black";
    case "freeze-frame-callout":
      return "tpad=stop_mode=clone:stop_duration=0.6";
    default:
      return "";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all `layouts.test.ts` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/layouts.ts server/pipeline/layouts.test.ts
git commit -m "feat: 12 pure ffmpeg layout/effect filter-graph builders"
```

---

### Task 8: Meme overlay filter builders (per display mode)

**Files:**
- Modify: `server/pipeline/layouts.ts`
- Modify: `server/pipeline/layouts.test.ts`

**Interfaces:**
- Consumes: `MemeOverlay`, `MemeDisplayMode` from `jobs.ts`.
- Produces: `buildMemeOverlayFilter(meme: MemeOverlay, memeInputLabel: string, baseLabel: string, outputLabel: string): string` — one `filter_complex` fragment per meme, composable into a chain.

- [ ] **Step 1: Write the failing tests**

Append to `server/pipeline/layouts.test.ts`:

```ts
import { buildMemeOverlayFilter } from "./layouts.js";
import type { MemeOverlay, MemeDisplayMode } from "../jobs.js";

function sampleMeme(display: MemeDisplayMode): MemeOverlay {
  return { start: 1, end: 3, query: "shocked cat", display };
}

test("every meme display mode produces an overlay filter referencing base and meme labels", () => {
  const modes: MemeDisplayMode[] = ["corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split"];
  for (const mode of modes) {
    const filter = buildMemeOverlayFilter(sampleMeme(mode), "[meme0]", "[base]", "[out0]");
    assert.ok(filter.includes("[meme0]"), `${mode} missing meme input label`);
    assert.ok(filter.includes("[base]"), `${mode} missing base input label`);
    assert.ok(filter.includes("[out0]"), `${mode} missing output label`);
    assert.ok(filter.includes("overlay"), `${mode} missing overlay filter`);
  }
});

test("meme overlay filter respects the start/end timing window", () => {
  const filter = buildMemeOverlayFilter(sampleMeme("corner-overlay"), "[meme0]", "[base]", "[out0]");
  assert.match(filter, /enable='between\(t,1,3\)'/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `buildMemeOverlayFilter` not exported.

- [ ] **Step 3: Implement**

Append to `server/pipeline/layouts.ts`:

```ts
import type { MemeOverlay } from "../jobs.js";

/**
 * Build one filter_complex fragment compositing a meme input over the base
 * video for its [start,end] window, per display mode. baseLabel/memeLabel
 * are existing filter_complex node labels (e.g. "[base]", "[meme0]");
 * outputLabel is the new node this fragment produces (e.g. "[out0]").
 */
export function buildMemeOverlayFilter(
  meme: MemeOverlay,
  memeLabel: string,
  baseLabel: string,
  outputLabel: string
): string {
  const window = `enable='between(t,${meme.start},${meme.end})'`;

  switch (meme.display) {
    case "corner-overlay":
      return `${memeLabel}scale=320:-1[m];${baseLabel}[m]overlay=W-w-40:H-h-400:${window}${outputLabel}`;
    case "full-cutaway":
      return `${memeLabel}scale=1080:1920[m];${baseLabel}[m]overlay=0:0:${window}${outputLabel}`;
    case "pip-bounce":
      return `${memeLabel}scale=300:-1[m];${baseLabel}[m]overlay=x='(W-w)*abs(sin(t))':y='(H-h)*abs(cos(t))':${window}${outputLabel}`;
    case "sticker-pop":
      return `${memeLabel}scale=360:-1[m];${baseLabel}[m]overlay=x='(W-w)/2':y='H*0.3':${window}${outputLabel}`;
    case "side-by-side-split":
      return `${memeLabel}scale=540:1920[m];${baseLabel}crop=540:1920:0:0[left];[left][m]hstack${outputLabel}`;
    default:
      return `${baseLabel}copy${outputLabel}`;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all `layouts.test.ts` tests PASS (7 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/layouts.ts server/pipeline/layouts.test.ts
git commit -m "feat: 5 meme-overlay filter builders per display mode"
```

---

### Task 9: Meme asset fetching (Tenor)

**Files:**
- Create: `server/pipeline/memes.ts`
- Test: `server/pipeline/memes.test.ts`

**Interfaces:**
- Produces: `fetchMemeAsset(query: string, opts?: { destDir?: string; apiKey?: string; fetchFn?: typeof fetch }): Promise<string | null>` — downloads the top Tenor result's mp4, returns the local path or `null` on any failure.

- [ ] **Step 1: Write the failing tests**

Create `server/pipeline/memes.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchMemeAsset } from "./memes.js";

test("fetchMemeAsset returns null when no API key configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: undefined });
  assert.equal(result, null);
});

test("fetchMemeAsset downloads the top result on success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async (url: string) => {
    if (url.includes("tenor.googleapis.com")) {
      return new Response(JSON.stringify({
        results: [{ media_formats: { mp4: { url: "https://tenor.example/clip.mp4" } } }],
      }));
    }
    if (url === "https://tenor.example/clip.mp4") {
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.ok(result);
  assert.ok(existsSync(result!));
});

test("fetchMemeAsset returns null when Tenor returns no results", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async () => new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch;
  const result = await fetchMemeAsset("obscure query", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});

test("fetchMemeAsset returns null on network failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module './memes.js'`

- [ ] **Step 3: Implement**

Create `server/pipeline/memes.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

interface FetchMemeOpts {
  destDir?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Search Tenor for `query`, download the top result's mp4 into destDir.
 * Returns null on any failure (missing key, no results, network error) —
 * caller skips that meme slot, job keeps rendering.
 */
export async function fetchMemeAsset(query: string, opts: FetchMemeOpts = {}): Promise<string | null> {
  const apiKey = opts.apiKey ?? process.env.TENOR_API_KEY;
  if (!apiKey) return null;

  const destDir = opts.destDir ?? path.resolve("storage", "memes-cache");
  const fetchFn = opts.fetchFn ?? fetch;

  try {
    mkdirSync(destDir, { recursive: true });
    const searchRes = await fetchFn(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${apiKey}&limit=1&media_filter=mp4`
    );
    const data = await searchRes.json() as { results?: { media_formats?: { mp4?: { url: string } } }[] };
    const mp4Url = data.results?.[0]?.media_formats?.mp4?.url;
    if (!mp4Url) return null;

    const fileRes = await fetchFn(mp4Url);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const outPath = path.join(destDir, `${nanoid(8)}.mp4`);
    writeFileSync(outPath, bytes);
    return outPath;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all `memes.test.ts` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/memes.ts server/pipeline/memes.test.ts
git commit -m "feat: Tenor meme/GIF asset fetching with graceful failure"
```

---

### Task 10: Wire layouts + fonts + memes into `renderClip`

**Files:**
- Modify: `server/pipeline/edit.ts`
- Modify: `server/pipeline/edit.test.ts`

**Interfaces:**
- Consumes: `buildLayoutFilter`, `buildMemeOverlayFilter` (Tasks 7-8), `resolveFont` (Task 6), `fetchMemeAsset` (Task 9), `buildAss` (Task 5).
- Produces: `renderClip(sourceVideo: string, plan: ClipPlan, outDir: string, onLine: (l: string) => void): Promise<string>` — same signature as before, now internally resolves font/layout/memes.

- [ ] **Step 1: Write the failing smoke test**

Append to `server/pipeline/edit.test.ts`:

```ts
import { renderClip } from "./edit.js";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

test("renderClip produces a valid mp4 for every layout template using a synthetic source", { timeout: 120_000 }, async () => {
  // Generate a tiny synthetic source video via ffmpeg's lavfi testsrc — no
  // checked-in video fixture needed.
  const dir = mkdtempSync(path.join(tmpdir(), "render-test-"));
  const sourcePath = path.join(dir, "source.mp4");
  const { execFileSync } = await import("node:child_process");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=5:size=1280x720:rate=30",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", "5", "-c:v", "libx264", "-c:a", "aac", sourcePath,
  ]);

  const templates: ClipPlan["layoutTemplate"][] = [
    "fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat",
    "speed-ramp", "vignette-pulse", "glitch-cut", "color-grade-pop",
    "split-screen-duo", "letterbox-cinematic", "freeze-frame-callout",
  ];

  for (const layoutTemplate of templates) {
    const plan = samplePlan({ start: 0, end: 3, layoutTemplate, captions: [{ start: 0, end: 2, text: "test **word**" }] });
    const outPath = await renderClip(sourcePath, plan, dir, () => {});
    assert.ok(existsSync(outPath), `${layoutTemplate} did not produce an output file`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="renderClip"`
Expected: FAIL or errors — current `renderClip` doesn't call `buildLayoutFilter`/`resolveFont`, and `buildAss` call site needs the new signature check. (If it happens to pass because `fullscreen`'s empty-string filter is a no-op, the later templates like `blurred-fill` will fail on `ffmpeg` filter errors since they're not yet wired in.)

- [ ] **Step 3: Implement**

In `server/pipeline/edit.ts`, replace the `renderClip` function with:

```ts
import { buildLayoutFilter, buildMemeOverlayFilter } from "./layouts.js";
import { resolveFont } from "./fonts.js";
import { fetchMemeAsset } from "./memes.js";

export async function renderClip(
  sourceVideo: string,
  plan: ClipPlan,
  outDir: string,
  onLine: (l: string) => void
): Promise<string> {
  ensureDir(outDir);
  const assPath = path.join(outDir, `clip${plan.index}.ass`);
  buildAss(plan, assPath);
  const outPath = path.join(outDir, `clip${plan.index}.mp4`);
  const assFilter = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

  const fontPath = await resolveFont(plan.captionFont);
  const fontsDir = path.dirname(fontPath).replace(/\\/g, "/").replace(/:/g, "\\:");

  const layoutFilter = buildLayoutFilter(plan.layoutTemplate, plan);
  const baseChain = [
    "crop=ih*9/16:ih",
    "scale=1080:1920",
    ...(layoutFilter ? [layoutFilter] : []),
    `ass='${assFilter}':fontsdir='${fontsDir}'`,
  ].join(",");

  // Resolve meme assets (best-effort — missing/failed ones are skipped).
  const resolvedMemes: { meme: typeof plan.memes[number]; assetPath: string }[] = [];
  for (const meme of plan.memes) {
    const assetPath = await fetchMemeAsset(meme.query);
    if (assetPath) resolvedMemes.push({ meme, assetPath });
    else onLine(`⚠️ Meme fetch skipped for "${meme.query}" — no result or missing TENOR_API_KEY`);
  }

  if (resolvedMemes.length === 0) {
    // No memes to composite: simple single -vf chain, same as before.
    await run(
      "ffmpeg",
      [
        "-y", "-ss", String(plan.start), "-to", String(plan.end), "-i", sourceVideo,
        "-vf", baseChain,
        "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
        outPath,
      ],
      onLine
    );
    return outPath;
  }

  // With memes: build a filter_complex chaining the base video through the
  // layout/caption filter, then compositing each meme overlay in sequence.
  const inputs = ["-ss", String(plan.start), "-to", String(plan.end), "-i", sourceVideo];
  const complexParts: string[] = [`[0:v]${baseChain}[base]`];
  let prevLabel = "[base]";
  resolvedMemes.forEach(({ meme }, i) => {
    inputs.push("-i", resolvedMemes[i].assetPath);
    const outLabel = `[out${i}]`;
    complexParts.push(buildMemeOverlayFilter(meme, `[${i + 1}:v]`, prevLabel, outLabel));
    prevLabel = outLabel;
  });

  await run(
    "ffmpeg",
    [
      "-y", ...inputs,
      "-filter_complex", complexParts.join(";"),
      "-map", prevLabel, "-map", "0:a",
      "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      outPath,
    ],
    onLine
  );
  return outPath;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- --test-name-pattern="renderClip"`
Expected: PASS — 12 output files produced, one per layout template. (This test spawns real ffmpeg processes across 12 templates; expect it to take 30-90 seconds.)

Then run the full suite to confirm nothing else broke:

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/pipeline/edit.ts server/pipeline/edit.test.ts
git commit -m "feat: wire layout templates, cached fonts, and meme overlays into renderClip"
```

---

### Task 11: `analyze.ts` — prompt fields, `sanitizePlan`, `buildPlanPrompt`, controversial-mode + monetization flag

**Files:**
- Modify: `server/pipeline/analyze.ts`
- Test: `server/pipeline/analyze.test.ts`

**Interfaces:**
- Produces:
  - `sanitizePlan(p: Partial<ClipPlan>, videoDuration: number): ClipPlan` — pure function, default-fills/clamps every field (extracted from the current inline loop in `planClips`, extended for new fields).
  - `buildPlanPrompt(args: { transcript: string; trendBrief: string; descriptionSection: string; clipCount: number; videoDuration: number; controversialMode: boolean }): string` — pure function, the prompt text itself.
  - `planClips(...)` signature gains a `controversialMode: boolean` parameter, threaded through to `buildPlanPrompt` and used to post-process via `sanitizePlan`.

- [ ] **Step 1: Write the failing tests**

Create `server/pipeline/analyze.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePlan, buildPlanPrompt } from "./analyze.js";

test("sanitizePlan clamps clip duration and timestamps", () => {
  const p = sanitizePlan({ index: 0, start: -5, end: 1000, captions: [] } as any, 100);
  assert.equal(p.start, 0);
  assert.equal(p.end, 100);
});

test("sanitizePlan defaults missing enum fields instead of throwing", () => {
  const p = sanitizePlan({ index: 0, start: 0, end: 20 } as any, 100);
  assert.equal(p.contentMode, "funny");
  assert.equal(p.layoutTemplate, "fullscreen");
  assert.equal(p.captionAnimation, "karaoke-reveal");
  assert.equal(p.captionPalette, "pop-white-red");
  assert.equal(p.captionFont, "Anton");
  assert.deepEqual(p.memes, []);
  assert.deepEqual(p.monetizationFlag, { risky: false, reasons: [] });
});

test("sanitizePlan preserves valid provided values", () => {
  const p = sanitizePlan({
    index: 0, start: 0, end: 20, contentMode: "gaming", layoutTemplate: "zoom-punch",
    monetizationFlag: { risky: true, reasons: ["profanity"] },
  } as any, 100);
  assert.equal(p.contentMode, "gaming");
  assert.equal(p.layoutTemplate, "zoom-punch");
  assert.deepEqual(p.monetizationFlag, { risky: true, reasons: ["profanity"] });
});

test("buildPlanPrompt instructs safe selection when controversialMode is false", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: false,
  });
  assert.match(prompt, /avoid clips centered on hate speech/i);
});

test("buildPlanPrompt instructs controversial content is allowed when true", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: true,
  });
  assert.match(prompt, /explicitly permitted/i);
});

test("buildPlanPrompt always requires monetizationFlag in the output schema", () => {
  const prompt = buildPlanPrompt({
    transcript: "t", trendBrief: "b", descriptionSection: "", clipCount: 3,
    videoDuration: 100, controversialMode: true,
  });
  assert.match(prompt, /monetizationFlag/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --test-name-pattern="sanitizePlan|buildPlanPrompt"`
Expected: FAIL — neither function exported yet.

- [ ] **Step 3: Implement**

In `server/pipeline/analyze.ts`:

Replace `const GEMINI_MODEL ...` line's neighboring imports section — add at top:

```ts
import type { ClipPlan, AiProvider, ContentMode, CaptionAnimation, CaptionPalette, LayoutTemplate } from "../jobs.js";
```

(Replace the existing `import type { ClipPlan, AiProvider } from "../jobs.js";` line with the above.)

Add these two new exported functions before `planClips` (after `complete()`):

```ts
const VALID_CONTENT_MODES: ContentMode[] = ["funny", "gaming", "political"];
const VALID_ANIMATIONS: CaptionAnimation[] = ["karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split"];
const VALID_PALETTES: CaptionPalette[] = ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"];
const VALID_LAYOUTS: LayoutTemplate[] = ["fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat", "speed-ramp", "vignette-pulse", "glitch-cut", "color-grade-pop", "split-screen-duo", "letterbox-cinematic", "freeze-frame-callout"];

/** Default-fill and clamp every field of a raw AI-returned clip plan. Never throws. */
export function sanitizePlan(p: Partial<ClipPlan> & { index: number }, videoDuration: number): ClipPlan {
  let start = Math.max(0, p.start ?? 0);
  let end = Math.min(videoDuration, p.end ?? start + 25);
  if (end - start > 59) end = start + 58;
  if (end - start < 15) end = Math.min(videoDuration, start + 25);
  const thumbnailTimestamp = Math.min(Math.max(p.thumbnailTimestamp ?? start, start), end);

  return {
    index: p.index,
    title: p.title ?? "",
    hook: p.hook ?? "",
    start,
    end,
    reason: p.reason ?? "",
    script: p.script ?? "",
    hashtags: p.hashtags ?? [],
    thumbnailText: p.thumbnailText ?? "",
    thumbnailTimestamp,
    captions: (p.captions ?? []).filter((c) => c.end > c.start),
    contentMode: VALID_CONTENT_MODES.includes(p.contentMode as ContentMode) ? (p.contentMode as ContentMode) : "funny",
    captionAnimation: VALID_ANIMATIONS.includes(p.captionAnimation as CaptionAnimation) ? (p.captionAnimation as CaptionAnimation) : "karaoke-reveal",
    captionPalette: VALID_PALETTES.includes(p.captionPalette as CaptionPalette) ? (p.captionPalette as CaptionPalette) : "pop-white-red",
    captionFont: p.captionFont ?? "Anton",
    layoutTemplate: VALID_LAYOUTS.includes(p.layoutTemplate as LayoutTemplate) ? (p.layoutTemplate as LayoutTemplate) : "fullscreen",
    memes: p.memes ?? [],
    monetizationFlag: p.monetizationFlag ?? { risky: false, reasons: [] },
  };
}

/** Build the planClips prompt text. Pure function — no API call — for testability. */
export function buildPlanPrompt(args: {
  transcript: string;
  trendBrief: string;
  descriptionSection: string;
  clipCount: number;
  videoDuration: number;
  controversialMode: boolean;
}): string {
  const monetizationInstruction = args.controversialMode
    ? `Edgy, opinionated, or politically controversial moments are explicitly permitted — the creator has opted in to controversial content.`
    : `Actively avoid clips centered on hate speech, graphic violence, sexual content, harassment, or dangerous misinformation — prefer the next-best safe moment from the transcript instead.`;

  return `You are a viral shorts editor for the Indian market.

TREND BRIEF (current Indian shorts trends):
${args.trendBrief}
${args.descriptionSection}
FULL VIDEO TRANSCRIPT with [start-end] second timestamps (video duration ${args.videoDuration.toFixed(0)}s):
${args.transcript}

Task: choose exactly ${args.clipCount} clips for YouTube Shorts. Rules:
- Each clip 20-58 seconds long, must start/end at natural sentence boundaries from the transcript.
- Prioritize moments matching the trend brief AND the creator instructions: strong hooks, emotion, payoff, controversy, "wait for it" moments.
- Clips must not overlap.
- captions: word-grouped caption chunks (2-5 words each) covering the clip's speech, with start/end in seconds RELATIVE TO THE CLIP START, derived from the transcript timing. Wrap the single most important word or short phrase per chunk in **double asterisks** to mark it for visual emphasis (e.g. "this is **insane**").
- contentMode: classify the clip as "funny", "gaming", or "political" based on its content and tone.
- captionAnimation: pick per clip from "karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split" — whichever suits the clip's energy.
- captionPalette: pick per clip from "gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean" — match to contentMode (e.g. gaming -> gaming-neon, political -> news-serious).
- captionFont: pick a bold, high-impact Google Fonts family name appropriate to the palette (e.g. "Anton", "Bebas Neue", "Luckiest Guy", "Archivo Black", "Poppins", "Montserrat").
- layoutTemplate: pick per clip from "fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat", "speed-ramp", "vignette-pulse", "glitch-cut", "color-grade-pop", "split-screen-duo", "letterbox-cinematic", "freeze-frame-callout".
- memes: an array (can be empty) of {start, end, query, display} for moments where a meme/reaction GIF would land well. display is one of "corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split". query is a short search term (e.g. "shocked cat", "mind blown").
- monetizationFlag: {risky: boolean, reasons: string[]} — your honest self-assessment of demonetization risk for this clip's content (hate speech, graphic violence, sexual content, harassment, dangerous misinformation, excessive profanity). ${monetizationInstruction}
- thumbnailTimestamp: an absolute second in the source video with a strong facial expression or key visual for that clip.
- hashtags: 5-8, mix of English + Hindi/Hinglish, India-relevant.
- title: <=90 chars, curiosity-driven, no clickbait lies.
- hook: <=8 words shown on screen for the first 2 seconds.
- script: a 2-3 sentence description of the clip's narrative arc (used for description text).

Respond ONLY with a JSON array of ${args.clipCount} objects with keys:
index, title, hook, start, end, reason, script, hashtags, thumbnailText, thumbnailTimestamp, captions, contentMode, captionAnimation, captionPalette, captionFont, layoutTemplate, memes, monetizationFlag.
No markdown fences, no commentary.`;
}
```

Now update `planClips` itself — replace the function body (keep the signature line but add `controversialMode`):

```ts
export async function planClips(
  transcript: Segment[],
  clipCount: number,
  trendBrief: string,
  videoDuration: number,
  provider: AiProvider,
  userDescription: string,
  controversialMode: boolean
): Promise<ClipPlan[]> {
  const compact = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n")
    .slice(0, 180_000);

  const descriptionSection = userDescription.trim()
    ? `\nADDITIONAL CREATOR INSTRUCTIONS (high priority — incorporate these into clip selection, hooks and scripts):\n${userDescription.trim()}\n`
    : "";

  const prompt = buildPlanPrompt({
    transcript: compact,
    trendBrief,
    descriptionSection,
    clipCount,
    videoDuration,
    controversialMode,
  });

  const text = (await complete(provider, prompt, 8000))
    .replace(/```json|```/g, "")
    .trim();

  const rawPlans = JSON.parse(text) as (Partial<ClipPlan> & { index: number })[];
  return rawPlans.map((p) => sanitizePlan(p, videoDuration));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `analyze.ts`. `index.ts` will still show an error (missing `controversialMode` arg to `planClips`) — fixed in Task 12.

- [ ] **Step 6: Commit**

```bash
git add server/pipeline/analyze.ts server/pipeline/analyze.test.ts
git commit -m "feat: content-mode, monetization flag, and controversial-mode toggle in clip planning"
```

---

### Task 12: Wire `controversialMode` through `jobs.ts` / `index.ts`

**Files:**
- Modify: `server/index.ts`

**Interfaces:**
- Consumes: `Job.controversialMode` (Task 2), `planClips(..., controversialMode)` (Task 11).

- [ ] **Step 1: Read request body field and pass through `createJob`**

In `server/index.ts`, in the `app.post("/api/jobs", ...)` handler, after the `description` line, add:

```ts
  const controversialMode = req.body.controversialMode === "true" || req.body.controversialMode === true;
```

Update the `createJob({...})` call to include `controversialMode`.

- [ ] **Step 2: Pass it to `planClips`**

In `runPipeline`, update the `planClips(...)` call to add `job.controversialMode` as the final argument:

```ts
  const plans = await planClips(
    job.transcript,
    job.clipCount,
    job.trendBrief,
    duration,
    job.aiProvider,
    job.description,
    job.controversialMode
  );
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: zero errors across the whole project.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat: accept controversialMode from job submission, thread to planClips"
```

---

### Task 13: Add `TENOR_API_KEY` / `GOOGLE_FONTS_API_KEY` to env files

**Files:**
- Modify: `.env`
- Modify: `.env.example`

- [ ] **Step 1: Add the new keys**

In `.env.example`, add:

```
TENOR_API_KEY=
GOOGLE_FONTS_API_KEY=
```

In `.env`, add the same two lines (leave values blank — user fills in their own keys, or leaves blank to accept the graceful-skip/fallback behavior).

- [ ] **Step 2: Commit** (`.env.example` only — `.env` stays gitignored)

```bash
git add .env.example
git commit -m "docs: document TENOR_API_KEY and GOOGLE_FONTS_API_KEY in .env.example"
```

---

### Task 14: UI — controversial-content toggle + output card badges

**Files:**
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `Job.controversialMode` (submitted), `ClipPlan.contentMode`/`layoutTemplate`/`monetizationFlag` (rendered on output cards).

- [ ] **Step 1: Add the checkbox to the intake form**

In `public/index.html`, find the description `<textarea>` block (around line 377-390, the "User description / trend notes" section). Immediately after that closing `</div>`, add:

```html
<div class="field-group">
  <label class="section-label" style="display:flex;align-items:center;gap:10px;cursor:pointer;">
    <input type="checkbox" id="controversialMode" />
    Allow controversial/edgy content (disables the safe-content selection bias)
  </label>
</div>
```

- [ ] **Step 2: Include it in the job submission**

Find the `submit` handler (around line 528-550, where `description` is read and appended to `fd`). Add:

```js
const controversialMode = document.getElementById("controversialMode").checked;
```

Add to the `fd.append(...)` calls: `fd.append("controversialMode", String(controversialMode));`

Also find the JSON-body fallback path (around line 557, `body: JSON.stringify({ url, clipCount, aiProvider: provider, description })`) and add `controversialMode` to that object.

- [ ] **Step 3: Replace the caption-style chip with content-mode/layout/risk badges**

Find line 485 (`<span class="style-chip">${p.captionStyle} captions</span>`) inside `renderOutputs`. Replace with:

```html
<span class="style-chip">${p.contentMode} · ${p.layoutTemplate}</span>
${p.monetizationFlag?.risky ? `<span class="badge" style="background:#majoritybf3d00;color:#fff" title="${(p.monetizationFlag.reasons || []).join(', ')}">⚠ monetization risk</span>` : ""}
```

(Use the existing `.badge`/`.style-chip` CSS classes already defined at the top of the file — no new styles needed.)

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open `http://localhost:5177`. Confirm:
- The "Allow controversial/edgy content" checkbox renders under the description field.
- Submitting a job with the checkbox unchecked completes without error (check server log shows `controversialMode: false` reaching `planClips` — add a temporary `console.log(job.controversialMode)` in `runPipeline` if needed, then remove it).
- Once a job completes, each output card shows a `contentMode · layoutTemplate` chip instead of the old `captionStyle captions` chip, and a risk badge appears only on clips where the AI set `monetizationFlag.risky: true`.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: controversial-content toggle and content-mode/layout/risk badges in UI"
```

---

### Task 15: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the pipeline description**

Update step 4 and step 5 of the numbered pipeline list (currently lines 10-11) to reflect the new system:

```markdown
4. **Plan clips** — Claude reads the full timestamped transcript + trend brief, picks non-overlapping 20–58s moments, and writes for each: title, hook, script, hashtags, word-grouped emphasis-marked captions, a content mode (funny/gaming/political), a caption animation + palette + font, a layout/effect template, meme/GIF placements, and a monetization-risk self-assessment.
5. **Auto-edit** — ffmpeg cuts each clip, applies the AI-chosen layout/effect filter graph, composites any meme/GIF overlays (via Giphy), and burns word-level karaoke-style animated captions using the AI-chosen animation + palette + Google Font (cached locally after first use).
```

Update the "Notes" section (currently lines 34-40) — replace the "Caption styles live in..." line with:

```markdown
- Caption animations/palettes live in `server/pipeline/captions.ts`, layout/effect templates in `server/pipeline/layouts.ts` — both are plain lookup functions, easy to extend with new options.
- Meme/GIF insertion requires `GIPHY_API_KEY` in `.env` (free from Giphy's developer portal) — without it, meme placements are silently skipped and clips render without them.
- Fonts are fetched from Google Fonts on first use per family (needs `GOOGLE_FONTS_API_KEY`) and cached in `fonts/` — subsequent jobs reuse the cached file, no repeat network calls.
- The "Allow controversial/edgy content" toggle only shifts the AI's clip-*selection* bias — every clip renders regardless, monetization risk is always surfaced as an informational badge, never a block.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README for the AI editing upgrade"
```

---

## Self-Review Notes

**Spec coverage:** caption engine v2 (Tasks 3-5), font resolution (Task 6), layout/effect templates (Task 7), meme overlay display modes (Task 8), meme fetching (Task 9), full renderClip integration (Task 10), content-mode/monetization/controversial-toggle (Task 11-12), env docs (Task 13), UI (Task 14), README (Task 15). All 7 spec sections have a corresponding task.

**Type consistency:** `ClipPlan` fields defined in Task 2 (`contentMode`, `captionAnimation`, `captionPalette`, `captionFont`, `layoutTemplate`, `memes`, `monetizationFlag`) are used with identical names/types in every downstream task (`captions.ts`, `edit.ts`, `layouts.ts`, `analyze.ts`, `index.html`). `buildLayoutFilter`/`buildMemeOverlayFilter`/`resolveFont`/`fetchMemeAsset`/`sanitizePlan`/`buildPlanPrompt` signatures match between their defining task and every consuming task.

**Error handling:** font-fetch failure → bundled `Anton` fallback (Task 6); meme-fetch failure → skipped slot + warning log, never fails the job (Task 9-10); malformed/partial AI JSON → `sanitizePlan` default-fills every field instead of throwing (Task 11); monetization flag never blocks rendering anywhere in the chain.
