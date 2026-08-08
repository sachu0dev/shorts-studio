import { test } from "node:test";
import assert from "node:assert/strict";
import { publishQueueItem } from "./publish.js";
import { createJob } from "../jobs.js";
import type { QueueItem } from "../uploadQueue.js";
import type { ClipPlan } from "../jobs.js";
import type { Store } from "../artifacts.js";

function fakeStore(): Store & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    path: (jobId, rel) => { calls.push(`path:${jobId}/${rel}`); return `/tmp/${jobId}/${rel}`; },
    exists: async (jobId, rel) => { calls.push(`exists:${jobId}/${rel}`); return false; },
    readJson: async (jobId, rel) => { calls.push(`readJson:${jobId}/${rel}`); return null; },
    writeJson: async (jobId, rel) => { calls.push(`writeJson:${jobId}/${rel}`); },
    writeStream: (jobId, rel) => { calls.push(`writeStream:${jobId}/${rel}`); throw new Error("not used in this test"); },
  };
}

const item: QueueItem = { clipId: "clip1", order: 0, channelId: "UC_x", privacyStatus: "public", status: "pending" };
const plan: ClipPlan = {
  index: 1, title: "t", hook: "h", start: 0, end: 1, reason: "", script: "s", hashtags: [],
  thumbnailText: "", thumbnailTimestamp: 0, captions: [], contentMode: "funny",
  captionAnimation: "typewriter", captionPalette: "hype-yellow", captionFont: "Anton", layoutTemplate: "fullscreen", memes: [],
  monetizationFlag: { risky: false, reasons: [] },
};

test("publishQueueItem: assertPublishable is called before any store access or network call for third-party", async () => {
  const job = createJob({
    url: "https://youtu.be/x", clipCount: 1, aiProvider: "gemini", description: "",
    rights: { posture: "third-party", declaredAt: Date.now(), declaredBy: "user" },
  });
  const store = fakeStore();

  await assert.rejects(() => publishQueueItem(job, item, plan, "/tmp/video.mp4", undefined, store, () => {}));
  assert.deepEqual(store.calls, [], "a call was made before the rights gate threw");
});

test("publishQueueItem: an already-uploaded item is skipped without touching the store again", async () => {
  const job = createJob({
    url: "https://youtu.be/x", clipCount: 1, aiProvider: "gemini", description: "",
    rights: { posture: "owned", declaredAt: Date.now(), declaredBy: "user" },
  });
  const store = fakeStore();
  const done: QueueItem = { ...item, status: "uploaded", videoId: "abc123" };

  await publishQueueItem(job, done, plan, "/tmp/video.mp4", undefined, store, () => {});
  assert.deepEqual(store.calls, [], "an already-uploaded item should skip before touching the store");
});
