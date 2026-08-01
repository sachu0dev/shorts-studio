# Phase 15 — YouTube OAuth + upload

**Goal:** link in → Short published on your channel. The end-to-end promise.

## Why now

Closes the loop the whole project was for, and needs nothing new — the planner
already produces title, description, hashtags and thumbnail. This is plumbing on
top of finished work, which is why it's short and why it comes right after
Block A rather than at the end.

## Scope

OAuth, `videos.insert`, thumbnail upload, and the publish adapter that enforces
phase 14's gate. Single user, own channel.

## Out of scope

Multi-tenant OAuth and a token vault — phase 23. Scheduling, analytics,
PubSubHubbub — Block C. Other platforms.

## Changes

### `server/publish/youtube.ts` (new)

Google OAuth 2.0 installed-app flow, one time, refresh token persisted:

- Scope: `https://www.googleapis.com/auth/youtube.upload`. Nothing wider — a
  broader scope is a bigger blast radius for a token on a laptop.
- Refresh token stored **outside the repo**, in `STORAGE_DIR/.credentials/`,
  `chmod 600`. Not in `.env`, which gets pasted into issues.
- `GET /api/youtube/auth` starts the flow, callback on localhost, one-time setup
  from the UI.

Resumable upload via `videos.insert`, since a 60 MB file over a laptop
connection will fail sometimes and restarting from zero is a bad experience.

```
snippet.title           plan.title           (≤100 chars — YouTube's limit, tighter than the prompt's 90)
snippet.description     plan.script + hashtags
snippet.tags            plan.hashtags        (strip '#', ≤500 chars total)
snippet.categoryId      from contentMode
status.privacyStatus    "private" by default — see below
status.selfDeclaredMadeForKids  false
```

Then `thumbnails.set` with the phase 13 best frame.

### Default to `private`

First uploads go up **private**, not public. You watch it on the channel, then
flip it. The cost of a bad automated public post is a strike or a channel
reputation hit; the cost of one extra click is nothing. Make `public` an explicit
per-job opt-in once you trust the output.

### The gate — where it actually lives

```ts
export async function publish(job: Job, clip: Output) {
  assertPublishable(job);      // ← first line. throws on third-party
  ...
}
```

**First line of the adapter**, before any network call. Not in the route, not in
the UI. `CLAUDE.md` rule 6: structural, not documented.

For `third-party` jobs the UI offers "Download + open YouTube Studio" instead —
you publish manually, with the draft metadata copied to clipboard. Useful, and
it never touches `videos.insert`.

### Quota

`videos.insert` costs ~1600 units against a **separate upload bucket** of roughly
100 uploads/day as of June 2026 — it no longer competes with read quota. At
single-user volume this is a non-issue, so **no ledger here**; phase 18 builds
one when Content Hunt starts spending read quota.

Handle the 403 quota error with a clear message and a retry-tomorrow, rather than
a stack trace.

### Retries

Network failures retry with backoff. Upload success is recorded in `job.json`
**before** anything else so a crash after upload cannot cause a duplicate — the
idempotency rule applied to the one operation with a real-world side effect.

### UI

Per-clip "Publish to YouTube" button, disabled with a tooltip for `third-party`.
Upload progress on the existing SSE stream. Published clips show the video id and
link.

## Contracts

`job.json` extended:

```jsonc
{
  "published": [
    { "clipId": "clip_2", "videoId": "dQw4w9WgXcQ",
      "privacyStatus": "private", "at": 1753900000000, "attempts": 1 }
  ]
}
```

## Gate

1. OAuth completes once; subsequent uploads use the refresh token with no
   re-auth.
2. An `owned` job uploads end to end — video, metadata, thumbnail all correct on
   the channel.
3. A `third-party` job **cannot** upload. Verified by a test asserting the
   adapter throws, and by the UI offering only the manual path.
4. A killed upload resumes rather than restarting.
5. Title/description/tags respect YouTube's limits — no silent truncation.
6. Uploads land `private` by default.
7. Refresh token is outside the repo, `chmod 600`, and not in git.

## Tests

`youtube.test.ts` — no network, injected fake client:
- `assertPublishable` is called before any request (fake client records calls;
  assert zero calls for `third-party`)
- title >100 chars is rejected or truncated deliberately, not silently
- tags are stripped of `#` and total ≤500 chars
- a 403 quota error produces a readable message
- `published[]` is written before the response is returned
- a second publish of an already-published clip is a no-op

That first test is the important one — it asserts *ordering*, which is the whole
security property.

## Risks

| Risk | Mitigation |
|---|---|
| Refresh token leaked via repo or logs | Outside the repo, `chmod 600`, never logged; `.gitignore` covers `storage/` already |
| Auto-publishing something bad | `private` by default; public is a deliberate opt-in |
| Duplicate uploads after a crash | `published[]` written first; second publish is a no-op |
| Rights gate bypassed by a future code path | It's the adapter's first line, with an ordering test |
| YouTube ToS on automated upload | Review ToS before automating; ToS compliance also factors into quota-increase approval |
| OAuth consent screen unverified for a personal project | Fine for your own channel in testing mode; revisit at phase 23 |
