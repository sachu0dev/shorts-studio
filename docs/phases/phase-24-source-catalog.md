# Phase 24 — Source catalog + telemetry store

**Goal:** every source video is recorded once, downloaded once, and re-clippable
forever — and every stage run on this machine is queryable in one place.

> **Build order: this runs next, before phase 6.** It is numbered 24 because
> phase numbers are stable file IDs, not a schedule. Two reasons it moved: it
> pays for itself today by killing re-downloads, and it is the store the
> dashboard (28) reads. Building the monitoring surface *before* phases 6–13
> means you can watch each of those phases change the numbers as you build it,
> instead of finding out afterwards.

## Why now

Today a source lives at `storage/<jobId>/source.mp4`. Clip the same 44-minute
podcast three times and you have three copies of a 400 MB file and three trips
past yt-dlp's bot detection — the one external dependency in the pipeline with a
real chance of being rate-limited or blocked outright.

That is annoying at one channel and untenable at five. Once phase 26 runs
multiple channels and Content Hunt (19–20) feeds candidates automatically, the
same video **will** be proposed twice: by two seed channels covering the same
story, by a re-upload, by you pasting a URL you already pasted last month.

This is `CLAUDE.md` rule 4 — stages are idempotent — applied one level up. A
stage already refuses to redo work with identical inputs. A *source* should too.

> **Worth pulling forward.** This is the only phase in Block D that pays for
> itself immediately, at one channel, today. If you want it before 25–28, it
> slots in anywhere after phase 1 with no dependencies but SQLite.

## Scope

The catalog tables, source-level dedup, shared media storage, the stage
telemetry table, and the publish-overlap check. One new module.

## Out of scope

Judging clips (25). Choosing a channel (26). Any UI — phase 28 renders this;
this phase makes the data exist.

## Changes

### The database is phase 17's, not a second one

SQLite arrives in phase 17 for vectors. **Use that file.** Two SQLite databases
in one project is two backup stories, two migration paths and two places to look
when a number is wrong.

If phase 24 lands before 17 — likely, given the note above — this phase opens the
file and 17 adds tables to it.

### `server/catalog.ts` (new)

Three tables. Not more; the artifacts on disk are still authoritative for
everything a stage produces.

```sql
CREATE TABLE source (
  id            TEXT PRIMARY KEY,   -- 'yt:dQw4w9WgXcQ' or 'sha256:ab12…'
  kind          TEXT NOT NULL,      -- 'youtube' | 'file'
  url           TEXT,
  title         TEXT,
  channelId     TEXT,
  durationSec   REAL,
  rights        TEXT,               -- phase 14 posture — a property of the SOURCE
  mediaPath     TEXT,               -- NULL once evicted; the row survives
  bytes         INTEGER,
  firstSeenAt   INTEGER NOT NULL,
  lastUsedAt    INTEGER NOT NULL,
  pinned        INTEGER DEFAULT 0
);

CREATE TABLE job (
  id            TEXT PRIMARY KEY,   -- existing nanoid job id
  sourceId      TEXT NOT NULL REFERENCES source(id),
  createdAt     INTEGER NOT NULL,
  status        TEXT NOT NULL
);

CREATE TABLE clip (
  id            TEXT NOT NULL,      -- 'clip3'
  jobId         TEXT NOT NULL REFERENCES job(id),
  sourceId      TEXT NOT NULL REFERENCES source(id),
  startSec      REAL NOT NULL,      -- in SOURCE time, not clip time
  endSec        REAL NOT NULL,
  state         TEXT NOT NULL,      -- 'rendered' | 'review' | 'published' | 'archived'
  PRIMARY KEY (id, jobId)
);
```

`clip.startSec`/`endSec` are in **source** time deliberately. Clip-relative
numbers can't answer "have I already published this moment", which is the whole
point of storing them here.

### Monitoring everything, without touching any other phase

`CLAUDE.md` rule 7 says instrument from the first commit of every stage, and
phase 1 did: `runStage` records name, wall time, peak VRAM and cached-ness, then
calls `ctx.onTiming`. That hook is **already wired**, at
[index.ts:134](../../server/index.ts#L134).

So the whole telemetry story is one more subscriber on a callback that already
fires:

```sql
CREATE TABLE stage_run (
  jobId       TEXT NOT NULL REFERENCES job(id),
  name        TEXT NOT NULL,       -- 'transcribe', 'analyze:clip3', …
  status      TEXT NOT NULL,       -- 'done' | 'error'
  ms          INTEGER NOT NULL,
  peakVramMb  INTEGER NOT NULL,
  cached      INTEGER NOT NULL,
  at          INTEGER NOT NULL
);
```

**No phase from 1 to 23 needs editing to become monitorable.** Every stage
already built — ingest, transcribe, scenes, plan, analyze, render — starts
reporting the moment this table exists, and every stage built after it reports
for free. That is the payoff for the rule having been followed from the start,
and it is why this phase can move to the front of the queue without dragging
seven other phase docs with it.

`job.json` stays authoritative per job. This table exists for the questions a
per-job file cannot answer: *which stage is slowest across 200 jobs, what does a
render actually cost me in GPU-seconds, did the phase-6 rewrite make anything
faster, how often does the cache actually hit.* Those are the questions the
dashboard is for.

### Identity: the video, not the URL

```
https://youtu.be/dQw4w9WgXcQ
https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL…
https://www.youtube.com/shorts/dQw4w9WgXcQ
https://m.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ
```

Four URLs, one video, one row. Normalize to the 11-character video ID before
touching the database. This is the entire dedup mechanism for YouTube sources and
it is a regex, not a service.

For uploaded files there is no ID, so the identity is the content:
`sha256` of the file. Two uploads of the same footage under different names are
one source. On this machine a 400 MB hash costs about a second, and `ffprobe`
already reads the whole file during ingest — it is not the expensive part of
anything.

> `// ponytail: full-file sha256. ~1s/400MB here. If sources get much larger,
> hash (size + first 8MB + last 8MB) instead — collision risk is theoretical for
> this corpus.`

### Shared media, per-job view

Media moves to `storage/sources/<sourceId>/source.mp4`. The job directory keeps
a **symlink** at the path `ingest.json` already points to.

Downstream code opens a path and it works. `download.ts`, `scenes.py`,
`analyze_clip.py`, `edit.ts` — none of them change, and none of them learn that
sharing exists. Deleting a job directory removes a symlink, never the source.

> `// ponytail: symlink. Zero downstream change today. Phase 23's S3Store can't
> symlink — it stores the source once under its own key and resolves the
> reference in `Store.path()`. That's an adapter concern, which is where it
> belongs.`

### The ingest stage becomes a claim

```ts
export async function claimSource(url: string): Promise<{ sourceId: string; downloaded: boolean }>;
```

Insert-or-get inside a transaction, **then** download if the row was new. Two
jobs started on the same fresh URL in the same second must produce one download,
not two — the obvious race, and the one worth a test.

The log line matters more than it looks: `source yt:dQw4w9WgXcQ already held
(2026-07-14, 3 clips) — skipping download`. Silent dedup is indistinguishable
from a bug when a job finishes in four seconds.

### Rights posture attaches to the source

Phase 14 decides `owned` / `third-party`. That is a fact about the video, not
about an attempt to clip it. Storing it per job invites the same video being
`owned` on Monday and `third-party` on Friday, and rule 6 says the posture is
structural.

Decide once, on first ingest. Re-deciding is an explicit action with a log entry.

### Eviction ≠ forgetting

Sources are the only large files in the system. A source with no pending job,
nothing published in N days, and `pinned = 0` can have its media deleted —
`mediaPath` goes NULL, **the row stays forever**.

The row is what prevents reprocessing. The bytes are what cost disk. Conflating
them is how you end up re-downloading a video you deliberately rejected in March.

Re-clipping an evicted source re-downloads it, and says so.

### Publish-overlap check

"No video used multiple times" has a second reading beyond re-downloading: don't
publish the same *moment* twice. Two jobs on one source can easily select
overlapping windows — a good moment is good both times.

```ts
export function overlapsPublished(sourceId: string, start: number, end: number): ClipRef | null;
```

Intersection-over-union against `clip` rows in state `published`. Above 0.5 the
new clip is flagged, not silently dropped — sometimes a longer cut of the same
moment is a deliberate second post.

## Contracts

`ingest.json` gains the reference; the shape stays backward compatible:

```jsonc
{
  "schemaVersion": 2,
  "video": "source.mp4",          // unchanged — a symlink now
  "duration": 2644.6,
  "source": { "id": "yt:dQw4w9WgXcQ", "reused": true, "firstSeenAt": 1752480000000 }
}
```

## Gate

1. The same URL submitted twice downloads once. Second job's ingest stage
   finishes in **seconds**, and the log says why.
2. `youtu.be/X`, `watch?v=X&t=42&list=…`, `shorts/X` and `m.youtube.com/…v=X`
   all resolve to one `source` row.
3. Two jobs launched simultaneously on one fresh URL produce **one** download.
4. The same local file uploaded under two names is one source.
5. Deleting a job directory leaves the source intact; evicting a source's media
   leaves its row intact and a later job re-downloads cleanly.
6. Publishing a clip that overlaps an already-published clip by >50% is flagged
   before upload.
7. Rights posture is read from the source, not re-derived per job.
8. **Every stage of a normal job lands in `stage_run` with no change to any
   existing stage** — run one job and confirm all seven appear.
9. Cross-job questions are answerable in SQL: slowest stage over N jobs, mean
   GPU-seconds per rendered clip, cache-hit rate per stage.

Gate 1 is the one you'll feel: re-clipping a 44-minute podcast should stop
costing a download. Gate 8 is the one that proves rule 7 was worth following.

## Tests

`catalog.test.ts` — in-memory SQLite, no network:

- URL normalization table: every form above → the same ID; a playlist URL with
  no `v=` is rejected rather than guessed at.
- `claimSource` is idempotent; concurrent claims yield one insert (run them
  genuinely in parallel — a sequential test proves nothing about the race).
- Evicting media nulls `mediaPath` and preserves the row.
- `overlapsPublished`: IoU maths at the 0.5 boundary, adjacent-but-not-
  overlapping windows return null, `archived` clips don't block.
- Deleting a job cascades to `clip` rows but never to `source`.

## Risks

| Risk | Mitigation |
|---|---|
| yt-dlp bot detection / rate limiting | Dedup is itself the mitigation — this phase reduces download volume, which is the exposure |
| Disk fills with shared sources | Eviction policy + `pinned`; row survives so the record isn't lost |
| Symlinks don't survive phase 23 | Named ceiling; S3Store resolves the reference in the adapter, which is what the phase-1 interface is for |
| A second SQLite file appears | Explicitly one DB, shared with phase 17 |
| Dedup hides a genuinely changed re-upload | Same video ID with a different duration → warn and re-ingest rather than assume |
| Silent dedup looks like a broken job | Explicit log line naming the prior job and date |
