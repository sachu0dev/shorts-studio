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
  | "zoom-punch"
  | "shake-on-beat"
  // "speed-ramp" was removed in phase 6. Its ffmpeg form applied a video-only
  // setpts, so audio (and the burned captions) drifted during every ramp window.
  // Fixing it properly means retiming the .ass words and the meme windows
  // through the same piecewise time map, not just adding an atempo — phase 6's
  // gate allowed removal over shipping the desync again.
  | "vignette-pulse"
  | "glitch-cut"
  | "color-grade-pop"
  | "split-screen-duo"
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

export type AiProvider = "anthropic" | "openai" | "gemini";

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
  layoutTemplate: LayoutTemplate;
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
  encoder?: string;
  frames?: number;
}

export interface Job {
  id: string;
  url?: string;
  filePath?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;      // user-supplied context: trends, memes, instructions
  controversialMode: boolean; // default false — safe clip-selection bias
  status: "queued" | "running" | "done" | "error";
  stage: string;
  log: string[];
  error?: string;
  videoPath?: string;
  transcript?: { start: number; end: number; text: string }[];
  trendBrief?: string;
  plans?: ClipPlan[];
  outputs?: { clip: string; thumbnail: string; plan: ClipPlan; edit?: EditSummary }[];
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
  };
  stages: StageTiming[];
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
    },
    stages: job.timings,
  };
}

export async function saveJob(job: Job, store: Store): Promise<void> {
  await store.writeJson(job.id, "job.json", toRecord(job));
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

    jobs.set(id, {
      id: rec.id,
      url: rec.input.url,
      clipCount: rec.input.clipCount,
      aiProvider: rec.input.aiProvider,
      description: rec.input.description,
      controversialMode: rec.input.controversialMode,
      // a job that was mid-flight when the process died is not still running
      status: rec.status === "running" ? "error" : rec.status,
      stage: rec.stage,
      error: rec.status === "running" ? "interrupted — server restarted" : rec.error,
      log: [],
      emitter: new EventEmitter(),
      createdAt: rec.createdAt,
      timings: rec.stages || [],
    });
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
}): Job {
  const job: Job = {
    id: nanoid(10),
    ...input,
    controversialMode: input.controversialMode ?? false,
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
