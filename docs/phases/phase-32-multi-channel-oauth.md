# Phase 32 — Multi-channel YouTube OAuth

**Goal:** link any number of YouTube channels from the web UI via a real Google
consent flow, each with its own isolated, independently-refreshable token —
ready for phase 33's upload queue to publish against.

## Why now

Pulled forward from phase 26 ("one client, N refresh tokens") at explicit
request, ahead of its normal place in the queue. Phase 33's upload-queue UI
needs a channel to upload *to* before any of its drag-and-drop/scheduling work
means anything, so the OAuth linking system is the correct first slice to
build in isolation and get right.

This is deliberately **only** identity + token acquisition. No upload path is
touched. `server/youtube/uploader.ts`'s existing single-channel
`YOUTUBE_REFRESH_TOKEN`-from-`.env` flow is untouched — phase 33 rewires
uploads onto the channel store this phase builds.

## Scope

The OAuth authorization-code web flow, per-channel token storage, and a
minimal "Channels" page: list linked channels, add one, remove one.

## Out of scope

- Uploading anything (phase 33).
- The upload queue, clip selection, drag-drop reorder, release scheduling
  (phase 33 — see that doc).
- Rights posture / `assertPublishable` gate (phase 14 — still unbuilt, and a
  hard prerequisite before phase 33 touches `videos.insert`; noted again there).
- Quota ledger (phase 18), routing rules (phase 26 remainder), multi-tenant /
  other people's channels (phase 23).

## Research (via context7, `/websites/developers_google_youtube_v3`)

- **`publishAt` requires `privacyStatus: "private"`.** It cannot be set on an
  `unlisted` video, and only before a video has ever been published. This
  changes phase 33's design — see that doc's Changes section.
- **Upload quota is a separate bucket**, not the shared 10,000/day: 1 unit per
  `videos.insert` call, capped at 100 calls/day, confirming phase 15's note.
  Confirm in Cloud Console whether that 100 is per-project (shared across every
  linked channel) or per-channel before scaling — the public docs don't say,
  and phase 26 flagged the same gap.
- **Unverified API projects force every upload to `private`,
  regardless of the requested `privacyStatus`**, until the project passes
  YouTube's audit. This can silently defeat "public" or scheduled release
  entirely. Verify your Cloud Console project's publishing/verification status
  before phase 33 is relied on for real releases — one test upload that comes
  out `public` as requested is the confirmation.
- OAuth: standard web-server authorization-code flow.
  `access_type=offline&prompt=consent` on every consent screen visit, so a
  refresh token is issued even for a Google account that has authorized this
  app before (Google otherwise only issues one on first consent).

## Changes

### `server/youtube/channels.ts` (new)

Two files per channel, split so a leak of one never leaks the other:

```
storage/channels.json                          # metadata only, no secrets — id, ytChannelId,
                                                 # title, thumbnailUrl, customUrl, addedAt
storage/.credentials/<ytChannelId>.json         # chmod 600 — { refreshToken, accessToken?, expiresAt? }
```

```ts
export interface ChannelMeta { id: string; ytChannelId: string; title: string; thumbnailUrl: string; customUrl?: string; addedAt: number; }
export function listChannels(): ChannelMeta[];
export function saveChannel(meta: ChannelMeta, refreshToken: string): void;
export function removeChannel(ytChannelId: string): void;
export async function getAccessToken(ytChannelId: string): Promise<string>; // refreshes + caches
```

Mirrors phase 26's exact contract: token path derived from the channel id,
never a global accessor, `chmod 600`/dir `chmod 700`, both paths already
covered by `storage/`'s existing `.gitignore`.

### `server/youtube/oauth.ts` (new)

Pure functions, no route handling: `buildAuthUrl`, `exchangeCode`,
`refreshAccessToken` (same refresh call `uploader.ts` already makes — not
duplicated, imported from here once phase 33 rewires it),
`fetchOwnChannel(accessToken)` → `GET youtube/v3/channels?part=snippet&mine=true`.

Scopes: `youtube.upload` (already used) **+ `youtube.readonly`** (new — needed
to read the channel's own snippet/thumbnail at link time). Both are
account-scoped to the authorizing channel, not a wider grant.

### `server/youtube/routes.ts` (new), mounted at `/api/channels`

| Route | What |
|---|---|
| `GET /api/channels` | list linked channels (metadata only) |
| `GET /api/channels/connect` | 302 to Google's consent screen. Short-lived random `state` (in-memory `Map`, 5 min TTL) as CSRF guard — proportionate for a single-operator localhost tool, not a token vault |
| `GET /api/channels/callback` | validates `state`, exchanges `code`, fetches channel identity, persists, redirects to `/channels?added=<id>` or `?error=...` |
| `DELETE /api/channels/:id` | removes metadata + token file |

Missing `YOUTUBE_CLIENT_ID`/`SECRET` → `/connect` returns the same
instructions-shaped error `uploader.ts` already returns for the same case,
not a stack trace.

### `.env.example`

```
YOUTUBE_REDIRECT_URI=http://localhost:5177/api/channels/callback
```

Documented as a **required manual step**: register this exact URI in Cloud
Console → APIs & Services → Credentials → the existing OAuth client →
Authorized redirect URIs. Defaults to `http://localhost:${PORT}/api/channels/callback`
when unset.

### Web — `web/src/pages/channels-page.tsx` (new)

Minimalist list (per the house style — one accent, no cards-for-cards'-sake):
thumbnail, title, handle, "Connected \<date\>", a remove action. Empty state:
one line + the add action, no illustration. "Add channel" is a plain link to
`/api/channels/connect` (full navigation — a popup adds a blocker failure mode
for zero benefit here). Sidebar gains a "Channels" entry; `App.tsx` gains the
`/channels` route.

## Contracts

`storage/channels.json`:

```jsonc
[{ "id": "UC_x5XG1OV2P6uZZ5FSM9Ttw", "ytChannelId": "UC_x5XG1OV2P6uZZ5FSM9Ttw",
   "title": "My Channel", "thumbnailUrl": "https://...", "addedAt": 1754000000000 }]
```

## Gate

1. `GET /api/channels/connect` redirects to a well-formed Google consent URL
   containing the configured client id and the registered redirect URI.
2. A completed consent flow ends with the channel's id/title/thumbnail
   persisted to `channels.json` and its refresh token written to
   `.credentials/<id>.json` at `0600`.
3. Two linked channels are listed independently; removing one never touches
   the other's token file (isolation, asserted — not just observed).
4. Missing OAuth env vars produce a readable setup error, not a crash.
5. `state` mismatch on callback is rejected, not silently accepted.

## Tests

`channels.test.ts` — no network:
- `saveChannel`/`listChannels`/`removeChannel` round-trip, metadata file never
  contains a token
- `removeChannel` on one id leaves every other channel's token file untouched
- `buildAuthUrl` includes `access_type=offline`, `prompt=consent`, and both
  required scopes

## Risks

| Risk | Mitigation |
|---|---|
| Redirect URI not registered in Cloud Console | Documented as a required one-time step; Google's own error (`redirect_uri_mismatch`) is unambiguous when missed |
| CSRF on the callback | short-lived `state`, checked before any token exchange |
| Unaudited project forces uploads private | Flagged here and in phase 33; verify with one real test upload before relying on scheduled/public release |
| Wrong Google account linked (personal vs. brand account) | UI copy tells the user to pick the right "Continue as" identity in Google's account chooser |
