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
  /** Per-segment visual effects the taste pass chose — phase 12. */
  effects?: { t0: number; t1: number; template: string; reason?: string }[];
  taste?: { applied: boolean; provider?: string; fellBackToRouter: boolean; rejected: { segment: number; why: string }[] };
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

export interface Channel {
  id: string;
  ytChannelId: string;
  title: string;
  thumbnailUrl: string;
  customUrl?: string;
  addedAt: number;
}

export type QueuePrivacy = "public" | "unlisted" | "private";
export type QueueItemStatus = "pending" | "uploading" | "uploaded" | "scheduled" | "failed";
export type QueueMode = "public" | "unlisted" | "release";

export interface QueueItem {
  clipId: string;
  order: number;
  channelId: string;
  privacyStatus: QueuePrivacy;
  publishAt?: string;
  titleOverride?: string;
  descriptionOverride?: string;
  status: QueueItemStatus;
  videoId?: string;
  error?: string;
}

export interface UploadQueue {
  jobId: string;
  items: QueueItem[];
  createdAt: number;
  /** Set when a PATCH edit couldn't be pushed to YouTube (e.g. rescheduling an already-live video) — the local record for that item is left unchanged. */
  errors?: string[];
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

// Phase 28 — operations dashboard. Every field here is read straight off
// phase 24's catalog rows; nothing on this page is computed client-side.
export interface DashStageStat {
  name: string;
  runs: number;
  meanMs: number;
  cacheHitRate: number;
}

export interface DashRuns {
  available: true;
  stages: DashStageStat[];
}

export interface DashSourceRow {
  id: string;
  kind: "youtube" | "file";
  url: string | null;
  title: string | null;
  durationSec: number | null;
  rights: string | null;
  mediaPath: string | null;
  bytes: number | null;
  firstSeenAt: number;
  lastUsedAt: number;
  pinned: number;
  clipCount: number;
  publishedCount: number;
  archivedCount: number;
}

export interface DashLibrary {
  available: true;
  sources: DashSourceRow[];
}

export interface DashChannels {
  available: true;
  channels: Channel[];
}

export interface DashUnavailable {
  available: false;
}
