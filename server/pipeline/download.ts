import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

export function run(cmd: string, args: string[], onLine?: (l: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const handle = (buf: Buffer) => {
      buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => onLine?.(l));
    };
    p.stdout.on("data", handle);
    p.stderr.on("data", handle);
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))
    );
  });
}

/**
 * Downloads the video (mp4, <=1080p to keep ffmpeg fast) and English/Hindi
 * auto-subtitles if available. Returns { videoPath, subPath? }.
 */
export async function downloadVideo(
  url: string,
  destDir: string,
  onLine: (l: string) => void
): Promise<{ videoPath: string; subPath?: string }> {
  mkdirSync(destDir, { recursive: true });
  const outTemplate = path.join(destDir, "source.%(ext)s");

  try {
    await run(
      "yt-dlp",
      [
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
        "--merge-output-format", "mp4",
        "--write-auto-subs", "--write-subs",
        "--sub-langs", "en.*,en",
        "--sub-format", "vtt",
        "-o", outTemplate,
        "--no-playlist",
        url,
      ],
      onLine
    );
  } catch (err: any) {
    // If yt-dlp exited with non-zero (e.g. subtitle 429 rate limit for specific sub language),
    // check if the mp4 video file was downloaded successfully anyway.
    const files = existsSync(destDir) ? readdirSync(destDir) : [];
    const video = files.find((f) => f.startsWith("source.") && f.endsWith(".mp4"));
    if (!video) {
      throw err; // Video file is missing: rethrow genuine failure
    }
    onLine(`⚠️ Subtitle download notice: ${err.message}. Proceeding with downloaded video.`);
  }

  const files = readdirSync(destDir);
  const video = files.find((f) => f.startsWith("source.") && f.endsWith(".mp4"));
  if (!video) throw new Error("Download finished but no mp4 found");
  const sub = files.find((f) => f.endsWith(".vtt"));
  return {
    videoPath: path.join(destDir, video),
    subPath: sub ? path.join(destDir, sub) : undefined,
  };
}

export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
