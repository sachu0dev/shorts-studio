# Phase 14 — Rights posture tagging

> **Removed.** This phase was built and passed its gates, then fully reverted
> at explicit user request — every job can auto-publish now, no
> owned/licensed/third-party distinction anywhere in the app. Kept here as a
> historical record; nothing on this page describes current behavior.

**Goal:** every job carries an explicit rights posture, and `third-party` content
is structurally incapable of auto-publishing.

## Why now

**Decision 6: you're clipping a mix of your own and other people's videos.** That
makes this a prerequisite for phase 15, not a footnote to it. Building upload
first and adding the gate afterwards means the gate is a policy you can forget,
rather than a wall the code enforces.

Clipping someone else's video and uploading it to your own channel is a copyright
question, not a technical one, and fair-use analysis is fact-specific. The design
answer is to make the distinction **structural rather than a judgment call at
2am** — the product should make you decide once, at ingest, in the open.

## Scope

The posture field, the UI that forces you to declare it, and the adapter-level
gate. No upload yet.

## Out of scope

OAuth and `videos.insert` — phase 15. Content Hunt's harvest-time tagging —
phase 19 reuses this same field.

## Changes

### `server/rights.ts` (new)

```ts
export type RightsPosture = "owned" | "licensed" | "third-party";

export function canAutoPublish(p: RightsPosture): boolean {
  return p === "owned" || p === "licensed";
}

export function assertPublishable(job: Job): void;  // throws on third-party
```

| Posture | Meaning | Auto-publish |
|---|---|---|
| `owned` | your own channels | **yes** |
| `licensed` | explicit permission, CC licence, partner agreement | **yes** |
| `third-party` | everything else | **never** — draft + explicit human action |

### Default to `third-party`

An unset posture is `third-party`, not `owned`. The safe default must be the one
that blocks, so a bug or a forgotten field fails closed. Never infer posture from
the URL or channel id — inference here is exactly the kind of confident guess
that gets a channel struck.

### Read YouTube's CC flag

Video metadata exposes a Creative Commons licence flag. Where the source is
CC-licensed, surface it as a **suggestion** — pre-select `licensed` with a
visible note — but keep it a human confirmation. The API says what the uploader
claimed; it doesn't make the call for you.

### UI — `public/index.html`

A required posture selector next to the URL field. **No default selected**, so
submitting without choosing is rejected by `POST /api/jobs` with a clear message.
Forcing the choice at ingest is the whole point; a pre-filled dropdown gets
clicked past.

`third-party` shows an inline warning that the clip will produce a draft and
cannot auto-publish.

### `server/jobs.ts`

`Job` and `ClipPlan` gain `rights: RightsPosture`. It is written at job creation
and **immutable thereafter** — the posture cannot be upgraded by a later stage,
by the LLM, or by an API call. Changing it means creating a new job.

### The gate itself

`assertPublishable` lives in `rights.ts` and is called **inside the publish
adapter** in phase 15 — not in the route handler, not in the UI. Both of those
are bypassable; the adapter is the last thing before the network call.

Both layers exist (UI warns, adapter enforces), but only the adapter is load-bearing.

## Contracts

`job.json`:

```jsonc
{
  "rights": {
    "posture": "third-party",
    "declaredAt": 1753900000000,
    "declaredBy": "user",
    "ccFlagFromApi": false,
    "note": "podcast clip, credit in description"
  }
}
```

Outputs from a `third-party` job are marked in `job.json` as `draft: true`, and
the UI labels them. The clip renders in full — analysis and drafting are fine,
publishing is what's gated.

## Gate

1. A job created without a posture is **rejected** at `POST /api/jobs`.
2. `assertPublishable` throws for `third-party` — proven by a test, not by
   reading the code.
3. Posture cannot be mutated after creation. Attempting it via the API fails.
4. A `third-party` job renders normally and is labelled `draft` in the UI.
5. A missing/corrupt posture in `job.json` is treated as `third-party`
   (fail closed), not as an error and not as `owned`.
6. CC-flagged sources pre-select `licensed` but still require confirmation.

## Tests

`rights.test.ts` — small, and worth more than its size:
- `canAutoPublish` for all three values
- `assertPublishable` throws on `third-party`, passes on the other two
- unset/unknown/garbage posture → treated as `third-party`
- posture is immutable after job creation
- job creation without a posture is rejected

## Risks

| Risk | Mitigation |
|---|---|
| Gate placed in the route handler and bypassed by another call path | It lives in the adapter, the last thing before the network |
| Default changed to `owned` later "for convenience" | The fail-closed test makes that change break CI loudly |
| CC flag treated as permission | Suggestion only; always human-confirmed |
| Friction leads to habitually selecting `owned` | That's your call to make knowingly — which is exactly the point of declaring it |

## Note

Automated YouTube uploads must comply with YouTube's Terms of Service, and quota
increase requests are approved partly on demonstrated ToS compliance — so a clean
rights model directly helps you scale quota later. If this ever becomes a
product, "we prevent our users from committing copyright infringement by default"
is a much better position than the alternative, and it's the kind of thing that
gets asked about in procurement.
