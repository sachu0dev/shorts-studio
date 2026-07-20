import "dotenv/config";
if (process.env.HOME && !process.env.PATH?.includes(".local/bin")) {
  process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;
}
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync } from "node:fs";
import { uploadMiddleware } from "./upload.js";
import { createJob, getJob, listJobs, progress, publicView, type Job, type AiProvider } from "./jobs.js";
import { downloadVideo, ensureDir } from "./pipeline/download.js";
import { parseVtt, whisperFallback, type Segment } from "./pipeline/transcribe.js";
import { researchTrends, planClips } from "./pipeline/analyze.js";
import { renderClip, renderThumbnail, getDuration } from "./pipeline/edit.js";
import { runSystemCheck } from "./systemCheck.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = path.resolve(process.env.STORAGE_DIR || "./storage");
mkdirSync(STORAGE, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));
app.use("/files", express.static(STORAGE));

// ── helper: which env key is missing for a given provider
function missingKey(provider: AiProvider): string | null {
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  if (provider === "openai"    && !process.env.OPENAI_API_KEY)    return "OPENAI_API_KEY";
  if (provider === "gemini"    && !process.env.GEMINI_API_KEY)    return "GEMINI_API_KEY";
  return null;
}

app.post("/api/jobs", uploadMiddleware(STORAGE), (req: any, res) => {
  const url         = req.body.url?.trim() || undefined;
  const clipCount   = Math.min(Math.max(Number.parseInt(req.body.clipCount || "3", 10) || 3, 1), 8);
  const filePath    = req.uploadedFile as string | undefined;
  const aiProvider  = (req.body.aiProvider as AiProvider) || "anthropic";
  const description = (req.body.description as string || "").slice(0, 4000); // guard length
  const controversialMode = req.body.controversialMode === "true" || req.body.controversialMode === true;

  if (!url && !filePath) return res.status(400).json({ error: "Provide a video URL or upload a file" });

  const missing = missingKey(aiProvider);
  if (missing) return res.status(400).json({ error: `${missing} missing in .env — required for ${aiProvider}` });

  const job = createJob({ url, filePath, clipCount, aiProvider, description, controversialMode });
  runPipeline(job).catch((err) => {
    job.status = "error";
    job.error = String(err?.message || err);
    progress(job, "Failed", `ERROR: ${job.error}`);
  });
  res.json({ id: job.id });
});

app.get("/api/jobs", (_req, res) => res.json(listJobs().map(publicView)));

app.get("/api/system-check", async (_req, res) => {
  try {
    const report = await runSystemCheck();
    res.json(report);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/jobs/:id/events", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(publicView(job));
  const listener = (v: unknown) => send(v);
  job.emitter.on("update", listener);
  req.on("close", () => job.emitter.off("update", listener));
});

async function runPipeline(job: Job) {
  job.status = "running";
  const jobDir = path.join(STORAGE, job.id);
  ensureDir(jobDir);
  const log = (l: string) => progress(job, job.stage, l);

  // 1. acquire video
  let videoPath: string;
  let subPath: string | undefined;
  if (job.url) {
    progress(job, "Downloading video");
    const dl = await downloadVideo(job.url, jobDir, log);
    videoPath = dl.videoPath;
    subPath = dl.subPath;
  } else {
    progress(job, "Preparing uploaded video");
    videoPath = path.join(jobDir, "source.mp4");
    renameSync(job.filePath!, videoPath);
  }
  job.videoPath = videoPath;
  const duration = await getDuration(videoPath);
  progress(job, "Video ready", `Duration: ${Math.round(duration)}s`);

  // 2. transcript
  progress(job, "Transcribing");
  let transcript: Segment[];
  if (subPath) {
    transcript = parseVtt(subPath);
    log(`Parsed ${transcript.length} caption segments from platform subtitles`);
  } else {
    log("No subtitles found — trying local whisper (install: pip install openai-whisper)");
    transcript = await whisperFallback(videoPath, log);
  }
  if (!transcript.length) throw new Error("Empty transcript — cannot select clips");
  job.transcript = transcript;

  // 3. trend research (provider-aware + user description injected)
  progress(job, "Researching Indian shorts trends");
  const topicHint = transcript.slice(0, 30).map((s) => s.text).join(" ").slice(0, 500);
  log(`Using AI provider: ${job.aiProvider}`);
  job.trendBrief = await researchTrends(topicHint, job.aiProvider, job.description);
  log("Trend brief ready");
  progress(job, "Trend research done");

  // 4. clip planning (scripts, captions, hashtags, styles)
  progress(job, "Selecting clips & writing scripts");
  const plans = await planClips(
    job.transcript,
    job.clipCount,
    job.trendBrief,
    duration,
    job.aiProvider,
    job.description,
    job.controversialMode
  );
  job.plans = plans;
  log(`Planned ${plans.length} clips`);

  // 5. render clips + thumbnails
  job.outputs = [];
  const outDir = path.join(jobDir, "out");
  for (const plan of plans) {
    progress(job, `Editing clip ${plan.index + 1}/${plans.length}`);
    const clip = await renderClip(videoPath, plan, outDir, () => {});
    const thumbnail = await renderThumbnail(videoPath, plan, outDir, () => {});
    job.outputs.push({
      clip: `/files/${job.id}/out/${path.basename(clip)}`,
      thumbnail: `/files/${job.id}/out/${path.basename(thumbnail)}`,
      plan,
    });
    progress(job, `Clip ${plan.index + 1} done`, `Rendered ${path.basename(clip)}`);
  }

  job.status = "done";
  progress(job, "All clips ready");
}

const PORT = Number(process.env.PORT || 5177);
app.listen(PORT, () => console.log(`Shorts Studio → http://localhost:${PORT}`));
