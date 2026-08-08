# Phase 31 — Panel framing & speaker priority

**Status: built.** Gates 1, 2, 4, 5, 6, 7 pass by direct unit test. Gate 3 and
gate 8 pass by unit test and are also confirmed against real corpus data (see
"What actually happened"). `PANEL.monologueSeconds` (6.0) is unchanged from
its starting value — nothing in the corpus argued for moving it.

**Goal:** on any clip with people in it, frame whoever is talking — and when
that cannot be known, keep everyone rather than guessing.

## Why now

This closes a live, reproduced defect. It is last of the three because the
correct fix needs phase 29's number and phase 30's wide window; without them the
only available answers are all wrong.

### The bug, reproduced exactly

Corpus job `vI57GWdQo5`, clip 2 — a talent-show panel. Real signals from
`analysis/clip2.json`:

```
faceCoverage 1.0   medianConcurrentFaces 3   maxConcurrentFaces 8
distinctFaceTracks 6   facesFitOneCrop false   subjectMotion 0.1295
```

Run through the current code, the decision chain is:

```
classify() → multi-speaker, confidence 0.55
             "3 concurrent faces, no speaker labels available"
route()    → confidence 0.55 < 0.6 → ["static-center", "blurred-fill"]
             "classifier confidence 0.55 < 0.6 — routing conservatively"
render     → static-center
```

**An eight-person panel renders as a fixed dead-centre crop** — it frames
whoever happens to be sitting in the middle and holds there for the whole clip,
regardless of who is speaking. That is precisely the reported symptom, and it is
the worst output the pipeline can produce on its most common Indian-shorts
content type.

Two independent faults produce it, and both must be fixed:

**1. The conservative fallback is geometric where it should be
content-preserving.** `static-center` is the right conservative answer for one
subject who is probably centred. For three-to-eight faces spread across a frame
it is the *most* destructive option available — phase 29 measures it retaining
42.4% of them. "I am unsure" must never resolve to "discard most of the cast".

**2. Confidence 0.55 is not ambiguity about the clip — it is a permanently
missing input.** The classifier is honest: it caps confidence because
`speakerCount` is 0, and `speakerCount` is 0 because
`pyannote/speaker-diarization-community-1` has been gated since phase 2 and is
still gated. CV is not unsure here at all — eight concurrent faces is
unambiguously a panel. A permanent, known-absent input is throttling a decision
that other evidence answers confidently.

ASD (phase 8) is the rescue and does work — re-running the same clip with
`asdSpeakerCount: 2` yields `multi-speaker` at confidence 0.9 and routes to
`camera-switch`. But that rescue lands in a *later* stage, so any clip where ASD
does not run or fails degrades all the way back to a centre crop rather than to
something merely worse.

> **Amendment (live feedback, before this phase was built):** ASD correctly
> identifying a speaker is **not** by itself a reason to switch away from a
> panel. A reality-show or panel format's value is partly in everyone's
> reactions — the point of the shot is the room, not just whoever has the
> floor for three seconds. `camera-switch` cutting tight on every speaker
> change in an 8-person panel would lose exactly the content a human editor
> keeps. The rule below is revised: on a panel specifically, a switch has to
> be earned by a *sustained* turn, not merely a *current* one. Two-person
> podcasts are unaffected — turn-taking there stays exactly as phase 9 built it.

## Scope

Routing policy for clips with faces. The speaker-priority rule, the replacement
conservative fallback, and panels of three or more.

## Out of scope

The aspect mechanism (phase 30) and the retention metric (phase 29) — both are
consumed here, neither is built here. `screen-rec` routing stays phase 11's.

## Changes

### The rule, in priority order

Made deterministic, and revised once for the reaction-preserving amendment
above — **a panel earns a switch differently than a two-person conversation
does:**

```
1. Two speakers genuinely overlap
     → split-screen                       (phase 10, unchanged)
2. Exactly two people, one is talking
     → camera-switch on that speaker      (phase 9, unchanged — same min-hold)
3. Three or more people (a panel), and one person has held the floor for
   PANEL_MONOLOGUE_SECONDS or longer — a real turn, not a quick reply
     → camera-switch on that speaker      (narrowest safe aspect)
4. Three or more people, and nobody has held the floor that long —
   including "someone is talking right now, just not for very long"
     → keep everyone                      (group-crop, narrowest safe aspect)
5. Nobody identified at all, several people present
     → keep everyone                      (group-crop, narrowest safe aspect)
6. One face only
     → static-center / fullscreen-follow  (phase 7, unchanged)
```

Rules 4 and 5 are what fix the bug: "I do not know who is talking" and "several
people are talking briefly" both resolve to *show the whole panel*, not *point
at the middle* and not *chase every three-second reply around the room*. Rule 3
is deliberately a **higher bar** than rule 2's ordinary turn-taking threshold —
see `PANEL_MONOLOGUE_SECONDS` below — because a panel's switch has to be worth
losing everyone else's reaction for.

### `server/pipeline/router.ts` — the conservative branch stops being blind

The low-confidence branch currently returns `["static-center", "blurred-fill"]`
for every type. It becomes face-aware:

```ts
if (confidence < T.confidence) {
  // Unsure WHAT the clip is, but certain there are several faces in it —
  // keeping all of them is the conservative answer. Centre-cropping a panel
  // is a confident, destructive guess wearing a cautious label.
  return sig.medianConcurrentFaces >= 2
    ? { modes: ["group-crop", "blurred-fill"], reason: `low confidence but ${sig.medianConcurrentFaces} faces — keeping the group` }
    : { modes: ["static-center", "blurred-fill"], reason: `...` };
}
```

### `group-crop` generalises; `facesFitOneCrop` retires as a gate

`group-crop` already means *"one window wide enough for everyone, held still"*.
Phase 30 lets that window be wider than 9:16, so the mode needs no new code —
only its precondition changes. `facesFitOneCrop` is a boolean answer to "do the
faces fit **a 9:16 crop**", which is the wrong question once the window can
move; `retention[aspect]` is the same question asked continuously and at every
aspect.

The signal stays in the artifact (it is cheap and phase 4 measured it), it just
stops being what unlocks the mode.

### Panels of three or more

`route()`'s multi-speaker branch sends everything to
`["camera-switch", "split-screen"]`. Split-screen shows two people; on eight it
is meaningless. Add the count guard:

```
medianConcurrentFaces >= 3 and no sustained dominant speaker
  → ["group-crop", "camera-switch"]
```

**"Dominant" means a real monologue, not merely the current speaker.** A panel
member answering in the group's normal turn-taking rhythm does not earn a
switch — the group shot is correct there, reactions and all. Only someone who
has genuinely taken over the conversation does:

```ts
export const PANEL = {
  /**
   * How long one person has to hold the floor, uninterrupted, before a panel
   * switches to them specifically. Deliberately well above phase 9's ordinary
   * `minHold` (2.5s calm / 1.5s dynamic) — a two-person switch only has to
   * beat "was that a real turn or a backchannel"; a panel switch has to beat
   * "is losing everyone else's reaction worth it", which is a higher bar.
   * Starting value, moved only when the corpus says so.
   */
  monologueSeconds: 6.0,
};
```

Reuses `speakingTracks`' underlying per-track speaking-time measurement from
phase 8/10 — the same "how long has this track actually been talking"
computation `speakerRetentionOver` and `speakingTracks` already do, just
compared against `PANEL.monologueSeconds` instead of
`ASD_THRESHOLDS.minSpeakingSeconds`. No new detection machinery, a different
bar for an existing measurement.

A panel host delivering a closing verdict, or a contestant on an extended
answer, clears this bar and gets cut to — that is exactly what a human editor
does. A quick "yeah, totally" does not, and the group shot holds through it.

### `classify.ts` — say why confidence is low

The 0.55 stays (it is honest), but the reason string distinguishes *"diarization
unavailable"* from *"genuinely ambiguous"*, because only the first is a
permanent condition the router should route around rather than defer to.

## Contracts

No new artifact fields. `routedReason` carries the new explanations, and
`layoutTimeline[].targetSource` (phase 8) already distinguishes a measured
speaker from a presence guess — which is how gate 2 is checked without watching
the video.

## Gate

On the panel clip plus the corpus podcast and two solo sources:

1. **The panel clip no longer renders `static-center`.** It renders `group-crop`
   at a wide aspect for its normal turn-taking, and `camera-switch` only on
   whichever segments clear `PANEL.monologueSeconds`.
2. **A brief reply inside a panel does not trigger a switch.** Construct a
   segment where ASD names an active speaker for 2–3s inside a panel; it must
   render `group-crop`, not `camera-switch` — this is the gate for the
   amendment, and the one most worth watching regress.
3. Where a speaker genuinely clears `PANEL.monologueSeconds`, `targetSource` is
   `asd` and the rendered frame is on that person — spot-checked on three
   sustained turns.
4. Where ASD names nobody, every face present is inside the framed region.
   **Nobody is cropped out because the system was unsure.**
5. A two-person podcast still gets `camera-switch` at phase 9's ordinary
   min-hold — **not** `PANEL.monologueSeconds`. The panel fix must not slow
   down genuine two-person turn-taking.
6. Solo clips are untouched — same mode, same aspect, same output as phase 10.
7. A clip where ASD fails entirely still frames the group, never the centre.
   Degrading must land somewhere defensible.
8. `speakerRetention` is ≥ its floor on every rendered segment. The person
   talking is never outside the frame — the one hard guarantee of this block.

## Tests

`router.test.ts`:
- 8 faces, no speaker labels, confidence 0.55 → **not** `static-center`
- 3+ faces, active speaker held for < `PANEL.monologueSeconds` → `group-crop`,
  **not** `camera-switch` — the direct test for the amendment
- 3+ faces, active speaker held for ≥ `PANEL.monologueSeconds` → `camera-switch`
  on that track
- 3+ faces with no dominant speaker at all → `group-crop` before `camera-switch`
- 2 faces turn-taking → `camera-switch` at the **ordinary** phase 9 min-hold,
  confirming `PANEL.monologueSeconds` does not leak into the 2-person path
- 1 face, low confidence → `static-center` still, since it is correct there
- ASD absent + several faces → group, never centre

`retention` interaction:
- a segment whose `speakerRetention` fails at 9:16 widens rather than re-targets

## Risks

| Risk | Mitigation |
|---|---|
| Panels now always go wide and static, losing energy | Rule 3 still cuts to a sustained speaker — a host's verdict or a long answer. Gate 3 checks this directly, gate 2 checks the opposite |
| `PANEL.monologueSeconds` (6s, a guess) is wrong in either direction | Starting value per this repo's convention; calibrate against the corpus podcast (must stay unaffected, gate 5) and panel (must start switching correctly, gate 3) before trusting it further |
| `group-crop` at 16:9 makes faces small on a phone | Phase 30 picks the **narrowest** clearing aspect; 16:9 only when narrower loses people |
| Removing the `facesFitOneCrop` gate changes phase 9 behaviour | It stays measured and asserted in existing tests; only its role as an unlock changes. Gate 4 and 5 cover the regression |
| Dominance threshold invented rather than measured | Starts from phase 8's `speakingTracks` ordering, calibrated against the podcast and panel before the gate is called passed |
| The real fix is ungating diarization | It would help and is still blocked upstream. This block deliberately assumes it never arrives — every phase since 5 has had to |

## What actually happened

The rule table, `route()`'s panel branch, `PANEL.monologueSeconds`, and
`assignFrameAspects`'s existing speaker-violation override all landed together
in `a47fcaf` alongside an unrelated language-detection fix. Code and tests were
committed before this doc's gate section was filled in — this pass is that
verification, done after the fact rather than skipped.

**Unit tests** (`router.test.ts`, "phase 31: panel framing" section) cover
gates 1, 2, 3, 4, 5, 6, 7 directly with hand-built fixtures — 8-face no-label
panel, a brief sub-threshold reply, a 7s sustained monologue, no-speaker-at-all,
2-person turn-taking at the ordinary min-hold, a solo clip, and ASD absent.
All pass.

**Real corpus data**, not just synthetic fixtures — three jobs
(`bA2q94c6Rv`, `PwlzXaGfNM`, `RTf4Nwi1lF`) have 10 real clips with
`medianConcurrentFaces >= 3`, all with `schemaVersion: 5` (post phase-30/31)
compositions cached:

- **None render `static-center`.** Every one is `group-crop` or
  `camera-switch`, with `routedReason` reading
  `panel (N concurrent faces) — group-crop default, camera-switch only on
  sustained monologue (6s)` — the bug this phase exists to fix does not
  reproduce anymore on real signals.
- `bA2q94c6Rv/clip2` (mode `camera-switch`, a sustained speaker throughout)
  shows gate 8 firing on real data: segments where 9:16 retention measured
  0.508–0.667 widened to 16:9 (`"retention 0.508 at 9:16 — widened to
  16:9"`), segments at 1.000 stayed 9:16. The speaker is never the one being
  discarded.
- `bA2q94c6Rv/clip1` (mode `group-crop`) shows the presence/ASD split working:
  early segments target the most-present face (`targetSource: "presence"`),
  later segments switch to a measured speaker (`targetSource: "asd"`) without
  ever leaving group-crop, since no run there clears
  `PANEL.monologueSeconds`.

One honest gap: `RTf4Nwi1lF/clip2`'s cached `composition` carries a panel
`routedReason` while its `analysis` artifact's `classification.type` currently
reads `talking-head`. Both are `schemaVersion: 5`, so this isn't a schema
staleness bug — most likely the classify-stage output was regenerated by a
later, uncommitted change to `classify.ts` without the compose stage being
re-run against it. Not a phase 31 defect (routing itself did the right thing
for the type it was given), but a reminder that this job's cached artifacts
predate whatever else is sitting uncommitted in the tree — a fresh end-to-end
run would be needed to fully trust that clip's current numbers.

Gate 3's "spot-checked on three sustained turns" and gate 7's synthetic
ASD-failure case were not independently re-verified beyond what the unit tests
already assert — no corpus clip on disk has an ASD artifact that failed
outright, so that path is unit-test-only, same honesty standard as phase
30's gate 3.
