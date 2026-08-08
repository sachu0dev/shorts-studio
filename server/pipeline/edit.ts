import path from "node:path";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { run, ensureDir } from "./download.js";
import type { ClipPlan } from "../jobs.js";
import { buildStyleLine, groupWordsIntoPhrases, PALETTES, type TimedWord } from "./captions.js";
import { buildMemeOverlayFilter } from "./layouts.js";
import { resolveFont } from "./fonts.js";
import { fetchMemeAsset } from "./memes.js";
import { runPythonStage } from "./python.js";

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Make AI-supplied text safe inside a single-quoted ffmpeg drawtext argument.
 *
 * A backslash or apostrophe would terminate the quoted string and corrupt the
 * whole filtergraph, so both are dropped rather than escaped — thumbnail text is
 * decorative and losing a character beats losing the render. Use with
 * `expansion=none`, which is what keeps `%` literal.
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/[\\']/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/:/g, " ")
    .toUpperCase()
    .trim();
}

function esc(t: string) {
  return t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");
}

/** Build an .ass subtitle file for one clip (word-level karaoke phrase captions + top opening hook). */
export function buildAss(plan: ClipPlan, outPath: string, words: TimedWord[] = []) {
  const dur = plan.end - plan.start;
  const events: string[] = [];
  const fontsize = plan.captionPalette === "news-serious" ? 58 : 72;
  const colors = PALETTES[plan.captionPalette] || PALETTES["hype-yellow"];

  // Opening hook — placed at top center (Alignment 8) so it never collides with bottom captions
  events.push(
    `Dialogue: 1,${assTime(0)},${assTime(Math.min(2.5, dur))},Hook,,0,0,0,,{\\fad(120,150)\\t(0,180,\\fscx110\\fscy110)\\t(180,320,\\fscx100\\fscy100)}${esc(plan.hook)}`
  );

  // Timings come from WhisperX forced alignment — 3-4 word phrase cards with active word karaoke highlighting.
  const groups = groupWordsIntoPhrases(words, 4);
  for (const group of groups) {
    for (const activeWord of group.words) {
      const start = Math.max(0, Math.min(activeWord.start, dur));
      const end = Math.max(start + 0.05, Math.min(activeWord.end, dur));

      const lineParts: string[] = [];
      for (const w of group.words) {
        if (w === activeWord) {
          const tags = w.punch
            ? `{\\c${colors.punch}\\t(0,100,\\fscx135\\fscy135)\\t(100,200,\\fscx100\\fscy100)}`
            : `{\\c${colors.punch}\\fscx115\\fscy115}`;
          lineParts.push(`${tags}${esc(w.word)}{\\r}`);
        } else {
          lineParts.push(`{\\c${colors.normal}}${esc(w.word)}`);
        }
      }
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${lineParts.join(" ")}`);
    }
  }

  const capStyle = buildStyleLine(plan.captionPalette, plan.captionFont, fontsize);
  // Alignment 8 (top center), MarginV 180 — clear of bottom captions (Alignment 2, MarginV 260)
  const hookStyle = `Style: Hook,${plan.captionFont},${fontsize + 14},&H0000D7FF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,8,60,60,180,1`;

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

/**
 * Cut the clip, convert to 9:16 (center-crop), burn captions.
 *
 * Node builds the composition request; `worker/stages/render.py` composites the
 * frames and drives NVENC. Framing is unchanged from the old ffmpeg `-vf` chain
 * — a fixed centered crop — so a visual diff here is a bug, not a feature.
 *
 * Returns the clip path. The stage's real artifact is `render/<clipId>.json`,
 * written by Python (same pattern as transcribe and scenes).
 */
export async function renderClip(
  sourceVideo: string,
  plan: ClipPlan,
  jobDir: string,
  outDir: string,
  onLine: (l: string) => void,
  words: TimedWord[] = [],
  clipId: string = `clip${plan.index}`
): Promise<string> {
  ensureDir(outDir);
  const assPath = path.join(outDir, `${clipId}.ass`);
  buildAss(plan, assPath, words);
  const outPath = path.join(outDir, `${clipId}.mp4`);
  const fontPath = await resolveFont(plan.captionFont);

  // Memes stay an ffmpeg concern: they are extra inputs on the encoder command
  // that already exists, and Giphy assets are animated files OpenCV would have
  // to decode itself. Resolution is best-effort — CLAUDE.md rule 5.
  const memeInputs: string[] = [];
  const memeParts: string[] = [];
  let finalLabel = "[base]";
  for (const meme of plan.memes) {
    const assetPath = await fetchMemeAsset(meme.query);
    if (!assetPath) {
      onLine(`⚠️ Meme fetch skipped for "${meme.query}" — no result or missing GIPHY_API_KEY`);
      continue;
    }
    // input 0 is the raw frame pipe and input 1 is the source (audio), so meme
    // inputs start at 2 — render.py appends them in exactly this order.
    const label = `[out${memeInputs.length}]`;
    memeParts.push(buildMemeOverlayFilter(meme, `[${memeInputs.length + 2}:v]`, finalLabel, label));
    memeInputs.push(assetPath);
    finalLabel = label;
  }

  // The compose stage already wrote the edit decision (route, camera path,
  // layout timeline). This adds the render inputs to the same file, so there is
  // one artifact per clip explaining one edit rather than two half-explanations.
  const compDir = path.join(jobDir, "composition");
  const compPath = path.join(compDir, `${clipId}.json`);
  const decision = existsSync(compPath) ? JSON.parse(readFileSync(compPath, "utf8")) : {};
  const dur = plan.end - plan.start;
  const composition = {
    schemaVersion: 1,
    clipId,
    compositionType: plan.compositionType ?? null,
    mode: "static-center",
    cameraPath: [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1.0 }],
    ...decision,
    // Phase 12 makes `effects` multi-segment; today one template spans the clip.
    effects: [{ t0: 0, t1: dur, template: plan.layoutTemplate }],
    // Paths inside the job dir are relative so phase 23 can move the store.
    // Fonts and meme assets are machine-local caches outside it — absolute.
    source: path.relative(jobDir, sourceVideo),
    start: plan.start,
    end: plan.end,
    out: path.relative(jobDir, outPath),
    ass: path.relative(jobDir, assPath),
    fontsDir: path.dirname(fontPath),
    contentMode: plan.contentMode,
    memeInputs,
    memeFilter: memeParts.join(";"),
    finalLabel,
  };
  mkdirSync(compDir, { recursive: true });
  writeFileSync(compPath, JSON.stringify(composition, null, 2));

  await runPythonStage("render", jobDir, onLine, ["--clip-id", clipId]);
  return outPath;
}

/** Thumbnail: grab the chosen frame, 9:16 crop, overlay bold title text. */
export async function renderThumbnail(
  sourceVideo: string,
  plan: ClipPlan,
  outDir: string,
  onLine: (l: string) => void,
  clipId: string = `clip${plan.index}`
): Promise<string> {
  const outPath = path.join(outDir, `${clipId}_thumb.jpg`);

  const vf = [
    "crop=ih*9/16:ih",
    "scale=1080:1920",
    "eq=contrast=1.08:saturation=1.25",
    // expansion=none makes "%" literal — without it drawtext reads %{...} as a
    // format sequence and a title like "80% Traders Lose" fails the whole render.
    `drawtext=text='${escapeDrawtext(plan.thumbnailText)}':expansion=none:fontcolor=white:fontsize=110:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h-360:font='Arial Black'`,
  ].join(",");

  await run(
    "ffmpeg",
    ["-y", "-ss", String(plan.thumbnailTimestamp), "-i", sourceVideo, "-frames:v", "1", "-vf", vf, "-q:v", "2", outPath],
    onLine
  );
  return outPath;
}

/**
 * Joins already-rendered segment clips into one file, in the given order.
 * Every segment came out of the same render pipeline (identical codec,
 * resolution, fps, pix_fmt), so this is a stream copy, not a re-encode —
 * ffmpeg's concat demuxer, not `-vf`.
 */
export async function concatClips(segmentPaths: string[], outPath: string, onLine: (l: string) => void): Promise<void> {
  const listPath = `${outPath}.concat.txt`;
  const list = segmentPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join("\n");
  writeFileSync(listPath, list, "utf8");
  try {
    await run("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath], onLine);
  } finally {
    rmSync(listPath, { force: true });
  }
}

export async function getDuration(videoPath: string): Promise<number> {
  let out = "";
  await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", videoPath],
    (l) => (out += l)
  );
  const d = Number.parseFloat(out);
  if (!Number.isFinite(d)) throw new Error("Could not read video duration");
  return d;
}
