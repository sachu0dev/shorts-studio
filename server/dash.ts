import { Router } from "express";
import type { DatabaseSync } from "node:sqlite";
import { stageStats } from "./catalog.js";
import { listChannels } from "./youtube/channels.js";

/**
 * Phase 28 — read-only operations dashboard. Every route reads `stage_run` /
 * `source` / `clip` (phase 24) or `channel` metadata (phase 32) and renders
 * them; nothing here recomputes a number the pipeline itself didn't already
 * write (CLAUDE.md rule 3's spirit, applied to monitoring).
 *
 * Review/Published/Archive need phases 25/26/27, not built this pass — they
 * report `{ available: false }` rather than an empty table that looks like
 * zero (gate 9: a panel with no data source must be distinguishable from a
 * panel with zero rows).
 */
export function dashRouter(db: DatabaseSync): Router {
  const router = Router();

  router.get("/runs", (req, res) => {
    const stage = typeof req.query.stage === "string" ? req.query.stage : undefined;
    res.json({ available: true, stages: stageStats(db, stage) });
  });

  router.get("/library", (_req, res) => {
    const sources = db
      .prepare(
        `SELECT s.id, s.kind, s.url, s.title, s.durationSec, s.rights, s.mediaPath, s.bytes,
                s.firstSeenAt, s.lastUsedAt, s.pinned,
                COUNT(c.id) as clipCount,
                SUM(CASE WHEN c.state = 'published' THEN 1 ELSE 0 END) as publishedCount,
                SUM(CASE WHEN c.state = 'archived' THEN 1 ELSE 0 END) as archivedCount
         FROM source s
         LEFT JOIN clip c ON c.sourceId = s.id
         GROUP BY s.id
         ORDER BY (s.bytes IS NULL), s.bytes DESC`
      )
      .all();
    res.json({ available: true, sources });
  });

  router.get("/channels", (_req, res) => {
    res.json({ available: true, channels: listChannels() });
  });

  for (const panel of ["review", "published", "archive"] as const) {
    router.get(`/${panel}`, (_req, res) => res.json({ available: false }));
  }

  return router;
}
