import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { run } from "./download.js";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

function ts(t: string): number {
  // 00:01:02.500 or 01:02.500
  const parts = t.trim().split(":").map(Number.parseFloat);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/** Parse a WebVTT file into merged, de-duplicated segments. */
export function parseVtt(vttPath: string): Segment[] {
  const raw = readFileSync(vttPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const segs: Segment[] = [];
  let cur: Segment | null = null;

  for (const line of lines) {
    const m = line.match(
      /(\d{1,2}:)?\d{2}:\d{2}\.\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}\.\d{3}/
    );
    if (m) {
      const [a, b] = line.split("-->");
      if (cur && cur.text) segs.push(cur);
      cur = { start: ts(a), end: ts(b.split(" ")[1] ?? b), text: "" };
    } else if (cur && line.trim() && !line.startsWith("WEBVTT") && !line.startsWith("Kind:") && !line.startsWith("Language:")) {
      const clean = line
        .replace(/<[^>]+>/g, "") // strip inline timing tags
        .trim();
      if (clean && !cur.text.includes(clean)) {
        cur.text = (cur.text + " " + clean).trim();
      }
    }
  }
  if (cur && cur.text) segs.push(cur);

  // Auto-subs repeat lines across cues; merge consecutive duplicates
  const merged: Segment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && (s.text === last.text || last.text.endsWith(s.text))) {
      last.end = s.end;
    } else if (last && s.text.startsWith(last.text)) {
      last.text = s.text;
      last.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.filter((s) => s.text.length > 0);
}

/**
 * If no subtitles came with the video, fall back to whisper.cpp / openai-whisper
 * if installed locally ("whisper" on PATH). Produces a .vtt next to the video.
 */
export async function whisperFallback(
  videoPath: string,
  onLine: (l: string) => void
): Promise<Segment[]> {
  const dir = path.dirname(videoPath);
  const wav = path.join(dir, "audio.wav");
  await run("ffmpeg", ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", wav], onLine);
  await run(
    "whisper",
    [wav, "--model", "small", "--output_format", "vtt", "--output_dir", dir],
    onLine
  );
  const vtt = path.join(dir, "audio.vtt");
  if (!existsSync(vtt)) throw new Error("Whisper ran but produced no VTT");
  return parseVtt(vtt);
}
