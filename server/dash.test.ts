import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { openCatalog, claimSource, recordJob, recordClip, recordStageRun } from "./catalog.js";
import { dashRouter } from "./dash.js";

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "dash-"));
  return openCatalog(path.join(dir, "catalog.db"));
}

async function withServer(db: ReturnType<typeof freshDb>, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use("/api/dash", dashRouter(db));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}/api/dash`);
  } finally {
    server.close();
  }
}

test("GET /runs aggregates stage_run into means and counts on a known fixture", async () => {
  const db = freshDb();
  recordStageRun(db, "job1", { name: "transcribe", status: "done", ms: 1000, peakVramMb: 500, cached: false });
  recordStageRun(db, "job2", { name: "transcribe", status: "done", ms: 3000, peakVramMb: 500, cached: false });

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/runs`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.available, true);
    const row = body.stages.find((s: { name: string }) => s.name === "transcribe");
    assert.equal(row.runs, 2);
    assert.equal(row.meanMs, 2000);
  });
});

test("GET /library joins clip counts onto each source, sorted by disk", async () => {
  const db = freshDb();
  claimSource(db, { id: "yt:a", kind: "youtube", url: "https://youtu.be/aaaaaaaaaaa" });
  recordJob(db, { id: "job1", sourceId: "yt:a", status: "done" });
  recordClip(db, { id: "clip1", jobId: "job1", sourceId: "yt:a", startSec: 0, endSec: 10, state: "published" });
  recordClip(db, { id: "clip2", jobId: "job1", sourceId: "yt:a", startSec: 20, endSec: 30, state: "archived" });

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/library`);
    const body = await res.json();
    assert.equal(body.available, true);
    const row = body.sources.find((s: { id: string }) => s.id === "yt:a");
    assert.equal(row.clipCount, 2);
    assert.equal(row.publishedCount, 1);
    assert.equal(row.archivedCount, 1);
  });
});

test("a source with no clips still appears in /library with zero counts, not an error", async () => {
  const db = freshDb();
  claimSource(db, { id: "yt:empty", kind: "youtube", url: "https://youtu.be/bbbbbbbbbbb" });

  await withServer(db, async (base) => {
    const res = await fetch(`${base}/library`);
    const body = await res.json();
    const row = body.sources.find((s: { id: string }) => s.id === "yt:empty");
    assert.equal(row.clipCount, 0);
  });
});

test("panels whose phases haven't shipped report available:false, distinct from an empty table", async () => {
  const db = freshDb();
  await withServer(db, async (base) => {
    for (const panel of ["review", "published", "archive"]) {
      const res = await fetch(`${base}/${panel}`);
      const body = await res.json();
      assert.equal(body.available, false, `${panel} must declare itself unavailable, not return an empty list`);
      assert.equal(body.items, undefined);
    }
  });
});
