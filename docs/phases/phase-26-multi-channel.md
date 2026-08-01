# Phase 26 — Multi-channel routing + publishing

**Goal:** one pipeline, several channels, each with its own identity, audience
and credentials — and a clip lands on the right one.

## Why now

Phase 15 publishes to *your channel*, singular: one refresh token in one file.
The plan here is one channel per vertical — Indian comedy, Indian gaming,
foreign gaming — because a feed algorithm rewards a channel that means one thing
and punishes one that means four.

That is correct strategy and it needs three things phase 15 doesn't have:
credentials per channel, a per-channel identity that reaches into caption and
voice decisions, and a routing rule that decides where a clip goes.

It comes after the quality gate (25) deliberately. Five channels multiply
whatever your output quality is — including by zero.

## Scope

The `channel` table, per-channel OAuth, the routing rule, and per-channel
publishing.

## Out of scope

Multi-*tenant* — other people's channels, encrypted vaults, consent screens.
That's phase 23. This is one operator with several channels, which is a
different and much smaller problem.

Scheduling and posting cadence. Worth having; not this phase.

## Read this before building it

The biggest risk in this phase is not technical.

YouTube renamed its "repetitious content" policy to **inauthentic content** in
July 2025, and the first of its three violation buckets is *generic or repetitive
content relying on templates with minimal variation across videos*. The
reused-content policy is unchanged and still permits clips, commentary and
compilations — clipping long-form is not the problem. **Running several channels
of templated automated output is exactly the described pattern.**

The mitigation is a product decision, not a code change, and it belongs in the
channel model rather than in a comment:

- Per-channel differentiation must be **real** — different framing conventions,
  different caption voice, different clip-length policy, ideally added
  commentary or context — not a font swap and a different hashtag set.
- A channel whose clips are indistinguishable from another channel's, except for
  the source, is the failure case. Phase 17's embeddings can measure this: embed
  each channel's published titles and hooks and check inter-channel similarity.
  If two channels' outputs cluster together, they are one channel wearing two
  names, and YouTube will eventually agree.

Make that a monitored number on the dashboard, not a hope.

## Changes

### `channel` table

```sql
CREATE TABLE channel (
  id            TEXT PRIMARY KEY,     -- local slug: 'in-comedy'
  ytChannelId   TEXT,                 -- UC… once authed
  label         TEXT NOT NULL,
  language      TEXT NOT NULL,        -- 'hi' | 'en' — matched against phase 2's detection
  niches        TEXT NOT NULL,        -- JSON: contentModes this channel accepts
  compositions  TEXT,                 -- JSON: compositionTypes it accepts, NULL = any
  profile       TEXT NOT NULL,        -- JSON: phase 21's structured profile, per channel
  tokenPath     TEXT NOT NULL,
  active        INTEGER DEFAULT 1
);
```

Phase 21's Creator Memory profile becomes **per channel**, not per install.
"What your channel sounds like" is a different sentence for the comedy channel
and the gaming channel, and a single shared profile would blur both toward the
mean — which is the inauthentic-content failure mode arriving by accident.

### OAuth: one client, N refresh tokens

One Google Cloud project and one OAuth client handles every channel. Per-channel
identity comes from the **refresh token**, not from the client — you run the
consent flow once per channel and store each resulting token separately.

Phase 15's single `chmod 600` file becomes a directory:

```
STORAGE_DIR/.credentials/<channelId>.json      # chmod 600, outside the repo
```

Still not `.env`, still not in git, still never logged. The isolation property
gets a test: publishing to channel A must never be able to read channel B's
token — which is trivially true if the path is derived from the channel row and
catastrophically false if any code path takes a token from a global.

### Routing: constraints are facts, choice is taste

This is phase 7's router pattern applied to distribution, and it should be built
the same way for the same reason (`CLAUDE.md` rule 3).

```ts
export function eligibleChannels(clip: ClipContext, channels: Channel[]): Channel[];
export async function routeClip(clip: ClipContext, eligible: Channel[]): Promise<Routed>;
```

**Hard constraints, measured — the LLM cannot override these:**

| Constraint | Source | Owner |
|---|---|---|
| `language` | phase 2 detection | measured |
| `compositionType` | phase 5 classifier | measured |
| rights posture | phase 14 / source row | measured |
| quality verdict | phase 25 | measured |

**Then the choice, from what survives:** `contentMode` (phase 12's LLM field)
picks among the eligible channels. A Hindi gaming clip is never offered to the
English comedy channel — that's a fact, not an opinion — but choosing between
two plausible gaming channels is taste.

Zero eligible channels is a normal outcome, not an error: the clip stays
unrouted and appears on the dashboard for a human. Do not invent a fallback
channel; a clip posted to a channel it doesn't fit is worse than a clip not
posted.

### Quota, corrected

All channels in one Google Cloud project **share the same 10,000 Data API
units/day.** The ledger's per-day budget does not multiply by channel count —
adding a fifth channel makes every other channel's discovery budget smaller.

Phase 18's ledger gains a `channelId` column so spend is attributable, and the
reserve floor becomes per-channel so one channel's Content Hunt run cannot
starve another's publishing. Attribution without a floor just tells you who
caused the outage.

Upload quota sits in its own bucket and is generous at this volume, but confirm
whether it is scoped per project or per channel in Cloud Console before relying
on it — the public documentation is not explicit and the answer changes how many
channels you can safely post to in a day.

## Contracts

```jsonc
{
  "clipId": "clip3",
  "routed": {
    "channelId": "in-gaming",
    "eligible": ["in-gaming", "global-gaming"],
    "rejected": [
      { "channelId": "in-comedy", "why": "contentMode 'gaming' not in niches" },
      { "channelId": "global-gaming", "why": "language 'hi' != 'en'" }
    ],
    "chosenBy": "llm",
    "at": 1753900000000
  }
}
```

`rejected[]` with reasons is the field that makes routing debuggable. When a clip
lands somewhere surprising, "why not the others" is the question you actually
have.

## Gate

1. Two channels authorize independently; each publishes to itself; neither can
   read the other's token.
2. A Hindi clip is not eligible for an English-only channel — asserted, not
   observed.
3. Zero eligible channels leaves the clip unrouted and visible, never
   auto-posted to a default.
4. The LLM cannot select an ineligible channel even when instructed to; the
   constraint filter runs first and the choice is made from its output.
5. Ledger spend is attributable per channel, and the per-channel reserve floor
   blocks one channel from consuming another's budget.
6. A clip failing phase 25 (`archive`) cannot be routed at all.
7. Phase 14's rights gate still holds per channel — it is still the publish
   adapter's first line.
8. Inter-channel output similarity is computed and visible. Two channels whose
   published hooks cluster above threshold raise a warning.

Gate 8 is the one that protects the business rather than the code.

## Tests

`routing.test.ts` — pure, fixture channels:
- language and composition constraints exclude correctly
- an LLM response naming an ineligible channel is discarded and re-chosen from
  the eligible set (the same defensive shape as `sanitizePlan`)
- empty eligible set returns unrouted, never throws, never defaults
- `rejected[]` carries a reason for every excluded channel

`credentials.test.ts`:
- token path is derived from the channel row; no global token accessor exists
  (grep-able invariant, asserted)
- publishing to A with B's channel id selected fails closed

## Risks

| Risk | Mitigation |
|---|---|
| **Inauthentic-content policy across several templated channels** | Real per-channel differentiation encoded in the profile; inter-channel similarity monitored and gated |
| One project's quota shared across channels | `channelId` on the ledger + per-channel reserve floor |
| Token for the wrong channel used | Path derived from the row; isolation test; no global accessor |
| Channel sprawl outrunning content supply | A channel with no publishable clips for N days is flagged inactive rather than starved silently |
| Routing feels arbitrary | `rejected[]` reasons stored and shown |
| Upload quota scope unverified | Confirm per-project vs per-channel in Cloud Console before scaling posting cadence |

## Research

- One Cloud project and one OAuth client can serve many channels; per-channel
  identity is the refresh token, obtained by running consent once per channel:
  [Google — OAuth 2.0 for web server applications](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
- Inauthentic content policy, the July 2025 rename, and the three violation
  buckets — including templated/minimal-variation output; reused content
  (clips, commentary, compilations) explicitly unchanged:
  [Social Media Today — YouTube clarifies monetization update](https://www.socialmediatoday.com/news/youtube-clarifies-monetization-update-inauthentic-repeated-content/752892/),
  [YouTube — channel monetization policies](https://support.google.com/youtube/answer/1311392?hl=en)
