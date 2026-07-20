import path from "node:path";
import { writeFileSync } from "node:fs";
import { run, ensureDir } from "./download.js";
import type { ClipPlan } from "../jobs.js";
import { splitWordsWithTiming, buildWordOverrideTags, buildStyleLine } from "./captions.js";
import { buildLayoutFilter, buildMemeOverlayFilter } from "./layouts.js";
import { resolveFont } from "./fonts.js";
import { fetchMemeAsset } from "./memes.js";

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

/**
 * Cut the clip, convert to 9:16 (center-crop), burn captions.
 * Center-crop keeps faces in frame for typical talking-head content.
 */
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
  const resolvedMemes: { meme: (typeof plan.memes)[number]; assetPath: string }[] = [];
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

/** Thumbnail: grab the chosen frame, 9:16 crop, overlay bold title text. */
export async function renderThumbnail(
  sourceVideo: string,
  plan: ClipPlan,
  outDir: string,
  onLine: (l: string) => void
): Promise<string> {
  const outPath = path.join(outDir, `clip${plan.index}_thumb.jpg`);
  const text = plan.thumbnailText.replace(/'/g, "").replace(/:/g, " ").toUpperCase();

  const vf = [
    "crop=ih*9/16:ih",
    "scale=1080:1920",
    "eq=contrast=1.08:saturation=1.25",
    `drawtext=text='${text}':fontcolor=white:fontsize=110:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h-360:font='Arial Black'`,
  ].join(",");

  await run(
    "ffmpeg",
    ["-y", "-ss", String(plan.thumbnailTimestamp), "-i", sourceVideo, "-frames:v", "1", "-vf", vf, "-q:v", "2", outPath],
    onLine
  );
  return outPath;
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
