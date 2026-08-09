import { test } from "node:test";
import assert from "node:assert/strict";
import { publishQueueItem, buildUpload, PROMO_FOOTER } from "./publish.js";
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
  captionAnimation: "typewriter", captionPalette: "hype-yellow", captionFont: "Anton", memes: [],
  monetizationFlag: { risky: false, reasons: [] },
};

test("publishQueueItem: an already-uploaded item is skipped without touching the store again", async () => {
  const job = createJob({
    url: "https://youtu.be/x", clipCount: 1, aiProvider: "gemini", description: "",
  });
  const store = fakeStore();
  const done: QueueItem = { ...item, status: "uploaded", videoId: "abc123" };

  await publishQueueItem(job, done, plan, "/tmp/video.mp4", undefined, store, () => {});
  assert.deepEqual(store.calls, [], "an already-uploaded item should skip before touching the store");
});

test("buildUpload: no override uses the plan's title/script, footer always appended", () => {
  const { title, description } = buildUpload(item, plan);
  assert.equal(title, "t");
  assert.ok(description.startsWith("s"), "falls back to plan.script when there's no override");
  assert.ok(description.endsWith(PROMO_FOOTER), "the promo footer is always the last thing in the description");
});

test("buildUpload: title/description overrides win, footer still appended", () => {
  const overridden: QueueItem = { ...item, titleOverride: "My Title", descriptionOverride: "My own description" };
  const { title, description } = buildUpload(overridden, plan);
  assert.equal(title, "My Title");
  assert.ok(description.startsWith("My own description"));
  assert.ok(description.endsWith(PROMO_FOOTER), "an override does not skip the footer");
});

test("buildUpload: a blank/whitespace-only override falls back to the plan default", () => {
  const blank: QueueItem = { ...item, titleOverride: "   ", descriptionOverride: "  " };
  const { title, description } = buildUpload(blank, plan);
  assert.equal(title, "t");
  assert.ok(description.startsWith("s"));
});
