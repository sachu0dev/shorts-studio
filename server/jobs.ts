import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";

export type CaptionStyle = "pop" | "minimal" | "hype";

export type AiProvider = "anthropic" | "openai" | "gemini";

export interface ClipPlan {
  index: number;
  title: string;            // shorts title (<=90 chars)
  hook: string;             // first-2-seconds on-screen hook text
  start: number;            // seconds in source video
  end: number;              // seconds in source video
  reason: string;           // why this clip was picked (trend-aware)
  script: string;           // narration/voiceover-style script of the clip
  hashtags: string[];
  captionStyle: CaptionStyle;
  thumbnailText: string;    // <=5 words, punchy
  thumbnailTimestamp: number; // best frame (seconds) for thumbnail
  captions: { start: number; end: number; text: string }[]; // relative to clip start
}

export interface Job {
  id: string;
  url?: string;
  filePath?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;      // user-supplied context: trends, memes, instructions
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
