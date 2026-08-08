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
 *
 * Subtitles are deliberately NOT downloaded. WhisperX transcribes every job
 * (phase 2): platform subtitles carry sentence-level timings only, which is
 * what produced the caption desync, and their text is frequently worse.
 */
/**
 * The video's own title, straight from yt-dlp metadata — one extra fast call
 * (no download), used only to auto-detect a known show (e.g. "India's Got
 * Latent") and hand the planner a format-specific guide. Never blocks the
 * job: a failed title fetch just means no show is detected.
 */
async function fetchTitle(url: string): Promise<string> {
  let title = "";
  await run("yt-dlp", ["--no-playlist", "--print", "%(title)s", "--skip-download", url], (l) => {
    if (!title) title = l.trim();
  }).catch(() => {});
  return title;
}

export async function downloadVideo(
  url: string,
  destDir: string,
  onLine: (l: string) => void
): Promise<{ videoPath: string; title: string }> {
  mkdirSync(destDir, { recursive: true });
  const outTemplate = path.join(destDir, "source.%(ext)s");
  const title = await fetchTitle(url);

  // ── Phase 1: download the video stream only (no subtitle flags) ──────────
  await run(
    "yt-dlp",
    [
      // Prefer H.264 (avc1) explicitly. YouTube often serves AV1 in an mp4
      // container, which OpenCV cannot decode at all — it reads zero frames and
      // reports "no scene cuts" rather than failing. NVDEC and the phase-6
      // OpenCV render path both want h264 too. AV1 remains the last resort so a
      // video that only exists in AV1 still downloads.
      "-f",
      "bv*[height<=1080][vcodec^=avc1]+ba[ext=m4a]/b[height<=1080][vcodec^=avc1]/" +
        "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--no-write-subs",
      "--no-write-auto-subs",
      "-o", outTemplate,
      url,
    ],
    onLine
  );

  const video = readdirSync(destDir).find((f) => f.startsWith("source.") && f.endsWith(".mp4"));
  if (!video) throw new Error("Download finished but no mp4 found");
  return { videoPath: path.join(destDir, video), title };
}

export function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
