import type { Signals } from "./signals.js";

export type CompositionType = "talking-head" | "multi-speaker" | "screen-rec" | "b-roll";

export interface Classification {
  type: CompositionType;
  /** <0.6 means "route conservatively" — phase 7 should prefer a safe layout. */
  confidence: number;
  reason: string;
}

/**
 * Starting values, moved only when the corpus says so. `facecamFaceSize` is the
 * one that was already measured: 0.12 (gaming facecam) / 0.20 (solo) / 0.29
 * (podcast), so 0.15 sits in the real gap rather than being picked from air.
 */
export const CLASSIFY_THRESHOLDS = {
  faceCoverage: 0.2,
  ambiguousBand: [0.15, 0.3] as [number, number],
  facecamFaceSize: 0.15,
  facecamBand: [0.13, 0.17] as [number, number],
};

const inBand = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

/**
 * What kind of clip is this? Measured only — the LLM never gets a vote
 * (CLAUDE.md rule 3). First match wins.
 */
export function classify(sig: Signals): Classification {
  const T = CLASSIFY_THRESHOLDS;
  const cov = sig.faceCoverage;
  const size = sig.faceSizeRatio;
  // medianConcurrentFaces, not distinctFaceTracks: every scene cut re-mints a
  // track id, so the 2-person podcast counts 3 tracks (11 unfiltered) but a
  // correct 2 concurrent faces. Tracking can be fooled by cuts; counting can't.
  const people = sig.medianConcurrentFaces;
  // ASD, when it has run, is the better answer to "how many people speak":
  // it is measured from video+audio, while `speakerCount` comes from gated
  // diarization and reads 0 on every real job — which used to pin multi-speaker
  // clips at 0.55 confidence, below phase 7's routing floor.
  const speakers = sig.asdSpeakerCount ?? sig.speakerCount;

  if (cov < T.faceCoverage) {
    const confidence = inBand(cov, T.ambiguousBand) ? 0.5 : 0.9;
    // Narration is what separates gameplay-with-a-commentator (needs caption-led
    // composition) from a silent montage (needs nothing). Word count, not
    // speakerCount — speaker labels come from diarization, which can be absent.
    return sig.wordCount > 0
      ? { type: "screen-rec", confidence, reason: `faceCoverage ${cov} < ${T.faceCoverage}, narrated` }
      : { type: "b-roll", confidence, reason: `faceCoverage ${cov} < ${T.faceCoverage}, no speech` };
  }

  // A persistent facecam over gameplay is on screen in every frame, so its
  // coverage (0.99) is indistinguishable from a talking head's. Face SIZE is
  // what actually separates them.
  if (people <= 1 && size > 0 && size < T.facecamFaceSize) {
    return {
      type: "screen-rec",
      confidence: inBand(size, T.facecamBand) ? 0.5 : 0.8,
      reason: `faceSizeRatio ${size} < ${T.facecamFaceSize} with ${people} face — facecam over screen content`,
    };
  }

  if (people >= 2) {
    if (speakers >= 2) {
      return { type: "multi-speaker", confidence: 0.9, reason: `${people} concurrent faces, ${speakers} speakers` };
    }
    if (speakers === 1) {
      // An interviewee with a silent listener in frame must not get camera
      // switching. This audio cross-check is the only thing that prevents it.
      return { type: "talking-head", confidence: 0.8, reason: `${people} concurrent faces but 1 speaker — listener in frame` };
    }
    // speakerCount 0 with faces on screen means diarization produced no labels,
    // not that nobody spoke. Trust CV, but say so and stay under 0.6.
    return { type: "multi-speaker", confidence: 0.55, reason: `${people} concurrent faces, no speaker labels available` };
  }

  return {
    type: "talking-head",
    confidence: cov >= 0.4 ? 0.9 : 0.7,
    reason: `${people} face, faceCoverage ${cov}, faceSizeRatio ${size}`,
  };
}
