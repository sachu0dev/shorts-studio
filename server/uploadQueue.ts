import type { Artifact, Store } from "./artifacts.js";

/**
 * Upload queue (phase 33): the batch of clips selected on a job, in the order
 * they'll be published, with when and where. Persisted so a page refresh or a
 * server restart mid-upload shows accurate per-item status — the same
 * idempotency rule every other stage in this pipeline already follows.
 */

export type QueuePrivacy = "public" | "unlisted" | "private";
export type QueueItemStatus = "pending" | "uploading" | "uploaded" | "scheduled" | "failed";

export interface QueueItem {
  clipId: string;
  order: number;
  channelId: string;
  privacyStatus: QueuePrivacy;
  /** ISO 8601. Only set (and only meaningful to YouTube) when `privacyStatus === "private"`. */
  publishAt?: string;
  status: QueueItemStatus;
  videoId?: string;
  error?: string;
}

export interface UploadQueue extends Artifact {
  jobId: string;
  items: QueueItem[];
  createdAt: number;
}

export const UPLOAD_QUEUE_SCHEMA_VERSION = 1;

export type QueueMode = "public" | "unlisted" | "release";

export interface ScheduleInput {
  /** ISO 8601 — when the first item in the list is released. */
  firstAt: string;
  /** Milliseconds between each successive item's release. */
  gapMs: number;
}

/**
 * `publishAt` for item `index` in upload order: `firstAt + index * gapMs`.
 * Pure so the dialog's preview and the server compute the identical value —
 * one formula, not two implementations that can drift.
 */
export function computePublishAt(schedule: ScheduleInput, index: number): string {
  return new Date(new Date(schedule.firstAt).getTime() + index * schedule.gapMs).toISOString();
}

/**
 * Builds the queue from an ordered clip list + release choice. `release`
 * mode uploads as `private` with a computed `publishAt` — YouTube's native
 * scheduler auto-flips each to `public` at its own instant, no polling
 * required on this side (see phase 32/33 docs' research section for why this
 * replaced the originally-described "upload unlisted, flip it later" idea).
 */
export function buildQueue(jobId: string, clipIds: string[], channelId: string, mode: QueueMode, schedule?: ScheduleInput): UploadQueue {
  const items: QueueItem[] = clipIds.map((clipId, index) => {
    if (mode === "release") {
      if (!schedule) throw new Error("release mode requires a schedule");
      return { clipId, order: index, channelId, privacyStatus: "private", publishAt: computePublishAt(schedule, index), status: "pending" };
    }
    return { clipId, order: index, channelId, privacyStatus: mode, status: "pending" };
  });
  return { schemaVersion: UPLOAD_QUEUE_SCHEMA_VERSION, jobId, items, createdAt: Date.now() };
}

const QUEUE_FILE = "uploadQueue.json";

export async function readQueue(store: Store, jobId: string): Promise<UploadQueue | null> {
  return store.readJson<UploadQueue>(jobId, QUEUE_FILE);
}

export async function writeQueue(store: Store, queue: UploadQueue): Promise<void> {
  await store.writeJson(queue.jobId, QUEUE_FILE, queue);
}

/** Mutates one item's status in place and persists — the unit every upload step writes through. */
export async function updateQueueItem(
  store: Store,
  jobId: string,
  clipId: string,
  patch: Partial<Pick<QueueItem, "status" | "videoId" | "error">>
): Promise<UploadQueue | null> {
  const queue = await readQueue(store, jobId);
  if (!queue) return null;
  const item = queue.items.find((i) => i.clipId === clipId);
  if (!item) return null;
  Object.assign(item, patch);
  await writeQueue(store, queue);
  return queue;
}
