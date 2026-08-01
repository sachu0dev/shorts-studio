# Phase 8 — Light-ASD active speaker detection

**Goal:** know which face on screen is speaking, per face, per moment.

## Why now

Master plan §1.2 calls this *"the single biggest quality unlock and the piece the
open-source clippers do not have."*

The gap it closes: diarization tells you *someone* labelled SPEAKER_01 is
talking. It cannot tell you **which rectangle on screen** that is. Reference
implementations paper over this with fixed left/right slot assignment, which
breaks the moment people move or the camera cuts. Light-ASD scores each detected
face directly for "is this face speaking right now", making the binding
**measured rather than assumed**.

Nothing in phases 9 or 10 can be correct without it.

> **Inherited from phase 7 — this phase may be what unblocks diarization, not
> the other way round.** Phase 5 returns `multi-speaker @ 0.55` whenever
> `speakerCount` is 0, and it is 0 on every real job because
> `pyannote/speaker-diarization-community-1` is gated. 0.55 is below phase 7's
> 0.6 confidence floor, so **every multi-speaker clip routes conservatively to
> `static-center`** and `group-crop`, `camera-switch` and `split-screen` are
> unreachable on real footage. Their fallback is covered by unit test only.
>
> The plan above assumes diarization exists and treats ASD as the thing that
> binds a speaker *label* to a face. But ASD answers "is this face speaking"
> **from video and audio directly — no pyannote, no gated repo**. Count the face
> tracks whose ASD score goes high at any point and you have a measured speaker
> count that owes nothing to diarization.
>
> So decide early in this phase: does `activeTrack` alone let phase 5 raise its
> confidence above 0.6? If yes, the HF gate stops blocking phases 9–10 and
> becomes a transcript-quality issue only. If no, the gate stays a hard
> prerequisite for three phases and that is worth knowing before building them.
>
> Either way the binding section below still needs diarized labels; what changes
> is whether the *routing* does. Add it to this phase's gate.

## Scope

ASD inference per face track, and speaker↔track binding.

## Out of scope

Using the binding to switch cameras — phase 9. This phase produces scores and a
binding; the renderer's behaviour is unchanged.

## Changes

### `worker/stages/asd.py` (new)

**Light-ASD / LR-ASD** (CVPR 2023): explicitly designed as a lightweight ASD
model, ~94% mAP on AVA validation versus TalkNet's ~90.8%, at far lower cost.
Both numbers matter here — the accuracy is why the binding works, the cost is why
it fits on a 4050.

Per face track, per sample window: crop the face, take the aligned audio window,
score. **Batch inference across the clip's face crops** rather than per-frame
calls (master plan §4.2) — this is the difference between seconds and minutes.

Runs on GPU as its own process invocation. By this point face detection is on
CPU and WhisperX has exited, so ASD has the card to itself. That is the whole
reason for process-per-stage.

### Speaker binding — `server/pipeline/binding.ts` (new)

```ts
export function bindSpeakersToTracks(
  asd: AsdScores, words: Word[]
): Record<string, { trackId: number; confidence: number }>
```

For each diarized speaker, find the face track whose ASD score correlates best
with that speaker's speaking intervals from `transcript.json`. Correlation over
the whole clip, not per-moment — a single sample is noise, but 30 seconds of
agreement is not.

Three cases that must not be papered over:

- **No track correlates above threshold** (speaker is off-camera). Return no
  binding. Phase 9 must then treat that speaker as unfollowable and hold the
  current frame rather than cutting to a wrong face.
- **Two speakers bind to the same track.** Diarization over-split one person.
  Log it, keep the stronger binding, and record it — this is a phase 2 quality
  signal, not something to silently resolve.
- **Track disappears mid-clip.** Binding is time-ranged, not global.

### Hysteresis

Master plan §3.2 rule 3: require the ASD score to exceed the switch threshold for
**N consecutive samples** before accepting a change of active speaker. Without it,
the score flickers at every turn boundary and phase 9 produces a seizure.

Implemented here, at the score level, so phase 9 consumes an already-stable
signal rather than re-deriving stability.

## Contracts

`analysis/<clipId>.json` extended:

```jsonc
{
  "asd": {
    "sampleStep": 0.25,
    "scores": { "1": [0.02, 0.91, 0.88], "2": [0.95, 0.11, 0.07] },
    "activeTrack": [2, 1, 1]
  },
  "speakers": {
    "SPEAKER_00": { "trackId": 2, "confidence": 0.94 },
    "SPEAKER_01": { "trackId": 1, "confidence": 0.89 },
    "SPEAKER_02": { "trackId": null, "confidence": 0.0, "reason": "off-camera" }
  }
}
```

`activeTrack` is the hysteresis-stabilised answer to "who is talking now" — it is
what phase 9 consumes. `scores` is the raw signal, kept for debugging.

## Gate

On the corpus podcast source:

1. Binding is **correct through a camera cut** — the same person keeps the same
   speaker label after the cut.
2. Binding is **correct when people move**, including swapping left/right
   positions. This is the case fixed-slot assignment gets wrong and is the point
   of the phase.
3. `activeTrack` does not flicker: no switch shorter than the hysteresis window.
4. A speaker who is genuinely off-camera binds to `null`, not to the nearest face.
5. ASD on 3 clips × 40 s adds **under ~90 s**, peak VRAM under 6 GB. Confirm from
   `job.json` that no other model was resident.
6. **`layoutTimeline[].target` is verified, not assumed.** Phase 7 ships it as
   "the most-present face track" with nothing checking that face is the one
   talking. On a two-person clip, assert the target follows the active speaker.
7. **Answer the diarization question above**: state in the phase doc whether
   `activeTrack` raises phase 5's multi-speaker confidence past 0.6 without
   pyannote. A yes unblocks phases 9 and 10 on real footage.

Verify 1 and 2 by hand against the video. There is no automated substitute.

## Tests

`binding.test.ts` — pure, fixture ASD scores + word list:
- clean two-speaker case binds correctly
- a speaker with no correlating track binds to `null`
- two speakers correlating to one track keeps the stronger and flags it
- hysteresis: a one-sample spike does not change `activeTrack`
- hysteresis: N+1 consecutive samples does change it
- empty scores return an empty binding rather than throwing

## Risks

| Risk | Mitigation |
|---|---|
| **Light-ASD licence restricts commercial use** | Master plan §7 flags research-origin models specifically. **Check before Block C.** Does not block local single-user use, but decide before it's load-bearing |
| ASD weights + face crops exceed 6 GB | Batch size is tunable; it's the only model resident at this point |
| Poor accuracy on small facecam faces | Phase 11 handles facecams as a distinct case rather than relying on ASD there |
| Hysteresis window too long → misses fast exchanges | It's a tunable tied to the `calm`/`dynamic` preset |
| Binding correct on average but wrong in one stretch | Time-ranged binding, not global; log per-window confidence |
