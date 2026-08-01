# Phase 27 — Performance ingest + calibration

**Goal:** the quality gate's thresholds stop being guesses and start being
measurements from your own channels.

`[revisit]` — this phase cannot be finished on the day it is built. It needs
published clips with settled analytics, and there is a hard sample floor below
which it must refuse to run.

## Why now

Phase 25 ships a scorer built on creator folklore: a hook weight, a watch-through
threshold, a payoff-tail limit. Reasonable starting values, all of them
unverified against a single clip of yours.

This is the phase that closes the loop — and it is the only phase in the plan
that can tell you whether **any** of Block A worked. Phases 6–13 were an argument
that better framing and better captions produce better clips. That argument has
never been checked against a viewer.

## The metric this phase is built around

YouTube Analytics exposes `relativeRetentionPerformance`: a 0–1 value showing how
well a video retains viewers **relative to other YouTube videos of similar
length**.

That normalization is the entire reason this phase is buildable. Raw views are
useless as an edit signal — a clip's view count is dominated by topic, timing,
thumbnail and luck, none of which the editor controls. Relative retention is
normalized against length and against the rest of the platform, so a new
channel's 800-view Short and an established channel's 400k Short are directly
comparable on it. It is the closest thing available to *"was this edit good?"*

Paired with `audienceWatchRatio` over the `elapsedVideoTimeRatio` dimension —
100 data points across the video — you get the **shape**, not just the average.
Where viewers leave is far more actionable than how many stayed: a cliff at 0:03
is a hook failure, a slow bleed from 0:15 is a pacing failure, and those two
call for opposite fixes.

## Scope

Scheduled analytics ingest, the correlation report, threshold recalibration, and
the exploration slice.

## Out of scope

Fine-tuning or training any model — see *Calibration, not training*. Changing
strategy automatically; phase 21's boundary holds, this informs.

## Changes

### Ingest schedule

Pull per published clip at **day 1, 3, 7 and 28** after publishing. Not
continuously: a Short's distribution is largely decided within days, hourly
polling buys noise, and day 28 is what tells you whether it kept being
recommended.

Metrics per clip:

| Report | Fields |
|---|---|
| Basic | `views`, `averageViewPercentage`, `averageViewDuration`, `estimatedMinutesWatched`, `likes`, `comments`, `shares`, `subscribersGained` |
| Retention | dimension `elapsedVideoTimeRatio`; metrics `audienceWatchRatio`, `relativeRetentionPerformance` |
| Traffic source | which surface delivered the views |

Scopes: `yt-analytics.readonly` — read-only, and **not** the monetary scope,
which is a wider blast radius for a token on a laptop and buys nothing here.

**The retention report cannot batch.** It rejects a comma-separated video filter;
it is one query per video. That is the rate constraint that shapes the schedule —
four pulls × N clips, so a hundred published clips is four hundred queries spread
over a month, not a burst.

### Correction to phase 18's budget

**The YouTube Analytics API has its own quota, separate from the Data API v3's
10,000 units/day.** Phase 18's budget reserves a `1,000  analytics / own-channel
reads` line against the Data API — for calls that do not spend Data API units at
all.

That line should be **reallocated to discovery and reserve**, and the analytics
budget tracked as its own dimension in the ledger. Confirm the exact Analytics
limits in Cloud Console rather than from documentation — the public quota page
does not state per-query costs, and guessing at a limit you can measure is
avoidable.

### Calibration, not training

The temptation is to fine-tune a model on your outcomes. Don't. With tens or
hundreds of clips there is nothing to train — you would be fitting noise with a
very expensive tool and then trusting the result because it came out of a GPU.

What the data genuinely supports is **fitting weights on under ten features**:
correlate each phase-25 sub-score (`hook`, `standalone`, `payoff`, `pacing`) and
each deterministic disqualifier against realized `relativeRetentionPerformance`,
then reweight the composite. That is a small regression, it is honest at N=50,
and it is inspectable — you can read the coefficients and disagree with them.

Concrete outputs, in order of how much they're worth:

1. **Which disqualifiers actually predict failure.** If `dangling-reference`
   correlates strongly and `dead-air` doesn't, one is a real defect and the other
   is a rule someone invented. Drop the one that doesn't earn its place.
2. **The real watch-through thresholds for your niches**, replacing the ~65% /
   ~50% folklore. Indian comedy and gaming will not share a number.
3. **Whether Block A worked.** Clips rendered before and after phase 7's router
   are comparable on relative retention. This is the only honest answer to
   "did the composition work matter", and it is worth building the phase for on
   its own.

### The sample floor, and why it is the important part

```ts
export const CALIBRATION_FLOOR = { perChannel: 30, perVerdictBand: 10 };
```

Recalibration **refuses** below the floor, loudly, naming how many more clips it
needs.

A system that "learns" from six clips will confidently learn noise, tighten its
thresholds around it, and then reject good clips forever — while reporting that
it is improving. It produces no error, no complaint and no way to notice. This
floor is the single most important safety property in the phase, and it is worth
more than any modelling choice in it.

### The exploration slice

If you only publish what the scorer likes, you only ever collect evidence about
what the scorer likes, and it can never discover that it was wrong. The
archive fills with clips whose real performance is permanently unknown.

So: publish **10–15% of `review`-band clips deliberately**, chosen at random, and
label them. They are the control group. Phase 21's risk table already asks for
"some exploration in clip selection" — this is that, made concrete and
measurable.

The payoff is direct: if exploration clips systematically outperform their
predicted band, the gate is too tight and is costing you reach. Nothing else in
the system can detect that.

### What feeds back where — and what must not

| Signal | Feeds | Never feeds |
|---|---|---|
| `relativeRetentionPerformance`, retention shape | phase 25 weights, phase 12 taste | — |
| Views, impressions, CTR | phase 20 opportunity scoring, topic selection | **edit weights** |
| Likes / comments / shares | phase 21 memory `performance` | edit weights, alone |

The middle row is the one to get right. Views measure the thumbnail, the title,
the topic and the moment; retention measures the edit. Feeding views back into
edit decisions teaches the editor to optimise for things it does not control,
and the lesson it learns will be superstition. Keep the attribution honest even
though it means throwing away the biggest, most satisfying number you have.

This also removes the `[revisit]` from phase 20 and completes phase 21's
`performance` field with real values instead of placeholders.

## Contracts

```jsonc
{
  "schemaVersion": 1,
  "clipId": "clip3", "videoId": "dQw4w9WgXcQ", "channelId": "in-gaming",
  "publishedAt": 1753900000000,
  "pulls": [
    { "day": 1, "at": 1753990000000,
      "views": 4120, "averageViewPercentage": 61.4, "averageViewDuration": 22.1,
      "likes": 310, "comments": 21, "shares": 44, "subscribersGained": 12,
      "relativeRetentionPerformance": 0.71,
      "audienceWatchRatio": [1.0, 0.94, 0.88, "…100 points"] }
  ],
  "predicted": { "composite": 0.62, "verdict": "review", "thresholdsVersion": "2026-08-01" },
  "exploration": true
}
```

`predicted` alongside the outcome, stamped with the thresholds version that
produced it, is what makes the whole phase interpretable. Without it you have
analytics; with it you have a scoreboard for your own scorer.

## Gate

1. Analytics for a published clip land within 48 h, automatically.
2. Recalibration **refuses** below the sample floor and states the shortfall.
3. A calibration run is reproducible: same stored pulls in, same weights out.
4. The exploration slice is genuinely published and labelled — count it.
5. Retention drives edit weights and views provably do not. Asserted in a test,
   because this is the property that silently rots.
6. A correlation report is readable by a human: per sub-score, per disqualifier,
   with sample counts beside every coefficient.
7. Clips from before and after a Block A phase are comparable on relative
   retention — the "did it work" query returns an answer.
8. Analytics ingest is idempotent per clip per day; a re-run overwrites rather
   than appends.

## Tests

`analytics.test.ts` — fake client, fake clock:
- day-1/3/7/28 schedule fires once per window; a missed window catches up rather
  than skipping
- idempotent per clip per day
- a 403 quota error defers rather than losing the pull
- retention arrays of unexpected length degrade instead of corrupting the row

`calibration.test.ts` — pure, synthetic outcomes:
- below floor → refuses, and the message names the shortfall
- a sub-score with a planted strong correlation gains weight; a random one
  doesn't
- views are excluded from the edit-weight fit — assert the feature set directly
- weights are bounded; no single sub-score can reach a degenerate weight from
  one lucky clip

## Risks

| Risk | Mitigation |
|---|---|
| **Learning from too few samples** | Hard floor that refuses and says so; the phase's core property |
| Feedback loop narrows output to one safe format | Exploration slice; bounded weights; human override retained |
| Attributing view count to edit quality | Explicit signal/consumer table; asserted in a test |
| Analytics quota misunderstood | Separate quota confirmed in Cloud Console, tracked as its own ledger dimension |
| Retention report can't batch | Schedule is spread by design, not bursty |
| Correlation read as causation | Report shows sample counts next to every coefficient; small-N rows stay visibly small-N |
| `[revisit]` No data on build day | Build ingest first; calibration stays dormant and refuses until the floor is met |

## Research

- `relativeRetentionPerformance` (0–1, normalized against videos of similar
  length), `audienceWatchRatio`, and the `elapsedVideoTimeRatio` dimension
  returning ~100 points per video; the single-video-filter constraint on the
  retention report; `yt-analytics.readonly` scope:
  [Google — YouTube Analytics channel reports](https://developers.google.com/youtube/analytics/channel_reports),
  [Google — Metrics](https://developers.google.com/youtube/analytics/metrics),
  [Google — Dimensions](https://developers.google.com/youtube/analytics/dimensions)
- The Analytics & Reporting API operates under a quota separate from the Data
  API v3's 10,000 units/day — the basis for the phase-18 correction above:
  [OutlierKit — YouTube API quota explained](https://outlierkit.com/resources/youtube-api-quota/)
