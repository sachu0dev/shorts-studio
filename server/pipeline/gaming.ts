import type { FaceTrack } from "./signals.js";

export interface Facecam {
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  trackId: number;
}

/** One sample of `worker/stages/action.py`'s per-clip motion-weighted centroid. */
export interface ActionSample {
  t: number;
  cx: number;
  cy: number;
  confidence: number;
}

export interface ActionArtifact {
  schemaVersion: number;
  clipId: string;
  sampleStep: number;
  actionRegion: ActionSample[];
  actionConfidence: number;
  hudSuppressed: boolean;
  peakVramMb?: number;
  ms?: number;
}

/**
 * Starting values, moved only when the corpus says so (same convention as
 * classify.ts/router.ts). `maxSizeRatio` mirrors classify.ts's
 * `facecamFaceSize` gap (0.15) with headroom to 0.20 per the phase 11 spec.
 */
export const FACECAM = {
  maxSizeRatio: 0.2,
  /** Distance from a frame edge, as a fraction of the frame, that counts as "cornered". */
  cornerMargin: 0.25,
  /** Centroid drift (normalized std) above this reads as a moving subject, not a fixed overlay. */
  maxDrift: 0.02,
  /** Padding added around the measured box so a jittery or rounded overlay is never cropped through. */
  pad: 0.15,
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * A facecam is a face that is small, parked in a corner, and doesn't move —
 * classification over signals phase 4 already measures, not new CV (phase 11
 * doc). Evaluated per track, not on the clip-wide `faceSizeRatio`: a talking
 * head with a large centred face must never qualify, and a genuine
 * commentator inset over gameplay always should.
 *
 * ponytail: the rectangular-border edge detection the phase doc mentions (for
 * a tighter fit around a circular/rounded overlay) is skipped — the padded
 * box already satisfies the gate ("never crop through the face"); add real
 * edge detection only if a corpus clip shows the padding cutting into the
 * gameplay behind it.
 */
export function detectFacecam(tracks: FaceTrack[]): Facecam | null {
  let best: Facecam | null = null;

  for (const t of tracks) {
    if (t.samples.length < 2) continue;
    const size = median(t.samples.map((s) => s.h));
    if (size <= 0 || size >= FACECAM.maxSizeRatio) continue;

    const cxs = t.samples.map((s) => s.cx);
    const cys = t.samples.map((s) => s.cy);
    const mcx = median(cxs);
    const mcy = median(cys);
    const m = FACECAM.cornerMargin;
    const cornered = (mcx <= m || mcx >= 1 - m) && (mcy <= m || mcy >= 1 - m);
    if (!cornered) continue;

    const drift = Math.sqrt(variance(cxs) + variance(cys));
    if (drift >= FACECAM.maxDrift) continue;

    const w = Math.min(1, median(t.samples.map((s) => s.w)) * (1 + 2 * FACECAM.pad));
    const h = Math.min(1, size * (1 + 2 * FACECAM.pad));
    const confidence = Math.round(Math.max(0.5, Math.min(0.95, 1 - drift / FACECAM.maxDrift)) * 100) / 100;

    if (!best || confidence > best.confidence) {
      best = { x: clamp01(mcx - w / 2), y: clamp01(mcy - h / 2), w, h, confidence, trackId: t.id };
    }
  }
  return best;
}
