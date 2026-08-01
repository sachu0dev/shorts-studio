# Test corpus

Four fixed sources. **Every gate from phase 4 onward is measured against these.**
Pick them once in phase 0 and never change them — if the corpus moves, "did this
get better?" becomes unanswerable.

Keep local copies in `storage/corpus/` (gitignored) so a deleted YouTube video
doesn't invalidate the plan.

Locked in phase 0 (2026-07-31). Every one was verified to download and probe
before being written down.

| Slot | Requirement | URL | Len |
|---|---|---|---|
| **solo** | One person to camera, low motion | [NHopJHSlVo4](https://www.youtube.com/watch?v=NHopJHSlVo4) — Derek Sivers, *Keep your goals to yourself* (TED) | 3:46 |
| **podcast** | Two people, visible crosstalk and turn-taking | [CNBxIhxHHxM](https://www.youtube.com/watch?v=CNBxIhxHHxM) — Simon Sinek & Trevor Noah | 24:00 |
| **gaming** | Gameplay with a facecam | [QFcMsXkx448](https://www.youtube.com/watch?v=QFcMsXkx448) — C9 OXY Reyna, Valorant | 31:32 |
| **hinglish** | Heavy English/Hindi code-switching | [cpg78ouK54I](https://www.youtube.com/watch?v=cpg78ouK54I) — Raj Shamani × Nikhil Kamath | 44:17 |

Why these four specifically:

- **solo** is short (3:46), so it is the fast smoke test — use it whenever you
  just need to know the pipeline still runs end to end.
- **gaming** was chosen over other candidates because a frame check confirmed a
  **small, cornered, stable facecam (top-left) over gameplay with a heavy HUD** —
  precisely the three signals [phase 11](phase-11-gaming.md) keys on. Videos
  labelled "gameplay + commentary" frequently have no facecam at all.
- **hinglish** is a Raj Shamani episode: dense code-switching in a two-speaker
  setup, so it stresses transcription *and* diarization together.

Useful extras once the four above exist — they cover the classifier's hard cases
from [phase 5](phase-05-content-classifier.md):

| Slot | Requirement | Why | URL |
|---|---|---|---|
| `gaming-nofacecam` | Gameplay, no facecam | phase 11 `action-follow` path | [2LnFuREmbpk](https://www.youtube.com/watch?v=2LnFuREmbpk) — verified facecam-free |
| `broll` | Music / montage, no narration | phase 5 must not call this `screen-rec` | _TBD_ |
| `interview` | One speaker + a silent listener in frame | must classify `talking-head`, **not** `multi-speaker` | _TBD_ |

## Named windows

A source is not a test case; a *window* is. These were measured in phases 4–7
and each one is the only footage in the corpus that exercises what it names.
**Check the window before concluding a gate failed** — phase 7's gate 4 read as
a failure purely because it was measured on a subject who never moves.

| Window | `subjectMotion` | Face excursion | What only this window can test |
|---|---|---|---|
| solo 10–35 | 0.122 | **0.432** | Camera travel. `calm` vs `dynamic` are 88 px vs 58 px lag here and indistinguishable anywhere else. 4 scene cuts inside it. |
| solo 146.8–171.8 | 0.072 | 0.116 | `fullscreen-follow` on a seated subject; 6 scene cuts, the snap-at-cut case. |
| solo 175–200 | 0.036 | — | `static-center` on a confident talking-head — the "plain centre is the right edit" case. |
| solo 90–115 | 0.0006 | 0.001 | A genuinely motionless subject. |
| hinglish 398.6–423.6 | 0.029 | 0.152 | Two concurrent faces; caps at 0.55 confidence until diarization is ungated. |

Measured `subjectMotion` across the corpus spans **0.0006 – 0.122**. Any
threshold on it written in units of "fraction of frame" without checking that
range will be wrong by roughly 4× — which is exactly what happened to the master
plan's `MOTION_T = 0.15` and `track_deadzone = 0.15`.

## Baseline

Phase 0 archives one rendered clip per source into `docs/phases/baseline/`.
Phase 2 and phase 13 are judged by eye against these. Without them there is no
evidence anything improved.

## Expected classifications

Phase 5's gate, restated here so it's checkable without opening another file:

| Source | `compositionType` |
|---|---|
| solo | `talking-head` |
| podcast | `multi-speaker` |
| gaming (with facecam) | `screen-rec` — the facecam must not fool it |
| gaming-nofacecam | `screen-rec` |
| broll | `b-roll` |
| interview | `talking-head` |
