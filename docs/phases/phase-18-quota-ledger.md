# Phase 18 — YouTube API quota ledger

**Goal:** the system knows what it has spent, and refuses calls it can't afford.

## Why here, not phase 0

The master plan puts this in phase 0. **Moved:** it's ~100 lines with no consumer
until phase 19. "Painful to retrofit" doesn't apply to a wrapper around a client
that doesn't exist yet.

But it must land **before** phase 19, not alongside it. A harvester written
without a ledger will be written to assume calls always succeed, and retrofitting
refuse-before-call into that is genuinely annoying.

## The constraint that dictates the design

| Operation | Cost | Meaning |
|---|---|---|
| `search.list` | **100 units** | ~100 searches/day, total |
| `videos.list` (50 IDs) | **1 unit** | ~500k videos/day if batched |
| `playlistItems.list` | **1 unit** | the escape hatch |
| `videos.insert` | ~1600 units, **separate daily bucket** | doesn't compete with reads |

**10,000 units/day per Google Cloud project** — not per key; all keys in a
project share it. Resets midnight Pacific. **Every request costs at least 1 unit,
including failed and malformed ones.**

## Scope

The ledger, the budget policy, and a wrapper every YouTube read goes through.

## Out of scope

Harvesting — phase 19.

## Changes

### `server/youtube/quota.ts` (new)

```ts
export const COST = { search: 100, videos: 1, playlistItems: 1, channels: 1, insert: 1600 } as const;

export async function spend<T>(
  op: keyof typeof COST, count: number, fn: () => Promise<T>
): Promise<T>;   // throws QuotaExceeded BEFORE calling fn
```

**Refuse before calling, never fail after.** Since failed requests still cost
units, discovering you're over budget by making the call is the expensive way to
find out.

Ledger in the [phase 24](phase-24-source-catalog.md) SQLite DB — the store moved
earlier; this is the same database, not a new one. Columns: `op`, `units`, `at`,
`jobId`, `channelId`, `ok`. Log failures too — they cost the same.

### Budget policy

```
  1,500  channel monitoring   (~1,500 playlistItems calls — huge coverage)
  4,500  discovery search     (45 searches, rotated across seed topics)
  2,000  metadata enrichment  (~100,000 videos batched)
  2,000  RESERVE
 ─────────
 10,000
```

> **Corrected by [phase 27](phase-27-performance-loop.md).** This budget
> originally reserved `1,000  analytics / own-channel reads`. **The YouTube
> Analytics API runs on its own quota, separate from the Data API v3's 10,000
> units/day** — that line was reserving Data API budget for calls that never
> spend it. Reallocated above to discovery and reserve. Track analytics as its
> own ledger dimension, and confirm its actual limits in Cloud Console rather
> than from the public quota page, which does not state per-query costs.

**Per-channel floors, once [phase 26](phase-26-multi-channel.md) lands.** Every
channel in one Google Cloud project shares this same 10,000 — the budget does
not multiply with channel count. `channelId` makes spend attributable; a
per-channel reserve floor is what stops one channel's harvest starving another's
publishing. Attribution without a floor only tells you who caused the outage.

**The reserve floor is the point.** An experiment must not be able to starve
production jobs. `spend` refuses anything that would breach 1,500 remaining
unless explicitly flagged as production.

Day boundary is **midnight Pacific**, not local. Getting this wrong means the
budget resets at the wrong time and the ledger drifts from reality.

### The rules that fall out

**Rule 1 — search is scarce.** 100 searches a day is the entire discovery budget.
Paginating one query 5 pages deep costs 500 units — 5% of the day on one keyword.

**Rule 2 — use the uploads-playlist trick.** To watch a channel for new videos,
never use `search.list` (100u). Every channel has an "uploads" playlist;
`playlistItems.list` against it costs **1 unit**. A 100× saving, and the
difference between monitoring 5 channels and 500. **Channel monitoring must never
touch search** — enforce it in the wrapper, not in a comment.

**Rule 3 — search discovers, reads enrich.** `search.list` only to find things
you don't know about. Everything else comes from batched `videos.list`.

**Rule 4 — ETags and field selection.** Conditional requests + `fields=`
projection + GZIP + local caching cut consumption several-fold. Build the wrapper
to send `If-None-Match` from day one; a 304 still costs 1 unit but returns no
quota-heavy payload and lets you skip re-processing.

### `server/youtube/client.ts` (new)

Thin client where every method goes through `spend()`. **No YouTube call anywhere
in the codebase may bypass it** — that's the one invariant this phase exists to
establish.

## Gate

1. Every call is logged with its true cost, including failures.
2. A call that would breach the reserve floor is **refused before dispatch** —
   assert the HTTP client was never invoked.
3. Budget resets at midnight Pacific, verified across a simulated boundary.
4. Channel monitoring via `playlistItems` costs 1 unit, never 100.
5. `spend` accounting survives a process restart (it's in SQLite).
6. Remaining budget is visible in the UI.

## Tests

`quota.test.ts` — pure, fake clock, in-memory DB:
- costs match the table
- refusal happens before `fn()` is called (spy asserts zero invocations)
- reserve floor blocks non-production, allows production
- midnight Pacific rollover resets, local midnight does not
- a failed call still records its units
- concurrent `spend` calls can't both slip under the floor

That last one matters — two parallel harvest calls each seeing "just enough
budget" is the obvious race.

## Risks

| Risk | Mitigation |
|---|---|
| A call path bypasses the wrapper | One client module; grep-able invariant, and phase 19 is its only consumer |
| Quota costs change | `COST` is one table in one file |
| Clock/timezone bugs | Explicit Pacific handling with a rollover test |
| Concurrent spend race | Serialize the check-and-record in a transaction |
