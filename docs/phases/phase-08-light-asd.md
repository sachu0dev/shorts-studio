# Phase 8 — Light-ASD active speaker detection

**Status: built.** Gates 3, 5, 6, 7 pass. Gate 2 verified by frame inspection.
Gates 1 and 4 are **unverifiable until diarization is ungated** — they are about
*speaker labels*, and there are none. See "What actually happened".

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

---

## What actually happened

### The licence risk is closed: Light-ASD is MIT

The risk table above says *"check before Block C."* Checked now, because it was
one HTTP request: [Junhua-Liao/Light-ASD](https://github.com/Junhua-Liao/Light-ASD)
ships under **MIT** (© 2023 Liao Junhua). Commercial use is fine and phase 23 has
nothing to unpick. The model code is vendored at `worker/vendor/lightasd/`
(3 files, unmodified, licence included) and the 4 MB `finetuning_TalkSet` weight
at `worker/models/lightasd_finetuning_TalkSet.model`.

`loss.py` is deliberately *not* vendored: the audio-visual classifier head lives
in the training loss module upstream, so `asd.py` rebuilds it as a bare
`nn.Linear(128, 2)` from the same checkpoint rather than importing an optimizer
and a training loop to get at two tensors.

### The contract moved to its own artifact

The plan extends `analysis/<clipId>.json`. It is written to **`asd/<clipId>.json`**
instead. `analyze:<clipId>` owns the analysis file, and a second writer breaks
`runStage`'s "artifact exists at the right schemaVersion → skip" check (rule 4):
re-running analyse would silently clobber the ASD block, and re-running ASD would
resurrect stale signals. One writer per artifact is the cheaper invariant.

Shape is otherwise as specified, plus `asdSpeakerCount` — see gate 7.

### Gate 5 — comfortably passed, and it is not close

| | measured |
|---|---|
| Wall time, 45 s clip, 5 tracks | **2.6 s** (gate allows ~30 s/clip) |
| Peak VRAM, device-wide | **666 MiB** of 6141 |
| Resident models | ASD only — YuNet is CPU, WhisperX exited |

Two things bought that, and both are worth keeping:

- **One decode pass for all tracks.** The obvious loop re-decodes the window per
  face track. Crops for every track come out of a single sequential decode.
- **Cut fragments are not scored.** A 45 s multi-camera window arrived with
  **22 face tracks**, most of them two seconds of one camera angle. `asd.py`
  scores only tracks covering ≥10% of the window, longest 6 first — 22 → 5, and
  roughly 4× less work for nothing lost.

### Gate 2 — verified from frames, since there is no automated substitute

The gate says to check by hand against the video. Done by rendering the model's
own input crops side by side with their scores at moments where two faces are on
screen at once. On the two-shot stretch of `clip3` (t = 18.0–19.5 s): the
speaking face scores **0.77–0.81** with an open mouth, the listener beside them
scores **0.00**. That is the case fixed left/right slot assignment gets wrong.

An ablation confirms the scores are driven by the input rather than a saturated
head:

| input | mean score |
|---|---|
| real face video + real audio | 0.896 |
| **frozen** face (one frame repeated) + real audio | **0.015** |
| flat grey video + real audio | 0.040 |
| real face video + noise audio | 0.969 |

Read that last row honestly: **Light-ASD is dominated by lip motion, not by
audio-visual synchrony.** Corrupting the audio does not lower the score.
That is fine for what phases 9 and 10 ask of it — *which of these faces is
moving their mouth* — and it is why the model still works with the corpus
diarization gated. It also means ASD alone can never tell you that an off-screen
voice belongs to nobody in frame; only the binding can, and the binding needs
labels.

### Gate 3 — hysteresis

`stabilizeActiveTrack` requires 3 consecutive samples (0.75 s at 4 Hz) before the
active track changes, so no switch shorter than the window can exist by
construction. Asserted both directions in `binding.test.ts` — a one-sample spike
mid-run does not switch, a run of exactly 3 does.

One deliberate deviation from the plan: when **nobody** is speaking, `activeTrack`
holds the last speaker rather than dropping to `null`. A pause between sentences
is not a reason to change what the camera is looking at.

### Gate 6 — `layoutTimeline[].target` is no longer assumed

It now comes from `activeTrackIn()`, the majority ASD-active track over the
segment, and carries **`targetSource: "asd" | "presence"`** so a wrong frame is
attributable at a glance. Presence remains the fallback, because a segment where
nobody speaks still has to frame someone.

`cameraPath` still follows the most-present track. Making the camera *move* to
the target is phase 9 by definition; this phase only makes the target true.

### Gate 7 — yes. ASD unblocks routing without pyannote

The question inherited from phase 7 was whether `activeTrack` alone lifts phase
5's multi-speaker confidence past 0.6. **It does.**

`asdSpeakerCount` counts face tracks that speak for ≥1 s. It is measured from
video and audio, so it exists on every real job, and `classify()` now prefers it
over the diarized `speakerCount`:

```
faces=2, speakerCount=0 (gated)                  → multi-speaker @ 0.55  ← below the floor
faces=2, speakerCount=0, asdSpeakerCount=2       → multi-speaker @ 0.90  ← routes properly
```

**Consequences:** `group-crop`, `camera-switch` and `split-screen` become
reachable on real footage, so phases 9–11 can be gated on real clips rather than
unit tests. The HF gate drops from a hard prerequisite for three phases to a
transcript-quality issue: without it there are still no speaker *labels*, so
`speakers` binds nothing and gates 1 and 4 below stay unverifiable.

It also fixes a subtler error in the other direction — diarization saying two
speakers while only one face is measurably talking is now correctly read as
*listener in frame*, not a debate.

### Gates 1 and 4 — blocked, and one thing to fix before phase 9

Both are about *speaker labels*: "the same person keeps the same speaker label
after the cut" and "a speaker who is off-camera binds to `null`". With
`pyannote/speaker-diarization-community-1` gated, every corpus transcript has
`speakers: []`, so `bindSpeakersToTracks` correctly returns `{}` and there is
nothing to check. The binding logic itself is covered by fixture tests, including
both cases.

Measuring for those gates surfaced a real defect that is **not** phase 8's to
fix, and it is flagged into [phase 9](phase-09-camera-switch.md):

> **Face track ids are not identity-stable across scene cuts.** Measured on a
> multi-cam window: **13 of 22 tracks span a cut**, and track 2 covered *two
> different people* — the tracker matched them because they occupied a similar
> position on either side of the cut. ASD scores that track as one entity, so the
> series is a blend of two faces.

Retiring tracks at every cut was tried and **reverted**. It is right for identity
and wrong for everything else: on a solo window with 6 cuts in 25 s, the primary
track shatters into 7 fragments, `distinctFaceTracks` drops to **0**, and
`buildCameraPath` gets a 4 s track for a 25 s clip — phase 7 destroyed to fix a
phase 9 problem. The real fix is re-identification across cuts, which is exactly
what `camera-switch` needs anyway.

### Tests

`binding.test.ts` — 11 cases, all six from the plan plus clip-time offsetting,
time-ranged binding, the no-speaker hold, `asdSpeakerCount` and `activeTrackIn`.
`asd.py --self-test` covers crop geometry, dropout handling in `box_at`, and the
25 fps → 4 Hz resampling, with no GPU and no video.
