import "dotenv/config";
if (process.env.HOME && !process.env.PATH?.includes(".local/bin")) {
  process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;
}
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import { uploadMiddleware } from "./upload.js";
import {
  createJob, getJob, listJobs, progress, publicView, saveJob, loadJobs, hydrateJobFromDisk,
  type Job, type AiProvider, type ClipPlan, type CompilationPlan,
} from "./jobs.js";
import { downloadVideo, ensureDir } from "./pipeline/download.js";
import { transcribeWithWhisperX, wordsToSegments, type TranscriptArtifact, type TranscriptWord } from "./pipeline/transcribe.js";
import { researchTrends, planClips, planCompilations } from "./pipeline/analyze.js";
import { renderClip, renderThumbnail, getDuration, concatClips } from "./pipeline/edit.js";
import { wordsForClip } from "./pipeline/captions.js";
import { snapPlans, type ScenesArtifact } from "./pipeline/boundaries.js";
import { classify } from "./pipeline/classify.js";
import { buildComposition, type Composition } from "./pipeline/router.js";
import type { PresetName } from "./pipeline/camera.js";
import { transcriptSignals, wordsInWindow, type AnalysisArtifact } from "./pipeline/signals.js";
import {
  asdSpeakerCount, bindSpeakersToTracks, stabilizeActiveTrack, type AsdArtifact,
} from "./pipeline/binding.js";
import { summarizeRetention } from "./pipeline/retention.js";
import { runPythonStage } from "./pipeline/python.js";
import { runSystemCheck } from "./systemCheck.js";
import { uploadClipToYouTube } from "./youtube/uploader.js";
import { LocalStore, type Artifact } from "./artifacts.js";
import { runStage, type Stage, type StageCtx } from "./stages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE = path.resolve(process.env.STORAGE_DIR || "./storage");
mkdirSync(STORAGE, { recursive: true });
const store = new LocalStore(STORAGE);
// Camera feel. Phase 21 moves this onto the creator profile; until there is a
// profile to put it on, one env var beats a settings screen nobody asked for.
const PRESET: PresetName = process.env.COMPOSITION_PRESET === "dynamic" ? "dynamic" : "calm";

const app = express();
app.use(express.json());
// React/shadcn UI, built by `npm run build:web` (see web/). In dev, Vite serves
// the UI itself on its own port and proxies /api + /files here — see
// web/vite.config.ts. This line only matters in production.
app.use(express.static(path.join(__dirname, "..", "web", "dist")));
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
  // 0 = auto: the AI decides how many genuinely good clips the video supports.
  const rawCount    = String(req.body.clipCount ?? "auto").trim();
  const clipCount   = rawCount === "auto" || rawCount === "0" || rawCount === ""
    ? 0
    : Math.min(Math.max(Number.parseInt(rawCount, 10) || 0, 0), 8);
  const filePath    = req.uploadedFile as string | undefined;
  const aiProvider  = (req.body.aiProvider as AiProvider) || "anthropic";
  const description = (req.body.description as string || "").slice(0, 4000); // guard length
  const controversialMode = req.body.controversialMode === "true" || req.body.controversialMode === true;

  if (!url && !filePath) return res.status(400).json({ error: "Provide a video URL or upload a file" });

  const missing = missingKey(aiProvider);
  if (missing) return res.status(400).json({ error: `${missing} missing in .env — required for ${aiProvider}` });

  const job = createJob({ url, filePath, clipCount, aiProvider, description, controversialMode });
  start(job);
  res.json({ id: job.id });
});

/** Re-runs a job against its existing artifacts — completed stages are skipped. */
const VALID_PROVIDERS: AiProvider[] = ["anthropic", "openai", "gemini", "ollama", "groq", "openrouter", "cerebras"];

app.patch("/api/jobs/:id", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  if (req.body.aiProvider && VALID_PROVIDERS.includes(req.body.aiProvider)) {
    job.aiProvider = req.body.aiProvider;
    await saveJob(job, store);
  }
  res.json(publicView(job));
});

app.post("/api/jobs/:id/resume", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  if (job.status === "running") return res.status(409).json({ error: "already running" });
  if (req.body?.aiProvider && VALID_PROVIDERS.includes(req.body.aiProvider)) {
    job.aiProvider = req.body.aiProvider;
    await saveJob(job, store);
  }
  job.error = undefined;
  start(job);
  res.json({ id: job.id, resumed: true, aiProvider: job.aiProvider });
});

/**
 * Retry a job from a specific stage by deleting that stage's artifact (and all
 * downstream ones), then resuming. runStage's cache-miss logic re-runs anything
 * that is missing, so clearing the right files is all this endpoint needs to do.
 *
 * Ordered list of stages + their artifact paths inside the job dir.
 * Everything at or after `stageName` in this list is deleted.
 */
const STAGE_ARTIFACTS: { name: string; paths: string[] }[] = [
  { name: "ingest",     paths: ["ingest.json"] },
  { name: "transcribe", paths: ["transcript.json"] },
  { name: "scenes",     paths: ["scenes.json"] },
  { name: "trends",     paths: ["trends.json"] },
  { name: "plan",       paths: ["clips.json", "analysis", "asd", "composition", "render", "out"] },
  { name: "render",     paths: ["render", "out"] },
  { name: "compilations", paths: ["compilations.json", "compsegments"] },
];

app.post("/api/jobs/:id/retry-from/:stageName", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  if (job.status === "running") return res.status(409).json({ error: "already running" });

  const fromIdx = STAGE_ARTIFACTS.findIndex((s) => s.name === req.params.stageName);
  if (fromIdx === -1) return res.status(400).json({ error: `unknown stage: ${req.params.stageName}` });

  if (req.body?.aiProvider && VALID_PROVIDERS.includes(req.body.aiProvider)) {
    job.aiProvider = req.body.aiProvider;
    await saveJob(job, store);
  }

  // Delete artifacts for this stage and all downstream stages
  const { promises: fsp } = await import("node:fs");
  for (const stage of STAGE_ARTIFACTS.slice(fromIdx)) {
    for (const rel of stage.paths) {
      const p = store.path(job.id, rel);
      await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
    // Also clear the timing record so the UI reflects the re-run
    const ti = job.timings.findIndex((t) => t.name === stage.name);
    if (ti >= 0) job.timings.splice(ti, 1);
  }

  job.error = undefined;
  job.plans = undefined;
  job.outputs = undefined;
  start(job);
  res.json({ id: job.id, retryFrom: req.params.stageName, aiProvider: job.aiProvider });
});

/** AbortControllers for currently-running jobs — lets /stop cancel in-flight work. */
const runningAborts = new Map<string, AbortController>();

function start(job: Job) {
  const ac = new AbortController();
  runningAborts.set(job.id, ac);
  runPipeline(job, ac.signal).catch(async (err) => {
    job.status = "error";
    job.error = ac.signal.aborted ? "Stopped by user" : String(err?.message || err);
    progress(job, "Stopped", `Stopped: ${job.error}`);
    await saveJob(job, store).catch(() => {});
  }).finally(() => {
    runningAborts.delete(job.id);
  });
}

/** Cancels a running job. Completed stages remain cached so it can be resumed. */
app.post("/api/jobs/:id/stop", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  const ac = runningAborts.get(req.params.id);
  if (!ac) return res.status(409).json({ error: "job is not running" });
  ac.abort();
  res.json({ id: job.id, stopped: true });
});

/** Temporary YouTube direct upload endpoint for a rendered clip. */
app.post("/api/jobs/:id/clips/:index/upload-youtube", async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  hydrateJobFromDisk(job, store);

  const clipIndex = Number(req.params.index);
  const plan = job.plans?.find((p) => p.index === clipIndex);
  if (!plan) return res.status(404).json({ error: `clip plan #${clipIndex} not found` });

  const clipId = `clip${clipIndex}`;
  const videoRelPath = `out/${clipId}.mp4`;
  const videoAbsPath = path.join(store.jobDir(job.id), videoRelPath);

  if (!existsSync(videoAbsPath)) {
    return res.status(404).json({ error: `Rendered clip video file not found on disk at ${videoRelPath}` });
  }

  const result = await uploadClipToYouTube({
    videoPath: videoAbsPath,
    title: plan.title,
    script: plan.script,
    hashtags: plan.hashtags,
    privacyStatus: req.body?.privacyStatus || "public",
  });

  if (result.success && result.videoUrl && result.videoId) {
    // Persist YouTube URL into job state and disk artifact
    const renderArt = await store.readJson<any>(job.id, `render/${clipId}.json`);
    if (renderArt) {
      renderArt.youtubeUrl = result.videoUrl;
      renderArt.youtubeVideoId = result.videoId;
      renderArt.uploadedAt = Date.now();
      await store.writeJson(job.id, `render/${clipId}.json`, renderArt);
    }
    const output = job.outputs?.find((o) => o.plan.index === clipIndex);
    if (output) {
      output.youtubeUrl = result.videoUrl;
      output.youtubeVideoId = result.videoId;
      output.uploadedAt = Date.now();
    }
    await saveJob(job, store).catch(() => {});
    job.emitter.emit("update", publicView(job));
  }

  res.json(result);
});

app.get("/api/jobs", (_req, res) => {
  const jobsList = listJobs();
  for (const j of jobsList) hydrateJobFromDisk(j, store);
  res.json(jobsList.map(publicView));
});

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
  hydrateJobFromDisk(job, store);
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

// ── artifact shapes (all schemaVersion 1) ─────────────────────────────────────
// Paths inside artifacts are RELATIVE to the job dir. Absolute paths would not
// survive the move to object storage in phase 23.

interface IngestArtifact extends Artifact { video: string; duration: number; title: string }
interface TrendsArtifact extends Artifact { brief: string }
interface ClipsArtifact extends Artifact { plans: ClipPlan[] }
// `clip`, `frames`, `decoder` and `encoder` are written by render.py; Node adds
// the thumbnail. `encoder` is how you confirm NVENC was actually used.
interface RenderArtifact extends Artifact {
  clip: string; thumbnail: string;
  frames?: number; decoder?: string; encoder?: string;
}
interface CompilationsArtifact extends Artifact { plans: CompilationPlan[] }

/**
 * Runs one segment of a compilation through the same analyze -> asd -> compose
 * -> render pipeline a normal clip gets, as a self-contained pass (not batched
 * across all segments like the main loop) since compilations are few and each
 * segment is short. `clipId` (e.g. "comp1seg2") keeps every artifact in its own
 * namespace, well clear of the regular `clip<N>` ids.
 */
async function renderCompilationSegment(
  jobId: string,
  clipId: string,
  segPlan: ClipPlan,
  videoPath: string,
  jobDir: string,
  segDir: string,
  ctx: StageCtx,
  words: TranscriptWord[],
  scenes: ScenesArtifact | null,
  log: (l: string) => void
): Promise<string> {
  const analyzeStage: Stage<void, AnalysisArtifact> = {
    name: `analyze:${clipId}`,
    output: `analysis/${clipId}.json`,
    schemaVersion: 4,
    async run() {
      await runPythonStage("analyze_clip", jobDir, log, [
        "--clip-id", clipId, "--start", String(segPlan.start), "--end", String(segPlan.end),
      ]);
      const cv = await store.readJson<AnalysisArtifact>(jobId, `analysis/${clipId}.json`);
      if (!cv) throw new Error(`analysis finished but wrote no analysis/${clipId}.json`);
      const retention = summarizeRetention(cv.faceTracks, cv.sourceWidth, cv.sourceHeight, segPlan.end - segPlan.start);
      const signals = {
        ...cv.signals,
        ...transcriptSignals(words, scenes?.cuts ?? [], segPlan.start, segPlan.end),
        ...(retention ? { retention: retention.retention, narrowestSafe: retention.narrowestSafe } : {}),
      };
      return { ...cv, schemaVersion: 4, signals, classification: classify(signals) };
    },
  };

  let analysis: AnalysisArtifact | null = null;
  try {
    analysis = await runStage(analyzeStage, ctx, undefined);
    segPlan.compositionType = analysis.classification?.type;
  } catch (e: any) {
    log(`⚠️ Analysis failed for ${clipId} (${e?.message || e}) — rendering without signals`);
  }

  let asd: AsdArtifact | null = null;
  if (analysis?.faceTracks?.length) {
    const asdStage: Stage<void, AsdArtifact> = {
      name: `asd:${clipId}`,
      output: `asd/${clipId}.json`,
      schemaVersion: 1,
      async run() {
        await runPythonStage("asd", jobDir, log, ["--clip-id", clipId]);
        const written = await store.readJson<AsdArtifact>(jobId, `asd/${clipId}.json`);
        if (!written) throw new Error(`asd finished but wrote no asd/${clipId}.json`);
        return {
          ...written,
          schemaVersion: 1,
          activeTrack: stabilizeActiveTrack(written.scores),
          speakers: bindSpeakersToTracks(
            written.scores, written.sampleStep,
            wordsInWindow(words, segPlan.start, segPlan.end), segPlan.start, log
          ),
          asdSpeakerCount: asdSpeakerCount(written.scores, written.sampleStep),
        };
      },
    };
    try {
      asd = await runStage(asdStage, ctx, undefined);
      if (analysis) {
        const retention = summarizeRetention(
          analysis.faceTracks, analysis.sourceWidth, analysis.sourceHeight,
          segPlan.end - segPlan.start, asd.activeTrack, asd.sampleStep
        );
        const signals = {
          ...analysis.signals, asdSpeakerCount: asd.asdSpeakerCount,
          ...(retention ? { speakerRetention: retention.speakerRetention, narrowestSafe: retention.narrowestSafe } : {}),
        };
        const revised = classify(signals);
        analysis = { ...analysis, signals, classification: revised };
        segPlan.compositionType = revised.type;
      }
    } catch (e: any) {
      log(`⚠️ ASD failed for ${clipId} (${e?.message || e}) — framing the most-present face instead`);
    }
  }

  const composeStage: Stage<void, Composition> = {
    name: `compose:${clipId}`,
    output: `composition/${clipId}.json`,
    schemaVersion: 5,
    async run() {
      return buildComposition(clipId, segPlan.end - segPlan.start, analysis, PRESET, log, asd);
    },
  };
  await runStage(composeStage, ctx, undefined);

  const tail: string[] = [];
  const capture = (l: string) => { tail.push(l); if (tail.length > 15) tail.shift(); };
  try {
    return await renderClip(videoPath, segPlan, jobDir, segDir, capture, wordsForClip(words, segPlan), clipId);
  } catch (e: any) {
    throw new Error(`${clipId}: ${e?.message || e}\n  ${tail.join("\n  ")}`);
  }
}

async function runPipeline(job: Job, signal?: AbortSignal) {
  job.status = "running";
  const jobDir = path.join(STORAGE, job.id);
  ensureDir(jobDir);
  const log = (l: string) => progress(job, job.stage, l);
  const rel = (p: string) => path.relative(jobDir, p);
  const abs = (p: string) => path.join(jobDir, p);

  const ctx: StageCtx = {
    jobId: job.id,
    store,
    log,
    timings: job.timings,
    onTiming: () => saveJob(job, store),
    signal,
  };

  // 1. acquire video
  progress(job, job.url ? "Downloading video" : "Preparing uploaded video");
  const ingestStage: Stage<void, IngestArtifact> = {
    name: "ingest",
    output: "ingest.json",
    schemaVersion: 1,
    async run() {
      let videoPath: string;
      let title = "";
      if (job.url) {
        const dl = await downloadVideo(job.url, jobDir, log);
        videoPath = dl.videoPath;
        title = dl.title;
      } else {
        videoPath = path.join(jobDir, "source.mp4");
        if (!existsSync(videoPath)) {
          if (job.filePath && existsSync(job.filePath)) {
            renameSync(job.filePath, videoPath);
          } else {
            throw new Error(`Uploaded video file not found (checked ${job.filePath})`);
          }
        }
      }
      return { schemaVersion: 1, video: rel(videoPath), duration: await getDuration(videoPath), title };
    },
  };
  const ingest = await runStage(ingestStage, ctx, undefined);
  const videoPath = abs(ingest.video);
  job.videoPath = videoPath;
  job.title = ingest.title;
  progress(job, "Video ready", `Duration: ${Math.round(ingest.duration)}s`);

  // 2. transcript — WhisperX always; there is no subtitle path
  progress(job, "Transcribing (WhisperX)");
  const transcribeStage: Stage<void, TranscriptArtifact> = {
    name: "transcribe",
    output: "transcript.json",
    schemaVersion: 1,
    async run() {
      await transcribeWithWhisperX(jobDir, log);
      // the Python stage writes transcript.json itself; read it back as the artifact
      const written = await store.readJson<TranscriptArtifact>(job.id, "transcript.json");
      if (!written) throw new Error("WhisperX finished but wrote no transcript.json");
      return written;
    },
  };
  const transcriptArtifact = await runStage(transcribeStage, ctx, undefined);
  const words = transcriptArtifact.words ?? [];
  if (!words.length) throw new Error("Empty transcript — cannot select clips");
  for (const w of transcriptArtifact.warnings ?? []) log(`⚠️ ${w}`);
  log(
    `${words.length} words, ${transcriptArtifact.speakers.length} speaker(s), ` +
    `model ${transcriptArtifact.modelTier}, ${Math.round(transcriptArtifact.lowConfidenceRatio * 100)}% low-confidence`
  );

  const transcript = wordsToSegments(words);
  job.transcript = transcript;

  // 3. scene cuts + silences — CPU-only, over the whole source
  progress(job, "Detecting scene cuts");
  const scenesStage: Stage<void, ScenesArtifact> = {
    name: "scenes",
    output: "scenes.json",
    schemaVersion: 1,
    async run() {
      await runPythonStage("scenes", jobDir, log);
      const written = await store.readJson<ScenesArtifact>(job.id, "scenes.json");
      if (!written) throw new Error("scene detection finished but wrote no scenes.json");
      return written;
    },
  };
  // Boundary snapping is an improvement, not a requirement: a failure here must
  // not cost the user a render (CLAUDE.md rule 5).
  let scenes: ScenesArtifact | null = null;
  try {
    scenes = await runStage(scenesStage, ctx, undefined);
    log(`${scenes.cuts.length} scene cuts, ${scenes.silences.length} silences` +
        (scenes.fastCut ? " (fast-cut source)" : ""));
  } catch (e: any) {
    log(`⚠️ Scene detection failed (${e?.message || e}) — clips will snap to word boundaries only`);
  }

  // 4. trend research (provider-aware + user description injected)
  progress(job, "Researching Indian shorts trends");
  const trendsStage: Stage<void, TrendsArtifact> = {
    name: "trends",
    output: "trends.json",
    schemaVersion: 1,
    async run() {
      const topicHint = transcript.slice(0, 30).map((s) => s.text).join(" ").slice(0, 500);
      log(`Using AI provider: ${job.aiProvider}`);
      return { schemaVersion: 1, brief: await researchTrends(topicHint, job.aiProvider, job.description) };
    },
  };
  job.trendBrief = (await runStage(trendsStage, ctx, undefined)).brief;
  log("Trend brief ready");
  progress(job, "Trend research done");

  // 5. clip planning (scripts, captions, hashtags, styles)
  progress(job, "Selecting clips & writing scripts");
  const planStage: Stage<void, ClipsArtifact> = {
    name: "plan",
    output: "clips.json",
    schemaVersion: 1,
    async run() {
      const raw = await planClips(
          transcript,
          job.clipCount,
          job.trendBrief!,
          ingest.duration,
          job.aiProvider,
          job.description,
          job.controversialMode,
        transcriptArtifact.language,
        transcriptArtifact.romanized,
        scenes?.cuts ?? [],
        job.title
      );
      // Snap here so clips.json is the aligned record — nothing downstream has
      // to know boundaries were ever approximate.
      return { schemaVersion: 1, plans: snapPlans(raw, scenes, words) };
    },
  };
  const plans = (await runStage(planStage, ctx, undefined)).plans;
  job.plans = plans;
  log(`Planned ${plans.length} clips`);
  const snapCounts = plans.reduce<Record<string, number>>((acc, p: any) => {
    acc[p.snappedTo ?? "none"] = (acc[p.snappedTo ?? "none"] ?? 0) + 1;
    return acc;
  }, {});
  log(`Boundaries: ${Object.entries(snapCounts).map(([k, v]) => `${v} ${k}`).join(", ")}`);

  // 6. per-clip analysis — CPU face detection on the SELECTED WINDOWS ONLY.
  // Running CV on 3x40s instead of a 25-minute source is the single biggest
  // cost saving in the pipeline (master plan 4.1).
  const analyses = new Map<string, AnalysisArtifact>();
  for (const plan of plans) {
    const clipId = `clip${plan.index}`;
    progress(job, `Analysing clip ${plan.index}/${plans.length}`);
    const analyzeStage: Stage<void, AnalysisArtifact> = {
      name: `analyze:${clipId}`,
      output: `analysis/${clipId}.json`,
      schemaVersion: 4, // 4: content retention signal (phase 29)
      async run() {
        await runPythonStage("analyze_clip", jobDir, log, [
          "--clip-id", clipId,
          "--start", String(plan.start),
          "--end", String(plan.end),
        ]);
        const cv = await store.readJson<AnalysisArtifact>(job.id, `analysis/${clipId}.json`);
        if (!cv) throw new Error(`analysis finished but wrote no analysis/${clipId}.json`);
        // CV signals come from Python; speaker/turn/overlap/cuts are derived from
        // artifacts Node already holds. Merged so one file explains one edit.
        const retention = summarizeRetention(cv.faceTracks, cv.sourceWidth, cv.sourceHeight, plan.end - plan.start);
        const signals = {
          ...cv.signals,
          ...transcriptSignals(words, scenes?.cuts ?? [], plan.start, plan.end),
          ...(retention ? { retention: retention.retention, narrowestSafe: retention.narrowestSafe } : {}),
        };
        // Classified here, not in Python: it needs the transcript-derived
        // signals, and it has to stay unit-testable without invoking a stage.
        return { ...cv, schemaVersion: 4, signals, classification: classify(signals) };
      },
    };
    try {
      const a = await runStage(analyzeStage, ctx, undefined);
      analyses.set(clipId, a);
      plan.compositionType = a.classification?.type;
      const sg = a.signals;
      log(`${clipId}: ${sg.distinctFaceTracks} face(s), coverage ${sg.faceCoverage}, ` +
          `${sg.speakerCount} speaker(s), overlap ${sg.overlapRatio}, motion ${sg.subjectMotion}`);
      if (sg.retention) {
        log(`${clipId}: retention 9:16=${sg.retention["9:16"]} narrowestSafe=${sg.narrowestSafe}`);
      }
      if (a.classification) {
        // When a clip is framed wrong, this line is the first thing to read.
        log(`${clipId}: ${a.classification.type} (confidence ${a.classification.confidence}) — ${a.classification.reason}`);
      }
    } catch (e: any) {
      // Nothing consumes the classification until phase 7, so a failure must
      // not cost a render today.
      log(`⚠️ Analysis failed for ${clipId} (${e?.message || e}) — rendering without signals`);
    }
  }

  // 6b. active speaker detection — the only stage that knows WHICH face is
  // talking. GPU, one clip at a time: face detection is CPU and WhisperX has
  // exited, so ASD has the 6 GB card to itself.
  const asds = new Map<string, AsdArtifact>();
  for (const plan of plans) {
    const clipId = `clip${plan.index}`;
    const analysis = analyses.get(clipId);
    if (!analysis?.faceTracks?.length) continue; // nothing to score
    progress(job, `Detecting active speaker ${plan.index}/${plans.length}`);
    const asdStage: Stage<void, AsdArtifact> = {
      name: `asd:${clipId}`,
      output: `asd/${clipId}.json`,
      schemaVersion: 1,
      async run() {
        await runPythonStage("asd", jobDir, log, ["--clip-id", clipId]);
        const written = await store.readJson<AsdArtifact>(job.id, `asd/${clipId}.json`);
        if (!written) throw new Error(`asd finished but wrote no asd/${clipId}.json`);
        // Python owns the scores; stabilisation and binding stay in Node where
        // they are unit-testable without a GPU.
        return {
          ...written,
          schemaVersion: 1,
          activeTrack: stabilizeActiveTrack(written.scores),
          speakers: bindSpeakersToTracks(
            written.scores, written.sampleStep,
            wordsInWindow(words, plan.start, plan.end), plan.start, log
          ),
          asdSpeakerCount: asdSpeakerCount(written.scores, written.sampleStep),
        };
      },
    };
    try {
      const asd = await runStage(asdStage, ctx, undefined);
      asds.set(clipId, asd);
      const bound = Object.entries(asd.speakers)
        .map(([s, b]) => `${s}→${b.trackId ?? "none"}`).join(", ");
      log(`${clipId}: ${asd.asdSpeakerCount} speaking face(s)${bound ? ` — ${bound}` : ""}`);

      // ASD counts speakers without diarization, so re-classifying here is what
      // lifts a multi-speaker clip past phase 7's 0.6 floor while pyannote stays
      // gated. The analysis artifact keeps its own answer; this one is recorded
      // in the composition, which is where the decision that mattered lives.
      const retention = summarizeRetention(
        analysis.faceTracks, analysis.sourceWidth, analysis.sourceHeight,
        plan.end - plan.start, asd.activeTrack, asd.sampleStep
      );
      const signals = {
        ...analysis.signals,
        asdSpeakerCount: asd.asdSpeakerCount,
        ...(retention ? { speakerRetention: retention.speakerRetention, narrowestSafe: retention.narrowestSafe } : {}),
      };
      const revised = classify(signals);
      if (revised.type !== analysis.classification?.type ||
          revised.confidence !== analysis.classification?.confidence) {
        log(`${clipId}: reclassified with ASD — ${revised.type} (confidence ${revised.confidence}) — ${revised.reason}`);
      }
      if (signals.speakerRetention) {
        log(`${clipId}: speakerRetention 9:16=${signals.speakerRetention["9:16"]} narrowestSafe=${signals.narrowestSafe}`);
      }
      analyses.set(clipId, { ...analysis, signals, classification: revised });
      plan.compositionType = revised.type;
    } catch (e: any) {
      // Phase 9 onwards degrade to presence-based framing; a render must not die
      // because the speaker could not be identified (CLAUDE.md rule 5).
      log(`⚠️ ASD failed for ${clipId} (${e?.message || e}) — framing the most-present face instead`);
    }
  }

  // 7. composition — the edit decision for every clip, before any pixels move.
  // Deliberately its own pass: the decisions are reviewable, and re-rendering in
  // a different style re-runs this and nothing upstream of it.
  progress(job, "Routing compositions");
  const compositions = new Map<string, Composition>();
  for (const plan of plans) {
    const clipId = `clip${plan.index}`;
    const composeStage: Stage<void, Composition> = {
      name: `compose:${clipId}`,
      output: `composition/${clipId}.json`,
      schemaVersion: 5, // 5: per-segment frameAspect + canvas (phase 30)
      async run() {
        return buildComposition(
          clipId, plan.end - plan.start, analyses.get(clipId) ?? null, PRESET, log, asds.get(clipId) ?? null
        );
      },
    };
    const c = await runStage(composeStage, ctx, undefined);
    compositions.set(clipId, c);
    log(`${clipId}: ${c.mode} (${c.preset}) — ${c.routedReason}`);
    if (c.mode === "camera-switch" || c.mode === "split-screen") {
      log(`${clipId}: ${c.heldSegments} segment(s), ${c.suppressedSwitches} switch(es) suppressed by min-hold`);
    }
    const aspects = [...new Set(c.layoutTimeline.map((s) => s.frameAspect ?? "9:16"))];
    if (aspects.length > 1 || aspects[0] !== "9:16") {
      log(`${clipId}: window widened to ${aspects.join(" → ")} — see layoutTimeline[].reason`);
    }
  }

  // 8. render clips + thumbnails
  job.outputs = [];
  const outDir = path.join(jobDir, "out");
  for (const plan of plans) {
    progress(job, `Editing clip ${plan.index}/${plans.length}`);
    // must match the filenames edit.ts writes (`clip<index>.mp4`) — plan.index is 1-based
    const clipId = `clip${plan.index}`;
    const renderStage: Stage<void, RenderArtifact> = {
      name: `render:${clipId}`,
      output: `render/${clipId}.json`,
      schemaVersion: 1,
      async run() {
        // ffmpeg's stderr used to be discarded, which turned a filter error into
        // a bare "exited with code 234". Keep the tail and attach it on failure.
        const tail: string[] = [];
        const capture = (l: string) => { tail.push(l); if (tail.length > 15) tail.shift(); };
        try {
          await renderClip(videoPath, plan, jobDir, outDir, capture, wordsForClip(words, plan));
          // render.py writes the artifact itself, same as transcribe and scenes.
          const written = await store.readJson<RenderArtifact>(job.id, `render/${clipId}.json`);
          if (!written) throw new Error(`render finished but wrote no render/${clipId}.json`);
          const thumbnail = await renderThumbnail(videoPath, plan, outDir, capture);
          return { ...written, schemaVersion: 1, thumbnail: rel(thumbnail) };
        } catch (e: any) {
          throw new Error(`${clipId}: ${e?.message || e}\n  ${tail.join("\n  ")}`);
        }
      },
    };
    const out = await runStage(renderStage, ctx, undefined);
    const c = compositions.get(clipId);
    const retentionSig = analyses.get(clipId)?.signals;
    job.outputs.push({
      clip: `/files/${job.id}/${out.clip}`,
      thumbnail: `/files/${job.id}/${out.thumbnail}`,
      plan,
      edit: c && {
        compositionType: c.compositionType ?? undefined,
        mode: c.mode,
        allowedModes: c.allowedModes,
        routedReason: c.routedReason,
        fallbackReason: c.fallbackReason,
        preset: c.preset,
        cameraKeyframes: c.cameraPath.length,
        heldSegments: c.heldSegments,
        suppressedSwitches: c.suppressedSwitches,
        encoder: out.encoder,
        frames: out.frames,
        retention: retentionSig?.retention,
        narrowestSafe: retentionSig?.narrowestSafe,
      },
    });
    progress(job, `Clip ${plan.index} done`, `Rendered ${path.basename(out.clip)} — ${out.encoder ?? "?"}, ${out.frames ?? "?"} frames`);
    await saveJob(job, store).catch(() => {});
  }

  // 9. compilations (optional) — themed reels stitched from short moments
  // across the whole video. Best-effort: a failure here never costs the
  // regular clips already rendered above (CLAUDE.md rule 5).
  progress(job, "Finding compilation themes");
  try {
    const compStage: Stage<void, CompilationsArtifact> = {
      name: "compilations",
      output: "compilations.json",
      schemaVersion: 1,
      async run() {
        const compPlans = await planCompilations(
          transcript, job.trendBrief!, ingest.duration, job.aiProvider, job.controversialMode,
          transcriptArtifact.language, transcriptArtifact.romanized, job.title,
          plans.map((p) => ({ start: p.start, end: p.end }))
        );
        return { schemaVersion: 1, plans: compPlans };
      },
    };
    const compilations = (await runStage(compStage, ctx, undefined)).plans;
    job.compilations = compilations;
    log(`Found ${compilations.length} compilation theme(s)`);

    job.compilationOutputs = [];
    const segDir = path.join(jobDir, "compsegments");
    for (const comp of compilations) {
      progress(job, `Building compilation ${comp.index}/${compilations.length}: ${comp.theme}`);
      const segmentPaths: string[] = [];
      for (let si = 0; si < comp.segments.length; si++) {
        const seg = comp.segments[si];
        const clipId = `comp${comp.index}seg${si + 1}`;
        const segPlan: ClipPlan = {
          index: si + 1,
          title: comp.title,
          hook: si === 0 ? comp.hook : "",
          start: seg.start,
          end: seg.end,
          reason: "",
          script: comp.script,
          hashtags: comp.hashtags,
          thumbnailText: "",
          thumbnailTimestamp: seg.start,
          captions: [],
          contentMode: comp.contentMode,
          captionAnimation: comp.captionAnimation,
          captionPalette: comp.captionPalette,
          captionFont: comp.captionFont,
          layoutTemplate: "fullscreen",
          memes: [],
          monetizationFlag: comp.monetizationFlag,
        };
        try {
          const segPath = await renderCompilationSegment(
            job.id, clipId, segPlan, videoPath, jobDir, segDir, ctx, words, scenes, log
          );
          segmentPaths.push(segPath);
        } catch (e: any) {
          log(`⚠️ Compilation ${comp.index} segment ${si + 1} failed (${e?.message || e}) — skipping that segment`);
        }
      }

      if (segmentPaths.length < 2) {
        log(`⚠️ Compilation ${comp.index} (${comp.theme}) has fewer than 2 usable segments — skipped`);
        continue;
      }

      const compId = `comp${comp.index}`;
      const outPath = path.join(outDir, `${compId}.mp4`);
      const tail: string[] = [];
      const capture = (l: string) => { tail.push(l); if (tail.length > 15) tail.shift(); };
      try {
        await concatClips(segmentPaths, outPath, capture);
        const thumbPlan: ClipPlan = {
          index: comp.index, title: comp.title, hook: comp.hook, start: 0, end: 0, reason: "",
          script: comp.script, hashtags: comp.hashtags, thumbnailText: comp.title, thumbnailTimestamp: comp.segments[0].start,
          captions: [], contentMode: comp.contentMode, captionAnimation: comp.captionAnimation,
          captionPalette: comp.captionPalette, captionFont: comp.captionFont, layoutTemplate: "fullscreen",
          memes: [], monetizationFlag: comp.monetizationFlag,
        };
        const thumbnail = await renderThumbnail(videoPath, thumbPlan, outDir, capture, compId);
        job.compilationOutputs.push({
          clip: `/files/${job.id}/${path.relative(jobDir, outPath)}`,
          thumbnail: `/files/${job.id}/${path.relative(jobDir, thumbnail)}`,
          plan: comp,
        });
        log(`${compId}: "${comp.theme}" — ${segmentPaths.length} segment(s) joined`);
      } catch (e: any) {
        log(`⚠️ Compilation ${comp.index} concat/thumbnail failed (${e?.message || e})\n  ${tail.join("\n  ")}`);
      }
      await saveJob(job, store).catch(() => {});
    }
  } catch (e: any) {
    log(`⚠️ Compilation planning failed (${e?.message || e}) — regular clips above are unaffected`);
  }

  job.status = "done";
  progress(job, "All clips ready");
  await saveJob(job, store);
}

const PORT = Number(process.env.PORT || 5177);
const restored = loadJobs(store, STORAGE);
app.listen(PORT, () => {
  console.log(`Shorts Studio → http://localhost:${PORT}`);
  if (restored) console.log(`Restored ${restored} job(s) from ${STORAGE}`);
});
