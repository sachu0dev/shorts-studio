# Phase 13 — Caption polish + best-frame thumbnail

**Goal:** the last mile. Captions look designed, thumbnails pick a real moment,
and the whole thing is good enough to publish without opening an editor.

## Why now

This is **Block A's closing gate**. Everything before it made the edit correct
and well-composed; this makes it look finished. It comes last because caption
placement depends on the layout (phase 9–11) and thumbnail selection depends on
face detection (phase 4).

## Scope

Caption presets driven by composition, layout-aware placement, and face-based
thumbnail frame selection.

## Out of scope

New caption animations. The six in
[captions.ts](../../server/pipeline/captions.ts) are enough — this phase makes
the existing ones land correctly, which is a different problem from having more.

## Changes

### Layout-aware caption placement

`buildStyleLine` writes a fixed `MarginV` of 260 for every clip. That is wrong in
at least three of the layouts now in play:

| Layout | Placement |
|---|---|
| `static-center`, `fullscreen-follow` | bottom third, as now |
| `split-screen` | the seam between halves, or bottom — **never** across a face |
| `gameplay-facecam-stack` | above the facecam, never overlapping it (flagged in phase 11) |
| `group-crop` | below the group's bounding box |

`buildStyleLine` takes the layout and the face bounding boxes, and returns a
`MarginV` that clears them. Captions covering a face is the single most common
way an otherwise-good automated edit looks amateur.

Because `layoutTimeline` is multi-segment, placement can vary within a clip —
but **only at segment boundaries**, never mid-sentence. A caption that jumps
while you're reading it is worse than one placed imperfectly.

### Caption presets driven by `contentMode`

The palette/animation/font mapping already exists but is chosen freely by the LLM
per clip. Tighten it into presets so styling is consistent within a clip and
recognisable across clips:

| `contentMode` | Palette | Animation | Font |
|---|---|---|---|
| `gaming` | `gaming-neon` | `punch-scale-bounce` | Bebas Neue / Anton |
| `political` | `news-serious` | `slide-up` | Archivo Black |
| `funny` | `meme-comic` / `hype-yellow` | `karaoke-reveal` | Luckiest Guy / Anton |

The LLM still picks `contentMode`; the preset follows deterministically. Fewer
degrees of freedom, more consistent output — and one less thing to validate.

**Romanized Hinglish (decision 3) means no font work.** All of these are Latin-glyph
families and work with the existing `resolveFont` cache. This is the phase where
Devanagari would have cost real effort; it doesn't.

### Readability pass

- **Max 3–4 words on screen at once.** Long caption groups get split at word
  boundaries using the real timings from phase 2.
- **Minimum on-screen duration** (~0.4 s) so a fast word isn't a flash.
- Outline and shadow verified against the brightest and darkest corpus frames —
  white-on-white is the failure mode.
- Safe-area margins so nothing sits under the YouTube Shorts UI overlay (roughly
  the bottom 12% and right edge). Easy to miss on desktop, obvious on a phone.

### Best-frame thumbnail

Today `renderThumbnail` uses `plan.thumbnailTimestamp` — an LLM guess from the
transcript, with no idea what the frame actually looks like. Replace with
selection over the phase 4 face track samples:

```
score(frame) = faceSize × faceConfidence × sharpness × (1 - motionBlur)
             + eyesOpenBonus - offCenterPenalty
```

Pick the best-scoring sampled frame inside the clip. Fall back to
`thumbnailTimestamp` when no faces exist (`b-roll`, some `screen-rec`) — for
gameplay, prefer a high-`actionConfidence` frame from phase 11 instead.

`thumbnailTimestamp` stays in `ClipPlan` as the fallback. Not deleted — it's the
right answer when there's no face to find.

### Thumbnail text

`renderThumbnail` currently strips `:` and `'` and forces uppercase with a
hardcoded `Arial Black`. Use the clip's chosen font via `resolveFont` for
consistency with the captions, and position the text clear of the detected face.

## Contracts

`composition/<clipId>.json` extended:

```jsonc
{
  "captions": {
    "preset": "gaming-neon/punch-scale-bounce/Bebas Neue",
    "placement": [ { "t0": 0.0, "t1": 12.4, "marginV": 260 },
                   { "t0": 12.4, "t1": 19.6, "marginV": 960, "reason": "split-screen seam" } ]
  },
  "thumbnail": { "t": 147.2, "score": 0.83, "method": "face-best-frame" }
}
```

## Gate — this is Block A's gate

1. **Paste a URL, get a Short you would publish without opening an editor.**
   All four corpus sources. If that isn't true, phases 6–12 get refined before
   Block B starts. This is the only gate that matters.
2. Captions never overlap a face or the facecam, in any layout.
3. Captions never fall under the Shorts UI safe area — checked on a real phone.
4. Never more than 4 words on screen.
5. Thumbnails show a clear, sharp, well-framed face where one exists.
6. Hinglish clips are readable and correctly romanized end to end.
7. Side by side with the **phase 0 baseline** — the improvement should be
   obvious to someone who wasn't told what changed.

## Tests

- `captions.test.ts` — placement clears a given face box per layout; placement
  changes only at segment boundaries; ≤4 words per screen; min duration enforced.
- `thumbnail.test.ts` — best-frame scoring picks the known-best fixture frame;
  no faces falls back to `thumbnailTimestamp`; gameplay prefers high action
  confidence.
- Preset mapping is total: every `contentMode` yields a complete preset.

## Risks

| Risk | Mitigation |
|---|---|
| Placement changes mid-sentence and looks broken | Only at segment boundaries; asserted in tests |
| Presets feel repetitive across many clips | Small controlled variation within a preset, not a free LLM choice |
| Best-frame scoring picks a blurred or mid-blink frame | Sharpness and eyes-open terms; verify by eye on the corpus |
| Safe-area guess wrong | Check on an actual phone, not the desktop preview |
| "Good enough to publish" is subjective and slips | It's your call, made against the phase 0 baseline — write down what still bothers you and fix it before Block B |
