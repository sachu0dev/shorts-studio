import type { Job, ClipPlan } from "../jobs.js";
import type { Store } from "../artifacts.js";
import type { QueueItem } from "../uploadQueue.js";
import { assertPublishable } from "../rights.js";
import { getAccessToken } from "./channels.js";
import { insertVideo, setThumbnail } from "./upload.js";
import { updateQueueItem } from "../uploadQueue.js";

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
  log: (line: string) => void
): Promise<void> {
  assertPublishable(job); // first line — throws for third-party, before any request

  if (item.status === "uploaded" || item.status === "scheduled") {
    log(`${item.clipId}: already ${item.status} (video ${item.videoId}) — skipping`);
    return;
  }

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
  } catch (e: any) {
    await updateQueueItem(store, job.id, item.clipId, { status: "failed", error: String(e?.message || e) });
    throw e;
  }
}
