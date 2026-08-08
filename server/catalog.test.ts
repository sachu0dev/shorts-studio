import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  openCatalog, normalizeYoutubeId, sha256File, claimSource, attachMedia,
  evictSourceMedia, recordJob, deleteJob, recordClip, updateClipState,
  overlapsPublished, recordStageRun, stageStats,
} from "./catalog.js";

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-"));
  return openCatalog(path.join(dir, "catalog.db"));
}

test("normalizeYoutubeId: every real-world URL form resolves to the same id", () => {
  const id = "dQw4w9WgXcQ";
  assert.equal(normalizeYoutubeId(`https://youtu.be/${id}`), id);
  assert.equal(normalizeYoutubeId(`https://www.youtube.com/watch?v=${id}&t=42s&list=PLxyz`), id);
  assert.equal(normalizeYoutubeId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(normalizeYoutubeId(`https://m.youtube.com/watch?app=desktop&v=${id}`), id);
});

test("normalizeYoutubeId: a playlist URL with no v= is rejected, not guessed at", () => {
  assert.equal(normalizeYoutubeId("https://www.youtube.com/playlist?list=PLxyz"), null);
  assert.equal(normalizeYoutubeId("not a url"), null);
});

test("claimSource is idempotent — the second claim reuses the row, does not duplicate it", () => {
  const db = freshDb();
  const a = claimSource(db, { id: "yt:abc", kind: "youtube", url: "https://youtu.be/abc" });
  assert.equal(a.needsDownload, true);
  attachMedia(db, "yt:abc", "/storage/sources/yt_abc/source.mp4", 12345);

  const b = claimSource(db, { id: "yt:abc", kind: "youtube", url: "https://youtu.be/abc" });
  assert.equal(b.needsDownload, false);
  assert.equal(b.mediaPath, "/storage/sources/yt_abc/source.mp4");

  const count = db.prepare("SELECT COUNT(*) as n FROM source").get() as { n: number };
  assert.equal(count.n, 1);
});

test("concurrent claims on two separate connections to the same file yield one row", () => {
  // node:sqlite's DatabaseSync is synchronous, so this cannot exercise a true
  // interleaved race (that needs worker_threads) — but it does prove the
  // real invariant: two independent connections claiming the same fresh
  // source converge on one row, via BEGIN IMMEDIATE's write lock.
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-race-"));
  const dbPath = path.join(dir, "catalog.db");
  const dbA = openCatalog(dbPath);
  const dbB = openCatalog(dbPath);

  const a = claimSource(dbA, { id: "yt:race", kind: "youtube", url: "https://youtu.be/race12345aa" });
  const b = claimSource(dbB, { id: "yt:race", kind: "youtube", url: "https://youtu.be/race12345aa" });
  assert.equal(a.needsDownload, true);
  assert.equal(b.needsDownload, true); // neither has attached media yet — both correctly see "needs download"

  const count = dbA.prepare("SELECT COUNT(*) as n FROM source").get() as { n: number };
  assert.equal(count.n, 1, "two claims on one fresh source must produce one row");
});

test("evicting media nulls mediaPath and preserves the row", () => {
  const db = freshDb();
  claimSource(db, { id: "yt:evict", kind: "youtube", url: "https://youtu.be/evict" });
  attachMedia(db, "yt:evict", "/storage/sources/yt_evict/source.mp4", 999);

  const evicted = evictSourceMedia(db, "yt:evict");
  assert.equal(evicted, true);

  const claim = claimSource(db, { id: "yt:evict", kind: "youtube", url: "https://youtu.be/evict" });
  assert.equal(claim.needsDownload, true, "an evicted source re-downloads cleanly");

  const count = db.prepare("SELECT COUNT(*) as n FROM source").get() as { n: number };
  assert.equal(count.n, 1, "eviction never removes the row");
});

test("deleting a job cascades to clip rows but never to source", () => {
  const db = freshDb();
  claimSource(db, { id: "yt:cascade", kind: "youtube", url: "https://youtu.be/cascade" });
  recordJob(db, { id: "job1", sourceId: "yt:cascade", status: "done" });
  recordClip(db, { id: "clip1", jobId: "job1", sourceId: "yt:cascade", startSec: 0, endSec: 10, state: "rendered" });

  deleteJob(db, "job1");

  const clips = db.prepare("SELECT * FROM clip WHERE jobId = ?").all("job1");
  assert.equal(clips.length, 0);
  const source = db.prepare("SELECT * FROM source WHERE id = ?").get("yt:cascade");
  assert.ok(source, "the source row survives its job being deleted");
});

test("updateClipState: legal transitions apply, illegal ones are rejected", () => {
  const db = freshDb();
  claimSource(db, { id: "yt:state", kind: "youtube", url: "https://youtu.be/state" });
  recordJob(db, { id: "job1", sourceId: "yt:state", status: "done" });
  recordClip(db, { id: "clip1", jobId: "job1", sourceId: "yt:state", startSec: 0, endSec: 10, state: "published" });

  assert.equal(updateClipState(db, "clip1", "job1", "review"), false, "published -> review is not a legal transition");
  assert.equal(updateClipState(db, "clip1", "job1", "archived"), true);
});

test("overlapsPublished: IoU boundary, adjacent windows, and archived clips", () => {
  const db = freshDb();
  claimSource(db, { id: "yt:iou", kind: "youtube", url: "https://youtu.be/iou" });
  recordJob(db, { id: "job1", sourceId: "yt:iou", status: "done" });
  recordClip(db, { id: "published-clip", jobId: "job1", sourceId: "yt:iou", startSec: 100, endSec: 120, state: "published" });
  recordClip(db, { id: "archived-clip", jobId: "job1", sourceId: "yt:iou", startSec: 200, endSec: 220, state: "archived" });

  // [100,120) vs [100,116): intersection 16, union 20 -> IoU 0.8, above 0.5
  assert.ok(overlapsPublished(db, "yt:iou", 100, 116));
  // adjacent, no overlap at all
  assert.equal(overlapsPublished(db, "yt:iou", 120, 140), null);
  // overlaps only the archived clip, not the published one
  assert.equal(overlapsPublished(db, "yt:iou", 205, 218), null);
});

test("sha256File hashes real content deterministically", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "catalog-hash-"));
  const f = path.join(dir, "a.bin");
  writeFileSync(f, "same content");
  const f2 = path.join(dir, "b.bin");
  writeFileSync(f2, "same content");
  const f3 = path.join(dir, "c.bin");
  writeFileSync(f3, "different content");

  const [ha, hb, hc] = await Promise.all([sha256File(f), sha256File(f2), sha256File(f3)]);
  assert.equal(ha, hb, "identical content hashes identically regardless of filename");
  assert.notEqual(ha, hc);
});

test("stage_run: recordStageRun feeds stageStats aggregation", () => {
  const db = freshDb();
  recordStageRun(db, "job1", { name: "transcribe", status: "done", ms: 1000, peakVramMb: 500, cached: false });
  recordStageRun(db, "job1", { name: "transcribe", status: "done", ms: 0, peakVramMb: 500, cached: true });
  recordStageRun(db, "job2", { name: "transcribe", status: "done", ms: 2000, peakVramMb: 600, cached: false });

  const stats = stageStats(db, "transcribe");
  assert.equal(stats.length, 1);
  assert.equal(stats[0].runs, 3);
  assert.ok(Math.abs(stats[0].meanMs - 1000) < 1);
  assert.ok(Math.abs(stats[0].cacheHitRate - 1 / 3) < 0.01);
});
