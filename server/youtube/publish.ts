import type { DatabaseSync } from "node:sqlite";
import type { Job, ClipPlan } from "../jobs.js";
import type { Store } from "../artifacts.js";
import type { QueueItem } from "../uploadQueue.js";
import { assertPublishable } from "../rights.js";
import { getAccessToken } from "./channels.js";
import { insertVideo, setThumbnail } from "./upload.js";
import { updateQueueItem } from "../uploadQueue.js";
import { overlapsPublished, updateClipState } from "../catalog.js";

/**
 * Phase 24's "don't publish the same moment twice" — read-and-warn only, never
 * a reason to fail the upload (CLAUDE.md rule 5). A job that predates phase 24,
 * or has no catalog entry for some other reason, just skips this silently.
 */
function checkOverlap(catalog: DatabaseSync | undefined, job: Job, clipId: string, plan: ClipPlan, log: (l: string) => void): void {
  if (!catalog) return;
  try {
    const row = catalog.prepare("SELECT sourceId FROM job WHERE id = ?").get(job.id) as { sourceId: string } | undefined;
    if (!row) return;
    const dup = overlapsPublished(catalog, row.sourceId, plan.start, plan.end);
    if (dup) log(`${clipId}: ⚠️ overlaps an already-published clip (${dup.id} in job ${dup.jobId}) by >50% — publishing anyway, flagged in the catalog`);
  } catch {
    // best-effort only — never blocks a publish
  }
}

function markPublished(catalog: DatabaseSync | undefined, job: Job, clipId: string): void {
  if (!catalog) return;
  try {
    updateClipState(catalog, clipId, job.id, "published");
  } catch {
    // best-effort only
  }
}

/**
 * The phase-15 adapter, generalized for the multi-channel queue (phase 33).
 * `assertPublishable` is the literal first line, before any network call —
 * CLAUDE.md rule 6, and the one thing this file's test suite actually proves.
 */
export async function publishQueueItem(
  job: Job,
  item: QueueItem,
  plan: ClipPlan,
  videoPath: string,
  thumbnailPath: string | undefined,
  store: Store,
  log: (line: string) => void,
  catalog?: DatabaseSync
): Promise<void> {
  assertPublishable(job); // first line — throws for third-party, before any request

  if (item.status === "uploaded" || item.status === "scheduled") {
    log(`${item.clipId}: already ${item.status} (video ${item.videoId}) — skipping`);
    return;
  }

  checkOverlap(catalog, job, item.clipId, plan, log);

  await updateQueueItem(store, job.id, item.clipId, { status: "uploading" });

  try {
    const accessToken = await getAccessToken(item.channelId);
    const formattedHashtags = (plan.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`));
    const description = [plan.script?.trim(), formattedHashtags.join(" "), "\nGenerated with Shorts Studio AI"]
      .filter(Boolean)
      .join("\n\n");

    const videoId = await insertVideo(accessToken, videoPath, {
      title: plan.title,
      description,
      tags: (plan.hashtags ?? []).map((h) => h.replace(/^#/, "")),
      categoryId: "22",
      privacyStatus: item.privacyStatus,
      publishAt: item.publishAt,
    });

    if (thumbnailPath) {
      try {
        await setThumbnail(accessToken, videoId, thumbnailPath);
      } catch (e: any) {
        // Optional service, fail soft (CLAUDE.md rule 5) — the video itself
        // already uploaded successfully.
        log(`${item.clipId}: ⚠️ thumbnail upload failed (${e?.message || e}) — video published without it`);
      }
    }

    // Written before returning — a crash after this point can never retry
    // into a duplicate upload (phase 15/33 gate).
    await updateQueueItem(store, job.id, item.clipId, {
      status: item.publishAt ? "scheduled" : "uploaded",
      videoId,
    });
    log(`${item.clipId}: uploaded — https://youtu.be/${videoId}${item.publishAt ? ` (scheduled ${item.publishAt})` : ""}`);
    markPublished(catalog, job, item.clipId);
  } catch (e: any) {
    await updateQueueItem(store, job.id, item.clipId, { status: "failed", error: String(e?.message || e) });
    throw e;
  }
}
