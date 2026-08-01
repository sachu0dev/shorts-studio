# Phase 28 — Operations dashboard

**Goal:** one surface that answers *what did this system do, and was it right?*

> **Build order: this runs second, right after phase 24 — before phase 6.**
> Numbered 28 because phase numbers are stable file IDs, not a schedule.

## Why it moved to the front

The instinct is to build the dashboard last, when there is finally something to
show. That is backwards, and the reason is phases 6–13.

Each of those phases changes how clips look and how long they take, and each one
ends at a gate asking *did this get better?* Answering that from `job.json` files
and terminal scrollback is how you end up with the phase-4 situation — where a
plausible-looking `distinctFaceTracks: 11` sat in an artifact and only turned out
to be wrong because someone opened the file and thought about it. A monitoring
surface that exists **before** the work it monitors is the difference between
noticing that in an afternoon and noticing it in a month.

Phase 24 has already made this cheap: `stage_run` collects every stage's timing,
VRAM and cache-hit from all seven stages already built, with no per-phase
instrumentation work outstanding.

## Scope

One dashboard, built as a shell with panels. Panels light up as the phases that
produce their data land — the shell does not wait for them.

| Panel | Data source | Lands with |
|---|---|---|
| **Runs** | `stage_run`, `job.json` | phase 24 — **immediately useful** |
| **Library** | `source`, `clip` | phase 24 |
| **Review queue** | `quality/<clipId>.json` | phase 25 |
| **Channels** | `channel`, ledger | phase 26 |
| **Published** | analytics pulls | phase 27 |
| **Archive** | `clip.state = 'archived'` | phase 25 |

Panels 1 and 2 are worth the phase on their own. The rest is a placeholder that
gets filled in, not work deferred.

## Out of scope

Editing a `layoutTimeline` before render — that's phase 23's composition review
UI, a product feature rather than an operations one. Authentication: single
operator, `localhost`.

## Changes

### The panels that matter

**Runs.** Every job, every stage, wall time, peak VRAM, cache hit. Two views: one
job in detail, and — the one that earns the panel — **the same stage across all
jobs over time.** That second view is what makes a phase gate answerable: render
time before and after phase 6, transcription VRAM across model tiers, how often
the artifact cache actually saves a re-run.

The plan has claimed since `CLAUDE.md` rule 7 that *"the laptop's bottleneck is
not where you think."* This is the panel that finally tests the claim.

**Library.** Every source: title, duration, rights posture, disk bytes, clips
produced, published, archived, and whether the last ingest was a dedup hit.
Sorted by disk, this is also the eviction console — the sources costing the most
and returning the least are the first rows.

**Review queue.** The human tiebreak phase 25's three-way verdict exists for. Per
clip: the video playing inline, the sub-scores with their one-line reasons, the
disqualifiers, and Publish / Archive / Re-trim. This panel is the reason the
`review` verdict is safe to ship with guessed thresholds.

**Published — prediction beside outcome.** Every published clip in one table:
what the scorer predicted, what actually happened, and the gap.

That single side-by-side is the most valuable thing on the dashboard. If the
scorer said 0.9 and relative retention came back bottom-decile, you see it in a
row rather than deriving it from a correlation report. It makes the system's
quality legible to a human at a glance, which is the only way anyone actually
notices a scorer drifting wrong.

**Archive.** Every rejected clip with its reasons, restorable in one click.
Nothing is deleted, so the archive is browsable evidence — and when a run of
rejections all cite the same disqualifier, that is a rule to go re-examine.

### Show reasons, never bare scores

The rule phase 20 set and phase 25 inherits, applied to the UI: no number appears
without the sentence that produced it. `0.51` is unactionable; *"opens on a
subordinate clause; first claim at 0:07"* tells you what to do.

Any panel where a human has to open a JSON file to understand a number has
failed, and gate 1 tests exactly that.

### Read-only over the pipeline

The dashboard **never recomputes anything.** It reads artifacts and SQLite and
renders them. Every number on screen must be traceable to a file a stage wrote.

If a panel needs a number nothing writes, the fix is a stage writing it — not the
dashboard deriving it. A dashboard that computes its own version of a metric
eventually disagrees with the pipeline, and then you have two truths and no way
to tell which is which.

### The front-end, honestly

`public/index.html` is 661 lines, single file, no build step, and that has been
the right call. Six panels with tables, filters, inline video and a retention
chart is where it stops being the right call.

**The recommendation is: still no framework, still no build step** — split into a
few static files served as they are, with vanilla JS and `fetch` against the
existing routes. The SSE stream already works and already drives live updates.

> `// ponytail: static files + vanilla JS, no build. Upgrade trigger is named:
> when two panels need to share non-trivial state, or a chart needs real
> interactivity, adopt a small framework THEN — not in anticipation.`

One genuine addition: the retention curve is 100 points per clip and wants to be
a sparkline. That is a `<canvas>` and about thirty lines, not a charting library.

### New routes

```
GET /api/dash/runs?stage=&since=      stage_run, aggregated
GET /api/dash/library                 sources + clip counts
GET /api/dash/review                  clips awaiting a human
GET /api/dash/published               predicted vs realized
POST /api/dash/clips/:id/verdict      publish | archive | restore
```

Read routes are SQL against phase 24's DB. The single write route is the human
override, and it records **who and why** — a verdict a person changed is training
data for phase 27, and an unexplained override teaches nothing.

## Gate

1. **Every rejection is explainable from the dashboard alone**, without opening a
   JSON file. Pick three archived clips at random and try it.
2. Stage timings for all seven currently-built stages appear the day phase 24
   lands — no per-phase instrumentation work required.
3. The cross-job view answers "did phase 6 make rendering faster" with a number.
4. An archived clip is restorable and reappears in the review queue.
5. Predicted-versus-realized is one table, sortable by the gap.
6. Dedup hits are visible — a job that reused a source says so in the Library.
7. The dashboard computes nothing: every displayed number traces to a stage's
   artifact or a catalog row.
8. Loads in under a second with 200 jobs and 1,000 clips in the DB.
9. Panels whose phases haven't shipped render as an explicit "not built yet",
   never as an error or an empty table that looks like zero.

Gate 9 matters more than it sounds: an empty Published panel and a broken
Published panel look identical, and one of them is a bug you'd chase.

## Tests

`dash.test.ts` — against a seeded in-memory DB:
- aggregation queries return correct means and counts on a known fixture
- the verdict route transitions state legally and rejects illegal transitions
  (`published → review` is not a thing)
- an override records actor and reason; an override without a reason is refused
- pagination holds at 1,000 clips
- a panel with no data source reports `unavailable`, distinctly from empty

## Risks

| Risk | Mitigation |
|---|---|
| Dashboard drifts from the pipeline's truth | Strictly read-only; every number traces to an artifact |
| Built before its data exists, sits empty | Panels 1–2 are useful on day one; the rest declare themselves unbuilt |
| Grows into a second application | No framework, no build; named upgrade trigger |
| Slow as job history accumulates | Indexed queries, pagination, aggregate-in-SQL not in JS; 200-job gate |
| Human overrides are unexplained | Reason required; overrides feed phase 27 |
| Becomes the only way to run the system | The existing paste-a-URL flow stays the primary path — this observes, it doesn't replace |
