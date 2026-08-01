import type { FaceSample, FaceTrack } from "./signals.js";

export type FrameAspect = "9:16" | "1:1" | "4:3" | "16:9";

export const CANDIDATE_ASPECTS: FrameAspect[] = ["9:16", "1:1", "4:3", "16:9"];

export const ASPECT_RATIO: Record<FrameAspect, number> = { "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "16:9": 16 / 9 };

export const RETENTION = {
  /** Starting value, moved only when the corpus says so — see phase 29 doc. */
  floor: 0.9,
  /** The active speaker is a constraint, not a preference. */
  speakerFloor: 0.99,
};

/**
 * The framing window as a fraction of source width; 1 if the source is
 * already narrower than the window. `aspect` defaults to `"9:16"` so every
 * caller from before phase 30 (a fixed window) keeps working unchanged.
 */
export function cropWidthFor(sourceW: number, sourceH: number, aspect: FrameAspect = "9:16"): number {
  const ratio = ASPECT_RATIO[aspect];
  if (!sourceW || !sourceH) return Math.min(1, ratio);
  return Math.min(1, ratio / (sourceW / sourceH));
}

const windowFraction = cropWidthFor;

/**
 * Below this many samples in range, a "track" is a fleeting misdetection, not a
 * person — the same 1s-of-evidence floor `binding.ts` uses for `speakingTracks`.
 * Without it, a handful of 2-3-sample background blips outweighs the one real
 * face in the average, and a genuine solo clip measures as if it lost content.
 */
const MIN_TRACK_SAMPLES = 4;

/** Every face-track id + sample, grouped by the shared 4 Hz moment they were sampled at. */
function byMoment(tracks: FaceTrack[], t0: number, t1: number): Map<number, { id: number; s: FaceSample }[]> {
  const out = new Map<number, { id: number; s: FaceSample }[]>();
  for (const tr of tracks) {
    const inRange = tr.samples.filter((s) => s.t >= t0 && s.t < t1);
    if (inRange.length < MIN_TRACK_SAMPLES) continue;
    for (const s of inRange) {
      const key = Math.round(s.t * 1000); // ms key: tracks share one sampling clock
      (out.get(key) ?? out.set(key, []).get(key)!).push({ id: tr.id, s });
    }
  }
  return out;
}

const wholeIn = (f: FaceSample, lo: number, hi: number) => f.cx - f.w / 2 >= lo - 1e-9 && f.cx + f.w / 2 <= hi + 1e-9;

/** The window placement (of width `fw`) covering the most whole faces, centred on one of them. */
function bestWindow(faces: FaceSample[], fw: number): [number, number] {
  const half = fw / 2;
  let bestLo = Math.min(1 - fw, Math.max(0, 0.5 - half));
  let bestN = -1;
  for (const center of faces.map((f) => f.cx)) {
    const lo = Math.min(1 - fw, Math.max(0, center - half));
    const n = faces.filter((f) => wholeIn(f, lo, lo + fw)).length;
    if (n > bestN) {
      bestN = n;
      bestLo = lo;
    }
  }
  return [bestLo, bestLo + fw];
}

/**
 * Fraction of face-appearances in `[t0,t1)` a window of `aspect` retains whole.
 * A face clipped in half counts as lost — see phase 29 doc.
 */
export function retentionOver(
  tracks: FaceTrack[],
  sourceW: number,
  sourceH: number,
  t0: number,
  t1: number,
  aspect: FrameAspect
): number {
  const fw = windowFraction(sourceW, sourceH, aspect);
  let kept = 0;
  let total = 0;
  for (const entries of byMoment(tracks, t0, t1).values()) {
    const faces = entries.map((e) => e.s);
    const [lo, hi] = bestWindow(faces, fw);
    total += faces.length;
    kept += faces.filter((f) => wholeIn(f, lo, hi)).length;
  }
  return total ? kept / total : 1; // nothing to lose
}

/**
 * Same as `retentionOver`, restricted to moments where `activeTrack` says this
 * face is the one currently talking. A constraint, not a preference — phase 31
 * treats a violation as disqualifying, not as a low score.
 */
export function speakerRetentionOver(
  tracks: FaceTrack[],
  sourceW: number,
  sourceH: number,
  t0: number,
  t1: number,
  aspect: FrameAspect,
  activeTrack: (number | null)[],
  sampleStep: number
): number {
  const fw = windowFraction(sourceW, sourceH, aspect);
  let kept = 0;
  let total = 0;
  for (const [key, entries] of byMoment(tracks, t0, t1)) {
    const speaker = activeTrack[Math.floor(key / 1000 / sampleStep)];
    if (speaker == null) continue;
    const speaking = entries.find((e) => e.id === speaker);
    if (!speaking) continue;
    const [lo, hi] = bestWindow(entries.map((e) => e.s), fw);
    total++;
    if (wholeIn(speaking.s, lo, hi)) kept++;
  }
  return total ? kept / total : 1; // no identified speaker in range — nothing to violate
}

/** Narrowest aspect clearing both floors over `[t0,t1)`, or the widest candidate. */
export function narrowestSafe(
  tracks: FaceTrack[],
  sourceW: number,
  sourceH: number,
  t0: number,
  t1: number,
  activeTrack?: (number | null)[],
  sampleStep?: number
): FrameAspect {
  for (const aspect of CANDIDATE_ASPECTS) {
    if (retentionOver(tracks, sourceW, sourceH, t0, t1, aspect) < RETENTION.floor) continue;
    if (
      activeTrack &&
      sampleStep &&
      speakerRetentionOver(tracks, sourceW, sourceH, t0, t1, aspect, activeTrack, sampleStep) < RETENTION.speakerFloor
    ) {
      continue;
    }
    return aspect;
  }
  return CANDIDATE_ASPECTS[CANDIDATE_ASPECTS.length - 1];
}

/**
 * The whole-clip row stored on `signals` for visibility (see phase 29 doc) —
 * `retentionOver` applied over `[0, duration)` at every candidate aspect.
 * `undefined` when the clip has no real face (never a spuriously "perfect" 1.0).
 */
export function summarizeRetention(
  tracks: FaceTrack[],
  sourceW: number,
  sourceH: number,
  duration: number,
  activeTrack?: (number | null)[],
  sampleStep?: number
): { retention: Record<string, number>; speakerRetention?: Record<string, number>; narrowestSafe: string } | undefined {
  if (!tracks.some((t) => t.samples.length >= MIN_TRACK_SAMPLES)) return undefined;

  const retention: Record<string, number> = {};
  const speakerRetention: Record<string, number> = {};
  for (const aspect of CANDIDATE_ASPECTS) {
    retention[aspect] = retentionOver(tracks, sourceW, sourceH, 0, duration, aspect);
    if (activeTrack && sampleStep) {
      speakerRetention[aspect] = speakerRetentionOver(tracks, sourceW, sourceH, 0, duration, aspect, activeTrack, sampleStep);
    }
  }
  return {
    retention,
    ...(activeTrack && sampleStep ? { speakerRetention } : {}),
    narrowestSafe: narrowestSafe(tracks, sourceW, sourceH, 0, duration, activeTrack, sampleStep),
  };
}
