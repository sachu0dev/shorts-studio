# Phase 33 — Upload queue, drag-drop ordering, and scheduled release

**Status: built**, same session as this doc, immediately after phase 32
(channel linking) and phase 14 (rights posture — the hard blocker below was
closed first, not worked around). Gates 3/4/5 pass by test; gates 1/2 — a real
staggered release actually going public on YouTube on schedule — need a linked
channel and real uploaded clips to exercise, which this session didn't have.

## Goal

From a finished job: tick the clips you want, pick a channel, order them,
choose how they go out — all at once or staggered over time — see exactly
when each one goes live, adjust any of it, and hit upload once.

## Why this shape

The plan (`phase-15-youtube-upload.md`) scoped one clip, one channel, one
manual click. This is genuinely bigger: N clips, 1 of several channels, an
explicit order, and a release schedule computed and previewed before anything
uploads. It reuses phase 15/26's upload mechanics (resumable `videos.insert`,
thumbnail set, retry/idempotency) and adds the batching, ordering, and
scheduling layer on top.

## Hard blocker: phase 14 is not built yet

`server/rights.ts` and `Job.rights`/`ClipPlan.rights` do not exist. CLAUDE.md
rule 6 and phase 14's own doc are explicit: the third-party gate is
**structural**, lives as the first line of the publish adapter, and must
exist *before* `videos.insert` is reachable from any code path — not added
after upload already works. **Build phase 14 (small — a type, a function, one
test file) immediately before wiring this phase's "Upload" button to a real
network call.** Nothing here should be built in a way that makes that gate
easy to skip later.

## Scope

- Clip multi-select on the job page.
- An "Upload queue" dialog: one row per selected clip, drag-to-reorder,
  channel picker, release-strategy controls, a computed timeline preview with
  per-item time editing, and the upload trigger.
- A persisted queue artifact so progress survives a page refresh or a server
  restart mid-upload (same idempotency rule every other stage already follows).
- Wiring `videos.insert` + `thumbnails.set` per queued item, through whichever
  channel's token (phase 32) was chosen.

## Out of scope

- Routing a clip to a channel automatically (phase 26's `routeClip` — this
  phase is manual channel choice only).
- Quota ledger / cross-channel budget (phase 18).
- Analytics, PubSubHubbub, other platforms.

## Release strategy — the actual mechanism

Research (phase 32 doc) settled this: YouTube's native `status.publishAt`
**only works from `privacyStatus: "private"`**, not `"unlisted"`, and it
auto-flips the video to public at the exact scheduled instant — no server
polling required, and it still fires if this machine is off. That is strictly
better than the alternative (upload `unlisted`, run our own cron to flip
`privacyStatus` later): more robust, less code, and the pre-release video is
actually private rather than reachable by anyone with the unlisted link.

**This changes the wording of what was asked for**, worth confirming before
building: the pre-release state is **private**, not **unlisted**. Three modes
in the dialog:

| Mode | `privacyStatus` sent | `publishAt` sent | Behavior |
|---|---|---|---|
| Upload all — Public now | `public` | — | live immediately |
| Upload all — Unlisted | `unlisted` | — | reachable by link only, never auto-changes |
| Release strategy | `private` | computed per item | uploads now, YouTube flips each to `public` at its own instant |

Release-strategy inputs: first-release date/time, and a gap (e.g. every 6h /
12h / 24h / custom). The dialog computes `publishAt` for every item as
`first + index * gap`, in upload-order, and renders a timeline (item →
scheduled local time). Any computed time is directly editable — editing one
does not recompute the others, so a deliberately uneven schedule is possible.

## Changes

### `server/uploadQueue.ts` (new)

```ts
export interface QueueItem {
  clipId: string;
  order: number;
  channelId: string;
  privacyStatus: "public" | "unlisted" | "private";
  publishAt?: string;         // ISO 8601, only when privacyStatus === "private"
  status: "pending" | "uploading" | "uploaded" | "scheduled" | "failed";
  videoId?: string;
  error?: string;
}
export interface UploadQueue { schemaVersion: number; jobId: string; items: QueueItem[]; createdAt: number; }
```

Persisted at `storage/<jobId>/uploadQueue.json`, written through the existing
`LocalStore` (`server/artifacts.ts`) — same atomic-write guarantee every other
artifact gets, not a new I/O pattern.

### `server/youtube/publish.ts` (new) — the phase-15 adapter, generalized

```ts
export async function publish(job: Job, item: QueueItem, clip: Output): Promise<void> {
  assertPublishable(job);   // phase 14 — first line, before any network call
  const accessToken = await getAccessToken(item.channelId);   // phase 32
  // videos.insert (resumable) with status.privacyStatus/publishAt, then thumbnails.set
  // item.status/videoId written to uploadQueue.json BEFORE the function returns,
  // so a crash after a successful upload can never retry into a duplicate.
}
```

One item at a time, sequential — concurrent resumable uploads against one
channel's quota is not worth the complexity at this volume (mirrors phase 15's
own reasoning).

### Routes

- `POST /api/jobs/:id/upload-queue` — body: ordered clip ids + channel + mode
  + schedule inputs. Computes `publishAt`s, writes the artifact, returns it.
- `PATCH /api/jobs/:id/upload-queue` — edits (reorder, per-item time, channel).
- `POST /api/jobs/:id/upload-queue/start` — runs `publish()` per item in
  order, streaming progress on the existing SSE channel `progress()` already
  uses.

### Web

- Job page: checkbox per rendered clip, "Add to upload queue (N)" action.
- `web/src/components/upload-queue-dialog.tsx` (new): drag-to-reorder list
  (`@dnd-kit/core` + `@dnd-kit/sortable` — not yet a dependency, add it; it's
  the accessible, actively-maintained choice and the natural pair for
  shadcn/ui, see `ui-styling` skill's component guidance), channel select,
  mode selector (the three-row table above, presented as plain radio options
  — not three separate flows), schedule inputs when "Release strategy" is
  chosen, and a timeline list (clip → computed local time, each time directly
  editable inline). Final "Upload N clips" action.
- Minimalist per house style: no card-per-clip chrome, a plain ordered list
  with a drag handle; one accent color; the timeline reads as a list of times,
  not a chart, until real usage shows a chart earns its complexity.

## Contracts

See `QueueItem`/`UploadQueue` above; also extends `job.json`'s `published[]`
shape from phase 15's doc unchanged (append-only, written before response).

## Gate

1. Selecting clips → dialog → reorder → upload produces videos on the chosen
   channel in the selected order (order only matters for display here; upload
   order follows the list order but publish order is `publishAt`, which can
   differ from list order once times are hand-edited).
2. "Release strategy" items upload immediately as `private` with `publishAt`
   set; each becomes `public` on YouTube at its own scheduled time with no
   further action from this app.
3. Editing one computed time does not move any other item's time.
4. A `third-party` job's clips cannot enter the queue in an uploadable state —
   `assertPublishable` throws before any network call (phase 14 gate, proven
   by test, not observation).
5. Refreshing the page or restarting the server mid-upload shows accurate
   per-item status from `uploadQueue.json`, and does not re-upload an already-
   `uploaded`/`scheduled` item.
6. Removing a channel (phase 32) that a pending queue item still references is
   handled — the item shows a clear "channel disconnected" state, not a crash.

## Tests

`uploadQueue.test.ts` — no network:
- `publishAt` computation: first-time + index*gap, in list order
- editing one item's time leaves every other item's computed time untouched
- `assertPublishable` is called before any request for every item (fake
  client, zero calls recorded for a `third-party` job)
- an already-`uploaded` item is skipped on a second `start` call, not re-sent

## Risks

| Risk | Mitigation |
|---|---|
| Phase 14 gate skipped under time pressure | Called out as a hard blocker above; `publish()` is written with the call as its literal first line from the start |
| Unaudited Cloud project silently forces every upload private | Verified in phase 32; one real test upload before trusting scheduled release |
| Upload quota (100/day, bucket scope unconfirmed) exhausted mid-queue | Queue keeps items `pending` on a 403 quota error with a readable message, not a crash; resumes next day, same idempotency as everything else |
| Large batch = long-running sequential uploads | SSE progress per item; queue survives a restart (artifact-backed, not in-memory) |
| Drag-drop library adds a real dependency | `@dnd-kit` is small, accessible, no runtime CSS-in-JS; scoped to this one dialog component |
