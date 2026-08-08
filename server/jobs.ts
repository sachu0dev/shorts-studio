import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { nanoid } from "nanoid";
import type { Artifact, Store } from "./artifacts.js";
import type { CompositionType } from "./pipeline/classify.js";
import type { StageTiming } from "./stages.js";

export type ContentMode = "funny" | "gaming" | "political";

export type CaptionAnimation =
  | "karaoke-reveal"
  | "punch-scale-bounce"
  | "typewriter"
  | "slide-up"
  | "shake"
  | "glitch-rgb-split";

export type CaptionPalette =
  | "gaming-neon"
  | "meme-comic"
  | "news-serious"
  | "hype-yellow"
  | "pop-white-red"
  | "minimal-clean";

export type LayoutTemplate =
  | "fullscreen"
  | "blurred-fill"
  | "meme-corner"
  // "zoom-punch" was removed after live feedback: `t % 2.0` pulsed the zoom
  // every 2s for the clip's entire duration rather than once, which read as a
  // stuck effect looping on the video, not a style choice.
  // "speed-ramp" was removed in phase 6. Its ffmpeg form applied a video-only
  // setpts, so audio (and the burned captions) drifted during every ramp window.
  // Fixing it properly means retiming the .ass words and the meme windows
  // through the same piecewise time map, not just adding an atempo — phase 6's
  // gate allowed removal over shipping the desync again.
  // "shake-on-beat" was removed after live feedback: it shook every frame of
  // the whole clip continuously (`sin(t*30)`), not on a beat at all — it read
  // as an earthquake for the clip's entire duration, not a style choice.
  | "vignette-pulse"
  | "glitch-cut"
  | "color-grade-pop"
  // "split-screen-duo" was removed in phase 10: a fixed ffmpeg half-split that
  // couldn't follow anyone. `"split-screen"` in `LayoutMode` (router.ts) is the
  // real, router-driven, independently-tracked replacement.
  | "letterbox-cinematic"
  | "freeze-frame-callout";

export type MemeDisplayMode =
  | "corner-overlay"
  | "full-cutaway"
  | "pip-bounce"
  | "sticker-pop"
  | "side-by-side-split";

export interface MemeOverlay {
  start: number;   // seconds, relative to clip start
  end: number;
  query: string;   // Giphy search term
  display: MemeDisplayMode;
}

/** One source-video time range pulled into a compilation. Absolute seconds, not clip-relative. */
export interface CompilationSegment {
  start: number;
  end: number;
}

/**
 * A themed reel stitched from several short, non-contiguous moments across the
 * whole video — "every performer", "best reactions" — rather than one
 * continuous window. Each segment renders through the same per-clip pipeline
 * as a `ClipPlan`, then the segment outputs are concatenated into one file.
 */
export interface CompilationPlan {
  index: number;
  /** Short internal label for the theme, e.g. "best performances". Not shown on screen. */
  theme: string;
  title: string;
  hook: string;
  script: string;
  hashtags: string[];
  segments: CompilationSegment[];
  contentMode: ContentMode;
  captionAnimation: CaptionAnimation;
  captionPalette: CaptionPalette;
  captionFont: string;
  monetizationFlag: { risky: boolean; reasons: string[] };
}

export type AiProvider = "anthropic" | "openai" | "gemini" | "ollama" | "groq" | "openrouter" | "cerebras";

/**
 * Where the words come from. `captions` = the platform's own English caption
 * track (free, no VRAM, and already translated); `whisper` = WhisperX on the
 * audio. Whichever is picked, the other is the fallback — a job never fails
 * because one source was unavailable.
 */
export type TranscriptSource = "captions" | "whisper";

/** Phase 14 — see server/rights.ts for the gate this field feeds. */
export type RightsPosture = "owned" | "licensed" | "third-party";

export interface RightsDeclaration {
  posture: RightsPosture;
  declaredAt: number;
  declaredBy: "user";
  ccFlagFromApi?: boolean;
  note?: string;
}

export interface ClipPlan {
  index: number;
  title: string;
  hook: string;
  start: number;
  end: number;
  reason: string;
  script: string;
  hashtags: string[];
  thumbnailText: string;
  thumbnailTimestamp: number;
  captions: { start: number; end: number; text: string }[]; // text may contain **punch words**
  contentMode: ContentMode;
  captionAnimation: CaptionAnimation;
  captionPalette: CaptionPalette;
  captionFont: string;              // Google Fonts family name, AI-chosen
  memes: MemeOverlay[];
  monetizationFlag: { risky: boolean; reasons: string[] };
  /**
   * Measured, never LLM-chosen — `sanitizePlan` whitelists fields, so a model
   * that emits this is discarded structurally. Filled in after analysis, and
   * absent when analysis failed. Phase 7 is the first consumer.
   */
  compositionType?: CompositionType;
}

/**
 * What the router decided and what the renderer did, per clip. Surfaced in the
 * UI because a clip you can watch but not explain is not a test result — when
 * the framing is wrong, `routedReason` is the first thing to read.
 */
export interface EditSummary {
  compositionType?: CompositionType;
  mode: string;
  allowedModes: string[];
  routedReason: string;
  fallbackReason?: string;
  preset: string;
  cameraKeyframes: number;
  /** Held segments and the switches min-hold rejected — phase 9's tuning dials. */
  heldSegments?: number;
  suppressedSwitches?: number;
  encoder?: string;
  frames?: number;
  /** Whole-clip fraction of faces a 9:16 crop keeps whole — phase 29. */
  retention?: Record<string, number>;
  narrowestSafe?: string;
  /** Per-segment visual effects the taste pass chose — phase 12. */
  effects?: { t0: number; t1: number; template: string; reason?: string }[];
  taste?: { applied: boolean; provider?: string; fellBackToRouter: boolean; rejected: { segment: number; why: string }[] };
}

export interface Job {
  id: string;
  url?: string;
  filePath?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;      // user-supplied context: trends, memes, instructions
  controversialMode: boolean; // default false — safe clip-selection bias
  /** Which text to trust first. Either side falls back to the other. */
  transcriptSource: TranscriptSource;
  /** Written at creation, immutable thereafter — see server/rights.ts. */
  rights: RightsDeclaration;
  status: "queued" | "running" | "done" | "error";
  stage: string;
  log: string[];
  error?: string;
  videoPath?: string;
  /** The source video's own title (yt-dlp metadata) — used only to auto-detect a known show. */
  title?: string;
  transcript?: { start: number; end: number; text: string }[];
  trendBrief?: string;
  plans?: ClipPlan[];
  outputs?: {
    clip: string;
    thumbnail: string;
    plan: ClipPlan;
    edit?: EditSummary;
    youtubeUrl?: string;
    youtubeVideoId?: string;
    uploadedAt?: number;
  }[];
  /** Themed reels stitched from short moments across the whole video — optional, best-effort. */
  compilations?: CompilationPlan[];
  compilationOutputs?: {
    clip: string;
    thumbnail: string;
    plan: CompilationPlan;
  }[];
  emitter: EventEmitter;
  createdAt: number;
  timings: StageTiming[];
}

/** What actually lands in job.json. Disk is authoritative; the Map is a cache. */
export interface JobRecord extends Artifact {
  id: string;
  status: Job["status"];
  stage: string;
  error?: string;
  createdAt: number;
  input: {
    url?: string;
    clipCount: number;
    aiProvider: AiProvider;
    description: string;
    controversialMode: boolean;
    transcriptSource?: TranscriptSource;
    rights?: RightsDeclaration;
  };
  stages: StageTiming[];
  title?: string;
  trendBrief?: string;
  plans?: ClipPlan[];
  outputs?: Job["outputs"];
  compilations?: CompilationPlan[];
  compilationOutputs?: Job["compilationOutputs"];
}

export const JOB_SCHEMA_VERSION = 1;

export function toRecord(job: Job): JobRecord {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    id: job.id,
    status: job.status,
    stage: job.stage,
    error: job.error,
    createdAt: job.createdAt,
    input: {
      url: job.url,
      clipCount: job.clipCount,
      aiProvider: job.aiProvider,
      description: job.description,
      controversialMode: job.controversialMode,
      transcriptSource: job.transcriptSource,
      rights: job.rights,
    },
    stages: job.timings,
    title: job.title,
    trendBrief: job.trendBrief,
    plans: job.plans,
    outputs: job.outputs,
    compilations: job.compilations,
    compilationOutputs: job.compilationOutputs,
  };
}

export async function saveJob(job: Job, store: Store): Promise<void> {
  await store.writeJson(job.id, "job.json", toRecord(job));
  job.emitter.emit("update", publicView(job));
}

export function hydrateJobFromDisk(job: Job, store: Store) {
  // 1. Hydrate trendBrief if missing
  if (!job.trendBrief) {
    const tb = readJsonSync<{ schemaVersion: number; brief: string }>(store, job.id, "trends.json");
    if (tb?.brief) job.trendBrief = tb.brief;
  }

  // 2. Hydrate plans if missing
  if (!job.plans || job.plans.length === 0) {
    const cp = readJsonSync<{ schemaVersion: number; plans: ClipPlan[] }>(store, job.id, "clips.json");
    if (cp?.plans) job.plans = cp.plans;
  }

  // 3. Hydrate outputs if missing
  if (!job.outputs || job.outputs.length === 0) {
    if (job.plans && job.plans.length > 0) {
      const outputs: NonNullable<Job["outputs"]> = [];
      for (const plan of job.plans) {
        const clipId = `clip${plan.index}`;
        const renderArt = readJsonSync<{
          schemaVersion: number;
          clip: string;
          thumbnail: string;
          encoder?: string;
          frames?: number;
          youtubeUrl?: string;
          youtubeVideoId?: string;
          uploadedAt?: number;
        }>(store, job.id, `render/${clipId}.json`);
        if (renderArt) {
          const comp = readJsonSync<any>(store, job.id, `composition/${clipId}.json`);
          const analysis = readJsonSync<any>(store, job.id, `analysis/${clipId}.json`);
          outputs.push({
            clip: `/files/${job.id}/${renderArt.clip}`,
            thumbnail: `/files/${job.id}/${renderArt.thumbnail}`,
            plan,
            youtubeUrl: renderArt.youtubeUrl,
            youtubeVideoId: renderArt.youtubeVideoId,
            uploadedAt: renderArt.uploadedAt,
            edit: comp ? {
              compositionType: comp.compositionType,
              mode: comp.mode,
              allowedModes: comp.allowedModes,
              routedReason: comp.routedReason,
              fallbackReason: comp.fallbackReason,
              preset: comp.preset,
              cameraKeyframes: comp.cameraPath?.length || 0,
              heldSegments: comp.heldSegments,
              suppressedSwitches: comp.suppressedSwitches,
              encoder: renderArt.encoder,
              frames: renderArt.frames,
              retention: analysis?.signals?.retention,
              narrowestSafe: analysis?.signals?.narrowestSafe,
              effects: comp.effects,
              taste: comp.taste,
            } : undefined,
          });
        }
      }
      if (outputs.length > 0) {
        job.outputs = outputs;
        if (job.status !== "running" && job.status !== "queued") {
          job.status = "done";
          job.stage = "All clips ready";
        }
      }
    }
  }
}

/**
 * Rebuilds the in-memory map from disk on boot so a restarted server can resume
 * jobs. Anything unreadable is skipped rather than crashing startup.
 */
export function loadJobs(store: Store, storageRoot: string): number {
  let ids: string[];
  try {
    ids = readdirSync(storageRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return 0;
  }

  let loaded = 0;
  for (const id of ids) {
    if (jobs.has(id)) continue;
    let rec: JobRecord | null = null;
    try {
      rec = readJsonSync<JobRecord>(store, id, "job.json");
    } catch {
      continue;
    }
    if (!rec || rec.schemaVersion !== JOB_SCHEMA_VERSION) continue;

    const j: Job = {
      id: rec.id,
      url: rec.input.url,
      clipCount: rec.input.clipCount,
      aiProvider: rec.input.aiProvider,
      description: rec.input.description,
      controversialMode: rec.input.controversialMode,
      transcriptSource: rec.input.transcriptSource ?? "captions",
      // Fail closed (phase 14 gate 5): a job.json predating this field, or one
      // that's corrupt, reads as the posture that blocks auto-publish.
      rights: rec.input.rights?.posture
        ? rec.input.rights
        : { posture: "third-party", declaredAt: rec.createdAt, declaredBy: "user" },
      // a job that was mid-flight when the process died is not still running
      status: rec.status === "running" ? "error" : rec.status,
      stage: rec.stage,
      error: rec.status === "running" ? "interrupted — server restarted" : rec.error,
      log: [],
      title: rec.title,
      trendBrief: rec.trendBrief,
      plans: rec.plans,
      outputs: rec.outputs,
      compilations: rec.compilations,
      compilationOutputs: rec.compilationOutputs,
      emitter: new EventEmitter(),
      createdAt: rec.createdAt,
      timings: rec.stages || [],
    };
    hydrateJobFromDisk(j, store);
    jobs.set(id, j);
    loaded++;
  }
  return loaded;
}

function readJsonSync<T extends Artifact>(store: Store, jobId: string, rel: string): T | null {
  try {
    return JSON.parse(readFileSync(store.path(jobId, rel), "utf8")) as T;
  } catch {
    return null;
  }
}

const jobs = new Map<string, Job>();

export function createJob(input: {
  url?: string;
  filePath?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;
  controversialMode?: boolean;
  transcriptSource?: TranscriptSource;
  /** Required at the HTTP boundary (POST /api/jobs) — phase 14 gate 1. Not
   * optional here either: fail closed rather than let a caller forget. */
  rights: RightsDeclaration;
}): Job {
  const job: Job = {
    id: nanoid(10),
    ...input,
    controversialMode: input.controversialMode ?? false,
    transcriptSource: input.transcriptSource ?? "captions",
    // Immutable thereafter (gate 3): nothing past this line, and no other
    // code path in the file, ever assigns job.rights again.
    rights: input.rights.posture ? input.rights : { posture: "third-party", declaredAt: Date.now(), declaredBy: "user" },
    status: "queued",
    stage: "Queued",
    log: [],
    emitter: new EventEmitter(),
    createdAt: Date.now(),
    timings: [],
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function progress(job: Job, stage: string, line?: string) {
  job.stage = stage;
  if (line) job.log.push(line);
  job.emitter.emit("update", publicView(job));
}

export function publicView(job: Job) {
  const { emitter, ...rest } = job;
  return rest;
}
