# Phase 19 — Content Hunt: seeds, harvest, cheap screening

**Goal:** turn YouTube into a stream of candidate videos, without spending real
money or quota on the ones that don't matter.

`[revisit]` — the screening thresholds here should be tuned against what Block A
actually produced good clips from. Write them as configurable from the start.

## Why now

First half of the funnel:

```
SEED  →  HARVEST  →  ENRICH  →  SCORE  →  QUEUE
                                 └── phase 20 ──┘
```

Answers one question repeatedly: **"which video should I turn into content right
now, and why?"**

## Scope

Stages H1–H3. Seeds, quota-aware harvest, metadata screening. All deterministic,
no GPU, no cloud LLM.

## Out of scope

Semantic dedup, scoring, queue — phase 20. Nothing here needs embeddings.

## Changes

### H1 — Seeds

SQLite table: keywords, tracked channels, topics, competitor channels. Each seed
carries a **cadence** — how often to re-harvest — so slow-moving niches don't
consume search quota daily.

CRUD in the existing web UI. Seeds are edited by hand; there's no discovery of
seeds, and there shouldn't be yet.

### H2 — Harvest

| Source | API | Cost | Frequency |
|---|---|---|---|
| Tracked channels | `playlistItems.list` on uploads playlist | 1u | often |
| Keyword seeds | `search.list` | 100u | round-robin by cadence |

**Round-robin, not all-at-once.** Forty searches a day across rotating seeds
beats five seeds paginated deep. Every call goes through phase 18's `spend()`.

Dedup candidates against everything already seen — a `seen_videos` table with the
video id as primary key. Cheapest possible filter, applied first.

### H3 — Cheap screening

Batched `videos.list` (50 ids, 1 unit) for metadata, then filter **before**
spending anything expensive:

| Filter | Rule |
|---|---|
| Duration | in range for clipping (skip <2 min and >4 h) |
| Language | matches your target (en / hi / hinglish) |
| Age | recent enough to still be an opportunity |
| Already processed | drop |
| Auto-captions | present (cheap transcript path exists) |
| **Velocity** | views ÷ hours-since-publish |
| Engagement | (likes + comments) ÷ views |
| **Channel-relative outlier** | is it overperforming *that channel's* baseline? |

Two of these carry most of the weight:

**Velocity is the strongest early signal.** A video's absolute view count tells
you what already happened; views-per-hour tells you what's happening now.

**Channel-relative outlier beats absolute numbers.** A 50k-view video on a
5k-average channel is a far stronger signal than a 500k-view video on a 2M
channel. Requires a per-channel baseline — a rolling median of that channel's
recent videos, refreshed cheaply via the uploads playlist.

### Transcripts don't come from the Data API

Caption retrieval via the API is awkward and quota-costly. Use **yt-dlp subtitle
extraction** for auto-captions during screening; only run WhisperX — expensive,
GPU — on videos that survive scoring in phase 20. `download.ts` already does
exactly this, best-effort and fail-soft.

### Rights posture at harvest

Every candidate is tagged **at harvest time**, reusing phase 14's field. Anything
not from your own channels defaults to `third-party`. Read the CC licence flag
from `videos.list` metadata where present and surface it as a suggestion.

This is why phase 14 came first: harvest produces hundreds of third-party
candidates, and the gate must already exist and already be fail-closed.

## Contracts

```jsonc
{
  "videoId": "dQw4w9WgXcQ",
  "harvestedAt": 1753900000000,
  "via": "playlistItems",
  "seedId": 4,
  "rights": "third-party",
  "ccLicense": false,
  "metrics": { "views": 51200, "hoursSincePublish": 18.4, "velocity": 2782,
               "engagementRatio": 0.061, "channelBaseline": 5100, "outlierRatio": 10.0 },
  "screened": { "passed": true, "reasons": ["velocity high", "10x channel baseline"] }
}
```

`reasons[]` on both pass and fail. A funnel you can't inspect is a funnel you
can't tune.

## Gate

1. A full harvest run stays inside budget and **never breaches the reserve floor**.
2. Channel monitoring costs 1 unit per channel. Assert from the ledger, not from
   the code.
3. Screening rejects the obvious majority — if >20% pass, the filters are too loose.
4. Every candidate carries a rights posture; none default to `owned`.
5. Every seed gets harvested on its cadence; none starve.
6. Re-running the same day is a near-no-op (dedup works).
7. A day's harvest costs **well under 10,000 units**, with the reserve intact.

## Tests

- `screening.test.ts` — velocity, engagement, outlier ratio from fixtures;
  zero-view and zero-hour videos don't divide by zero.
- Channel baseline is a median, not a mean (one viral video must not move it).
- `harvest.test.ts` — round-robin respects cadence; a seed never harvests twice
  in one cycle; dedup drops known ids before any API call.
- Rights defaults to `third-party` for every non-owned source.

## Risks

| Risk | Mitigation |
|---|---|
| Quota exhausted mid-day | Phase 18's reserve floor; refuse-before-call |
| Screening too loose → expensive stages flooded | Gate item 3 makes it measurable |
| Channel baseline skewed by one viral video | Median, not mean |
| Seeds starve under round-robin | Cadence tracking with a last-harvested timestamp |
| Velocity misleading for very new videos | Minimum age before velocity counts (e.g. 2 h) |
| `[revisit]` Thresholds guessed, not measured | Configurable; tune against Block A's actual successes |
