import "dotenv/config";
if (process.env.HOME && !process.env.PATH?.includes(".local/bin")) {
  process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`;
}
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, renameSync } from "node:fs";
import { uploadMiddleware } from "./upload.js";
import {
  createJob, getJob, listJobs, progress, publicView, saveJob, loadJobs,
  type Job, type AiProvider, type ClipPlan,
} from "./jobs.js";
import { downloadVideo, ensureDir } from "./pipeline/download.js";
import { transcribeWithWhisperX, wordsToSegments, type TranscriptArtifact } from "./pipeline/transcribe.js";
import { researchTrends, planClips } from "./pipeline/analyze.js";
import { renderClip, renderThumbnail, getDuration } from "./pipeline/edit.js";
import { wordsForClip } from "./pipeline/captions.js";
import { snapPlans, type ScenesArtifact } from "./pipeline/boundaries.js";
import { classify } from "./pipeline/classify.js";
import { buildComposition, type Composition } from "./pipeline/router.js";
import type { PresetName } from "./pipeline/camera.js";
import { transcriptSignals, type AnalysisArtifact } from "./pipeline/signals.js";
import { runPythonStage } from "./pipeline/python.js";
import { runSystemCheck } from "./systemCheck.js";
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
app.post("/api/jobs/:id/resume", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown job" });
  if (job.status === "running") return res.status(409).json({ error: "already running" });
  job.error = undefined;
  start(job);
  res.json({ id: job.id, resumed: true });
});

function start(job: Job) {
  runPipeline(job).catch(async (err) => {
    job.status = "error";
    job.error = String(err?.message || err);
    progress(job, "Failed", `ERROR: ${job.error}`);
    await saveJob(job, store).catch(() => {});
  });
}

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

// ── artifact shapes (all schemaVersion 1) ─────────────────────────────────────
// Paths inside artifacts are RELATIVE to the job dir. Absolute paths would not
// survive the move to object storage in phase 23.

interface IngestArtifact extends Artifact { video: string; duration: number }
interface TrendsArtifact extends Artifact { brief: string }
interface ClipsArtifact extends Artifact { plans: ClipPlan[] }
// `clip`, `frames`, `decoder` and `encoder` are written by render.py; Node adds
// the thumbnail. `encoder` is how you confirm NVENC was actually used.
interface RenderArtifact extends Artifact {
  clip: string; thumbnail: string;
  frames?: number; decoder?: string; encoder?: string;
}

async function runPipeline(job: Job) {
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
  };

  // 1. acquire video
  progress(job, job.url ? "Downloading video" : "Preparing uploaded video");
  const ingestStage: Stage<void, IngestArtifact> = {
    name: "ingest",
    output: "ingest.json",
    schemaVersion: 1,
    async run() {
      let videoPath: string;
      if (job.url) {
        videoPath = (await downloadVideo(job.url, jobDir, log)).videoPath;
      } else {
        videoPath = path.join(jobDir, "source.mp4");
        renameSync(job.filePath!, videoPath);
      }
      return { schemaVersion: 1, video: rel(videoPath), duration: await getDuration(videoPath) };
    },
  };
  const ingest = await runStage(ingestStage, ctx, undefined);
  const videoPath = abs(ingest.video);
  job.videoPath = videoPath;
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
        scenes?.cuts ?? []
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
      schemaVersion: 2, // 2: + classification, + signals.wordCount
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
        const signals = {
          ...cv.signals,
          ...transcriptSignals(words, scenes?.cuts ?? [], plan.start, plan.end),
        };
        // Classified here, not in Python: it needs the transcript-derived
        // signals, and it has to stay unit-testable without invoking a stage.
        return { ...cv, signals, classification: classify(signals) };
      },
    };
    try {
      const a = await runStage(analyzeStage, ctx, undefined);
      analyses.set(clipId, a);
      plan.compositionType = a.classification?.type;
      const sg = a.signals;
      log(`${clipId}: ${sg.distinctFaceTracks} face(s), coverage ${sg.faceCoverage}, ` +
          `${sg.speakerCount} speaker(s), overlap ${sg.overlapRatio}, motion ${sg.subjectMotion}`);
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
      schemaVersion: 1,
      async run() {
        return buildComposition(clipId, plan.end - plan.start, analyses.get(clipId) ?? null, PRESET, log);
      },
    };
    const c = await runStage(composeStage, ctx, undefined);
    compositions.set(clipId, c);
    log(`${clipId}: ${c.mode} (${c.preset}) — ${c.routedReason}`);
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
        encoder: out.encoder,
        frames: out.frames,
      },
    });
    progress(job, `Clip ${plan.index} done`, `Rendered ${path.basename(out.clip)} — ${out.encoder ?? "?"}, ${out.frames ?? "?"} frames`);
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
