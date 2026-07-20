# AI Editing Upgrade — Design Spec

Date: 2026-07-20

## Goal

Shorts Studio currently auto-edits clips with 3 static caption styles, one center-crop layout, no meme/GIF insertion, and no content-mode or monetization awareness. Every clip ends up looking the same. This spec upgrades the editing layer so the AI has a real set of caption styles, layouts, fonts, and meme placements to choose from per clip, plus content-mode targeting (funny / gaming / political) and a monetization-risk gate with a controversial-content toggle.

No new services. Everything extends the existing single-AI-call pipeline (`researchTrends` → `planClips` → `renderClip`/`renderThumbnail`) and existing ffmpeg/ASS rendering in `edit.ts`.

## Data model changes (`server/jobs.ts`)

```ts
export type ContentMode = "funny" | "gaming" | "political";

export type CaptionAnimation =
  | "karaoke-reveal" | "punch-scale-bounce" | "typewriter"
  | "slide-up" | "shake" | "glitch-rgb-split";

export type CaptionPalette =
  | "gaming-neon" | "meme-comic" | "news-serious"
  | "hype-yellow" | "pop-white-red" | "minimal-clean";

export type LayoutTemplate =
  | "fullscreen" | "blurred-fill" | "meme-corner" | "zoom-punch"
  | "shake-on-beat" | "speed-ramp" | "vignette-pulse" | "glitch-cut"
  | "color-grade-pop" | "split-screen-duo" | "letterbox-cinematic"
  | "freeze-frame-callout";

export type MemeDisplayMode =
  | "corner-overlay" | "full-cutaway" | "pip-bounce"
  | "sticker-pop" | "side-by-side-split";

export interface MemeOverlay {
  start: number;          // seconds, relative to clip start
  end: number;
  query: string;          // search term for Tenor
  display: MemeDisplayMode;
}

export interface ClipPlan {
  // ...existing fields unchanged...
  contentMode: ContentMode;
  captionAnimation: CaptionAnimation;
  captionPalette: CaptionPalette;
  captionFont: string;              // Google Fonts family name, AI-chosen
  layoutTemplate: LayoutTemplate;
  memes: MemeOverlay[];
  monetizationFlag: { risky: boolean; reasons: string[] };
  captions: { start: number; end: number; text: string }[]; // text may contain **punch words**
}

export interface Job {
  // ...existing fields unchanged...
  controversialMode: boolean;   // default false — safe clip selection bias
}
```

`CaptionStyle` (`"pop" | "minimal" | "hype"`) is removed — replaced by the `captionAnimation` × `captionPalette` pair.

## 1. Caption engine v2 (`server/pipeline/edit.ts`)

**Problem today:** each caption group is one static ASS `Dialogue` event — whole 2-5 word phrase fades in/out together, fixed font/size, 3 hardcoded styles.

**Change:**
- `buildAss` splits each caption group into **per-word events**, with each word's start/end linearly interpolated across the group's transcript-timed window (`ponytail:` approximation — no real per-word alignment available from platform subtitles; upgrade path is a forced-alignment pass if quality demands it later).
- AI marks emphasis words by wrapping them `**word**` in the caption text it already returns (no new field). `buildAss` strips the markers and applies extra ASS override tags (bigger `\fscx`/`\fscy`, accent color, bounce `\t` transform) to those words only.
- `captionAnimation` (6 options) drives which ASS override-tag pattern wraps each word event: karaoke reveal, punch-scale bounce, typewriter (instant no-fade cut-ins), slide-up (`\move`), shake (small alternating `\frz` jitter), glitch (duplicate layer with color-channel offset + slight position jitter, dropped fast).
- `captionPalette` (6 options) is a lookup table of `{fontDefaultColor, punchColor, outlineColor, backColor}` — same override-tag machinery, different colors, feeding the `[V4+ Styles]` line built per clip.
- `captionFont`: AI picks a Google Fonts family name. Default font sizes raised across all styles (current 52-70px was the "too small" complaint) — baseline 64-88px depending on palette.
- Style block is now built dynamically per clip from `(animation, palette, font)` instead of looked up from a static `STYLES` map.

## 2. Font resolution (new: `server/pipeline/fonts.ts`)

- `resolveFont(familyName): Promise<string>` — checks `fonts/<familyName>.ttf` locally first.
- Cache miss: fetch the font file from the Google Fonts API (`fonts.googleapis.com` CSS endpoint → resolves to a downloadable `.ttf`/`.woff2` URL), save into `fonts/`, return the local path.
- Fetch failure (bad name, network down): log a warning, fall back to a bundled default (`Anton`, shipped in `fonts/` at setup) — render must never block on font network calls.
- `renderClip` passes `fontsdir=<absolute fonts/ path>` to ffmpeg's `ass` filter so libass can find every cached family by name.

## 3. Layout/effect templates (`server/pipeline/edit.ts`)

`layoutTemplate` (12 options) maps to a named ffmpeg filter-graph builder function, e.g. `buildLayoutFilter(template, plan): string`. Each builder composes on top of the existing crop→scale→ass chain:

- `fullscreen` — current center-crop (unchanged baseline)
- `blurred-fill` — sharp crop top, `boxblur` + stretched full-frame duplicate filling the rest (`overlay`)
- `meme-corner` — fullscreen crop, reserves a screen region for meme overlay compositing
- `zoom-punch` — periodic `zoompan` pulses timed to caption beats
- `shake-on-beat` — small alternating crop-offset jitter on punch words
- `speed-ramp` — `setpts` slow-mo around the clip's punchline moment (from `plan.hook`/highest-emphasis caption), normal speed elsewhere
- `vignette-pulse` — `vignette` filter with intensity keyed to caption timing
- `glitch-cut` — brief RGB-channel-split + position jitter on scene-cut boundaries
- `color-grade-pop` — `eq`/`curves` grading preset per content mode (neon-saturated for gaming, teal-orange for political, warm-saturated for funny)
- `split-screen-duo` — two different crop windows of the same source stacked (wide context + close-up)
- `letterbox-cinematic` — thin top/bottom bars, paired with `news-serious` palette for political mode
- `freeze-frame-callout` — brief `tpad`/frame-freeze on the punchline with a text stamp overlay

## 4. Meme/GIF auto-insert (new: `server/pipeline/memes.ts`)

- `fetchMemeAsset(query): Promise<string | null>` — hits Tenor API (`TENOR_API_KEY` in `.env`), takes the top result's mp4 media URL, downloads into the job's output dir. Returns `null` on any failure (missing key, no results, network error) — caller skips that meme slot and logs a warning, job continues.
- `renderClip` overlay step: for each `plan.memes[]` entry with a resolved asset, composite via ffmpeg `overlay` (looped if the meme is shorter than its window) per its `display` mode:
  - `corner-overlay` — fixed small box, bottom corner
  - `full-cutaway` — meme scales to full frame for its window, base video audio ducked (`volume` filter), then returns
  - `pip-bounce` — animated `overlay` position following a DVD-bounce path expression
  - `sticker-pop` — scale-in with rotation near the triggering caption word's position, then shrinks to a corner and stays for the remainder
  - `side-by-side-split` — frame split in half, base video one side, meme the other, for the window's duration

## 5. Content-mode targeting (`server/pipeline/analyze.ts`)

- `planClips` prompt gains one more field in the same JSON response: `contentMode: "funny" | "gaming" | "political"` per clip — no extra AI call, same request.
- `contentMode` narrows the AI's suggested pool for `captionPalette`/`layoutTemplate`/meme `query` flavor and shifts hook/script tone guidance in the prompt (e.g. gaming → neon/hype energy, political → serious/measured framing even when controversial).

## 6. Monetization gate (`server/pipeline/analyze.ts`)

- `Job.controversialMode` (default `false`) is injected into the `planClips` prompt:
  - `false` (safe): "avoid clips centered on hate speech, graphic violence, sexual content, harassment, or dangerous misinformation — prefer the next-best safe moment from the transcript instead."
  - `true` (controversial allowed): "edgy, opinionated, or politically controversial moments are explicitly permitted — the creator has opted in."
- Regardless of mode, the AI **always** self-reports `monetizationFlag: {risky: boolean, reasons: string[]}` per clip. This never blocks rendering — every clip renders — it's informational only, surfaced as a UI badge so the creator decides before uploading.

## 7. UI (`public/index.html`)

- New checkbox in the intake form: "Allow controversial/edgy content" → posts `controversialMode` to `/api/jobs`.
- Output cards gain three chips/badges: content-mode chip, layout-template chip, and an amber risk badge (tooltip = `monetizationFlag.reasons`) shown only when `risky: true`.
- No new pages/routes — same SSE job-progress pattern already in place.

## Error handling

- Font fetch failure → fallback font, warning logged, render proceeds.
- Meme fetch failure (missing `TENOR_API_KEY`, no results, network error) → that meme slot skipped, warning logged, clip still renders.
- Malformed AI JSON (new fields missing/invalid) → same sanity-clamp pattern already in `planClips` extended to default-fill new fields (e.g. missing `contentMode` → `"funny"`, missing `layoutTemplate` → `"fullscreen"`) rather than throwing.

## Testing

- One ffmpeg smoke test per new layout template and per meme display mode: render a few seconds of a sample clip through each filter-graph builder, assert the output file exists and `ffprobe` reports expected duration/resolution — catches filter-graph syntax errors without needing visual review for every change.
- `fonts.ts` and `memes.ts` each get a `demo()`/assert-based self-check covering cache-hit, cache-miss, and failure-fallback paths (no network in the failure-fallback case).
