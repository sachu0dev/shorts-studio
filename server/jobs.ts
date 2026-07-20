import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";

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
  | "speed-ramp"
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
  query: string;   // Tenor search term
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
  outputs?: { clip: string; thumbnail: string; plan: ClipPlan }[];
  emitter: EventEmitter;
  createdAt: number;
}

const jobs = new Map<string, Job>();

export function createJob(input: {
  url?: string;
  filePath?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;
  controversialMode: boolean;
}): Job {
  const job: Job = {
    id: nanoid(10),
    ...input,
    status: "queued",
    stage: "Queued",
    log: [],
    emitter: new EventEmitter(),
    createdAt: Date.now(),
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
