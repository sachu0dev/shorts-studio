import path from "node:path";
import { writeFileSync } from "node:fs";
import { run, ensureDir } from "./download.js";
import type { ClipPlan, CaptionStyle } from "../jobs.js";

/** ASS style templates — the "templated edits" chosen automatically per clip. */
const STYLES: Record<CaptionStyle, string> = {
  pop: `Style: Cap,Arial Black,64,&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,260,1
Style: Hook,Arial Black,78,&H0000D7FF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,8,60,60,120,1`,
  minimal: `Style: Cap,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&HB4000000,0,0,0,0,100,100,0,0,3,0,0,2,80,80,220,1
Style: Hook,Arial,64,&H00FFFFFF,&H000000FF,&H00000000,&HB4000000,-1,0,0,0,100,100,0,0,3,0,0,8,80,80,120,1`,
  hype: `Style: Cap,Arial Black,70,&H0000FFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,2,50,50,280,1
Style: Hook,Arial Black,84,&H0000FFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,4,8,50,50,120,1`,
};

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

/** Build an .ass subtitle file for one clip (captions + 2s opening hook). */
export function buildAss(plan: ClipPlan, outPath: string) {
  const dur = plan.end - plan.start;
  const events: string[] = [];

  // opening hook with a pop-in scale animation
  events.push(
    `Dialogue: 1,${assTime(0)},${assTime(Math.min(2.2, dur))},Hook,,0,0,0,,{\\fad(120,150)\\t(0,180,\\fscx110\\fscy110)\\t(180,320,\\fscx100\\fscy100)}${esc(plan.hook)}`
  );

  for (const c of plan.captions) {
    const start = Math.max(0, Math.min(c.start, dur));
    const end = Math.max(start + 0.2, Math.min(c.end, dur));
    events.push(
      `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{\\fad(60,60)}${esc(c.text)}`
    );
  }

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${STYLES[plan.captionStyle] ?? STYLES.pop}

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

  const vf = [
    "crop=ih*9/16:ih",              // center crop 16:9 -> 9:16
    "scale=1080:1920",
    `ass='${assFilter}'`,
  ].join(",");

  await run(
    "ffmpeg",
    [
      "-y",
      "-ss", String(plan.start),
      "-to", String(plan.end),
      "-i", sourceVideo,
      "-vf", vf,
      "-r", "30",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
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
