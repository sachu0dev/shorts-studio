import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Phase 24 — every source video recorded once, downloaded once, re-clippable
 * forever; every stage run queryable in one place. CLAUDE.md rule 4 (stages
 * are idempotent) applied one level up: a source should refuse to redownload
 * with an identical input, the same way a stage refuses to redo work.
 *
 * One SQLite file for the whole project — phase 17 (vector store, not built
 * this pass) opens this same file and adds its own tables, per the doc's own
 * instruction not to grow a second database.
 */

export type SourceKind = "youtube" | "file";
export type ClipState = "rendered" | "review" | "published" | "archived";

export interface SourceRow {
  id: string;
  kind: SourceKind;
  url: string | null;
  title: string | null;
  channelId: string | null;
  durationSec: number | null;
  rights: string | null;
  mediaPath: string | null;
  bytes: number | null;
  firstSeenAt: number;
  lastUsedAt: number;
  pinned: number;
}

export interface ClipRef {
  id: string;
  jobId: string;
}

export interface StageRunInput {
  name: string;
  status: "done" | "error";
  ms: number;
  peakVramMb: number;
  cached: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  url           TEXT,
  title         TEXT,
  channelId     TEXT,
  durationSec   REAL,
  rights        TEXT,
  mediaPath     TEXT,
  bytes         INTEGER,
  firstSeenAt   INTEGER NOT NULL,
  lastUsedAt    INTEGER NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS job (
  id            TEXT PRIMARY KEY,
  sourceId      TEXT NOT NULL REFERENCES source(id),
  createdAt     INTEGER NOT NULL,
  status        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clip (
  id            TEXT NOT NULL,
  jobId         TEXT NOT NULL REFERENCES job(id) ON DELETE CASCADE,
  sourceId      TEXT NOT NULL REFERENCES source(id),
  startSec      REAL NOT NULL,
  endSec        REAL NOT NULL,
  state         TEXT NOT NULL,
  PRIMARY KEY (id, jobId)
);

CREATE TABLE IF NOT EXISTS stage_run (
  jobId       TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL,
  ms          INTEGER NOT NULL,
  peakVramMb  INTEGER NOT NULL,
  cached      INTEGER NOT NULL,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clip_source_state ON clip(sourceId, state);
CREATE INDEX IF NOT EXISTS idx_stage_run_name ON stage_run(name);
CREATE INDEX IF NOT EXISTS idx_stage_run_job ON stage_run(jobId);
`;

export function openCatalog(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  // Foreign keys are off by default per-connection in SQLite — must be set
  // every time, it is not a persisted database setting.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video, not the URL: youtu.be, watch?v=, /shorts/, and m.youtube.com all
 * resolve to the same 11-char id. A playlist URL with no video id returns
 * null rather than guessing — regex, not a service.
 */
export function normalizeYoutubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return YT_ID.test(id) ? id : null;
  }
  if (host === "youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v");
      return id && YT_ID.test(id) ? id : null;
    }
    const shorts = u.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
    return shorts ? shorts[1] : null;
  }
  return null;
}

/** Identity for an uploaded file with no video id: the content itself. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

export interface ClaimResult {
  sourceId: string;
  needsDownload: boolean;
  mediaPath: string | null;
  title: string | null;
}

/**
 * Insert-or-get inside an immediate write transaction: two jobs claiming the
 * same fresh source at the same moment produce one row, because SQLite's
 * write lock (BEGIN IMMEDIATE) serializes them across connections/processes,
 * not just within this one. `needsDownload` covers both "never downloaded"
 * and "media was evicted" — both read as mediaPath IS NULL.
 */
export function claimSource(
  db: DatabaseSync,
  opts: {
    id: string;
    kind: SourceKind;
    url?: string | null;
    title?: string | null;
    channelId?: string | null;
    durationSec?: number | null;
    rights?: string | null;
  }
): ClaimResult {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT OR IGNORE INTO source
         (id, kind, url, title, channelId, durationSec, rights, mediaPath, bytes, firstSeenAt, lastUsedAt, pinned)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0)`
    ).run(opts.id, opts.kind, opts.url ?? null, opts.title ?? null, opts.channelId ?? null, opts.durationSec ?? null, opts.rights ?? null, now, now);
    db.prepare("UPDATE source SET lastUsedAt = ? WHERE id = ?").run(now, opts.id);
    const row = db.prepare("SELECT mediaPath, title FROM source WHERE id = ?").get(opts.id) as
      | { mediaPath: string | null; title: string | null }
      | undefined;
    db.exec("COMMIT");
    if (!row) throw new Error(`claimSource: row for ${opts.id} vanished inside its own transaction`);
    return { sourceId: opts.id, needsDownload: !row.mediaPath, mediaPath: row.mediaPath, title: row.title };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Called once the download this claim asked for actually finishes. */
export function attachMedia(db: DatabaseSync, sourceId: string, mediaPath: string, bytes: number, title?: string | null): void {
  db.prepare("UPDATE source SET mediaPath = ?, bytes = ?, title = COALESCE(?, title) WHERE id = ?").run(
    mediaPath, bytes, title ?? null, sourceId
  );
}

/**
 * The row is what prevents reprocessing; the bytes are what cost disk.
 * Eviction nulls mediaPath and keeps the row — never deletes it. `pinned`
 * sources are never evicted.
 */
export function evictSourceMedia(db: DatabaseSync, sourceId: string): boolean {
  const r = db.prepare("UPDATE source SET mediaPath = NULL WHERE id = ? AND pinned = 0").run(sourceId);
  return r.changes > 0;
}

export function getSource(db: DatabaseSync, sourceId: string): SourceRow | undefined {
  return db.prepare("SELECT * FROM source WHERE id = ?").get(sourceId) as SourceRow | undefined;
}

export function recordJob(db: DatabaseSync, job: { id: string; sourceId: string; status: string }): void {
  db.prepare(
    `INSERT INTO job (id, sourceId, createdAt, status) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status`
  ).run(job.id, job.sourceId, Date.now(), job.status);
}

/** Never deletes the source it points at — only the job and, via cascade, its clip rows. */
export function deleteJob(db: DatabaseSync, jobId: string): void {
  db.prepare("DELETE FROM job WHERE id = ?").run(jobId);
}

export function recordClip(
  db: DatabaseSync,
  clip: { id: string; jobId: string; sourceId: string; startSec: number; endSec: number; state: ClipState }
): void {
  db.prepare(
    `INSERT INTO clip (id, jobId, sourceId, startSec, endSec, state) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, jobId) DO UPDATE SET startSec = excluded.startSec, endSec = excluded.endSec, state = excluded.state`
  ).run(clip.id, clip.jobId, clip.sourceId, clip.startSec, clip.endSec, clip.state);
}

const LEGAL_TRANSITIONS: Record<ClipState, ClipState[]> = {
  rendered: ["review", "published", "archived"],
  review: ["published", "archived"],
  published: ["archived"],
  archived: ["review"], // restore, per phase 28's gate 4
};

export function updateClipState(db: DatabaseSync, id: string, jobId: string, state: ClipState): boolean {
  const current = db.prepare("SELECT state FROM clip WHERE id = ? AND jobId = ?").get(id, jobId) as { state: ClipState } | undefined;
  if (!current || !LEGAL_TRANSITIONS[current.state].includes(state)) return false;
  db.prepare("UPDATE clip SET state = ? WHERE id = ? AND jobId = ?").run(state, id, jobId);
  return true;
}

/**
 * "Don't publish the same moment twice" — IoU against already-published clips
 * of this source. Above 0.5 the new clip is flagged, not silently dropped:
 * sometimes a longer cut of the same moment is a deliberate second post.
 */
export function overlapsPublished(db: DatabaseSync, sourceId: string, start: number, end: number): ClipRef | null {
  const rows = db
    .prepare("SELECT id, jobId, startSec, endSec FROM clip WHERE sourceId = ? AND state = 'published'")
    .all(sourceId) as { id: string; jobId: string; startSec: number; endSec: number }[];
  for (const r of rows) {
    const interStart = Math.max(start, r.startSec);
    const interEnd = Math.min(end, r.endSec);
    const inter = Math.max(0, interEnd - interStart);
    if (inter <= 0) continue;
    const union = Math.max(end, r.endSec) - Math.min(start, r.startSec);
    if (inter / union > 0.5) return { id: r.id, jobId: r.jobId };
  }
  return null;
}

export function recordStageRun(db: DatabaseSync, jobId: string, t: StageRunInput): void {
  db.prepare(
    `INSERT INTO stage_run (jobId, name, status, ms, peakVramMb, cached, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, t.name, t.status, t.ms, t.peakVramMb, t.cached ? 1 : 0, Date.now());
}

export interface StageStat {
  name: string;
  runs: number;
  meanMs: number;
  cacheHitRate: number;
}

/** The question phase 6-13's gates keep asking: did this stage get faster, and how often does the cache hit. */
export function stageStats(db: DatabaseSync, name?: string): StageStat[] {
  const rows = (
    name
      ? db.prepare("SELECT name, COUNT(*) as runs, AVG(ms) as meanMs, AVG(cached) as cacheHitRate FROM stage_run WHERE name = ? GROUP BY name").all(name)
      : db.prepare("SELECT name, COUNT(*) as runs, AVG(ms) as meanMs, AVG(cached) as cacheHitRate FROM stage_run GROUP BY name").all()
  ) as { name: string; runs: number; meanMs: number; cacheHitRate: number }[];
  return rows;
}
