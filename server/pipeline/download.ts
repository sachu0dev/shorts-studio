import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync } from "node:fs"; // existsSync used in ensureDir
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
 * Downloads the video (mp4, <=1080p to keep ffmpeg fast).
 * Subtitles are attempted separately as a best-effort step so that
 * a 429 / rate-limit error never aborts the pipeline.
 * Returns { videoPath, subPath? }.
 */
export async function downloadVideo(
  url: string,
  destDir: string,
  onLine: (l: string) => void
): Promise<{ videoPath: string; subPath?: string }> {
  mkdirSync(destDir, { recursive: true });
  const outTemplate = path.join(destDir, "source.%(ext)s");

  // ── Phase 1: download the video stream only (no subtitle flags) ──────────
  await run(
    "yt-dlp",
    [
      "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-write-subs",
      "--no-write-auto-subs",
      "-o", outTemplate,
      url,
    ],
    onLine
  );

  // Confirm the video file is present before doing anything else
  const filesAfterVideo = readdirSync(destDir);
  const videoFile = filesAfterVideo.find(
    (f) => f.startsWith("source.") && f.endsWith(".mp4")
  );
  if (!videoFile) throw new Error("Download finished but no mp4 found");

  // ── Phase 2: attempt subtitle download as best-effort ───────────────────
  // Use --skip-download so we only fetch the .vtt files, not re-download video.
  // --ignore-errors prevents a 429 on subtitles from exiting with code 1.
  try {
    await run(
      "yt-dlp",
      [
        "--skip-download",
        "--write-auto-subs", "--write-subs",
        "--sub-langs", "en.*,en",
        "--sub-format", "vtt",
        "--ignore-errors",
        "--no-playlist",
        "-o", outTemplate,
        url,
      ],
      onLine
    );
  } catch (subErr: any) {
    // Best-effort: subtitle failures (429, network, etc.) are non-fatal
    onLine(`⚠️ Subtitles unavailable (${subErr.message}). Whisper will transcribe instead.`);
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
