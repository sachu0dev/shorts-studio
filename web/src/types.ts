// Mirrors server/jobs.ts, server/systemCheck.ts. No server-side types are
// importable across the client/server boundary, so this is hand-kept in sync.

export type AiProvider = "anthropic" | "openai" | "gemini" | "ollama" | "groq" | "openrouter" | "cerebras";
/** Which text the pipeline trusts first; the other is always the fallback. */
export type TranscriptSource = "captions" | "whisper";
export type JobStatus = "queued" | "running" | "done" | "error";

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
  contentMode: "funny" | "gaming" | "political";
  captionAnimation: string;
  captionPalette: string;
  captionFont: string;
  layoutTemplate: string;
  memes: { query: string; start: number; end: number; display: string }[];
  monetizationFlag: { risky: boolean; reasons: string[] };
  compositionType?: string;
}

export interface EditSummary {
  compositionType?: string;
  mode: string;
  allowedModes: string[];
  routedReason: string;
  fallbackReason?: string;
  preset: string;
  cameraKeyframes: number;
  heldSegments?: number;
  suppressedSwitches?: number;
  encoder?: string;
  frames?: number;
  /** Whole-clip fraction of faces a 9:16 crop keeps whole — phase 29. */
  retention?: Record<string, number>;
  narrowestSafe?: string;
}

export interface JobOutput {
  clip: string;
  thumbnail: string;
  plan: ClipPlan;
  edit?: EditSummary;
  youtubeUrl?: string;
  youtubeVideoId?: string;
  uploadedAt?: number;
}

/** A themed reel stitched from several short, non-contiguous moments — "every X", "best of". */
export interface CompilationPlan {
  index: number;
  theme: string;
  title: string;
  hook: string;
  script: string;
  hashtags: string[];
  segments: { start: number; end: number }[];
  contentMode: "funny" | "gaming" | "political";
  captionAnimation: string;
  captionPalette: string;
  captionFont: string;
  monetizationFlag: { risky: boolean; reasons: string[] };
}

export interface CompilationOutput {
  clip: string;
  thumbnail: string;
  plan: CompilationPlan;
}

export interface StageTiming {
  name: string;
  status: "done" | "error";
  ms: number;
  peakVramMb?: number;
  cached?: boolean;
}

export interface Job {
  id: string;
  url?: string;
  clipCount: number;
  aiProvider: AiProvider;
  description: string;
  controversialMode: boolean;
  status: JobStatus;
  stage: string;
  log: string[];
  error?: string;
  trendBrief?: string;
  outputs?: JobOutput[];
  compilationOutputs?: CompilationOutput[];
  timings?: StageTiming[];
  createdAt: number;
}

export type CheckStatus = "ok" | "warn" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface SystemCheckReport {
  overall: CheckStatus;
  checkedAt: string;
  results: CheckResult[];
}
