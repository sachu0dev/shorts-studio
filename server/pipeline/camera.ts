import type { FaceTrack } from "./signals.js";

export interface CameraKeyframe {
  t: number;
  cx: number;
  cy: number;
  zoom: number;
}

export interface SmoothingPreset {
  /** Sampling interval; the renderer interpolates between keyframes. */
  step: number;
  /** Ignore movement within this fraction of the frame — kills micro-jitter. */
  deadzone: number;
  /** EMA factor toward the target once outside the deadzone. */
  smooth: number;
  /** Above this delta, hard-snap instead of easing. */
  snap: number;
  /** How long to hold the last position after a track drops, before recentring. */
  hold: number;
}

export type PresetName = "calm" | "dynamic";

/**
 * Creators feel the difference between these immediately, which is why it is a
 * preset rather than a constant.
 *
 * **Deadzone and snap are measured, not the plan's values.** §3.3 suggests a
 * 0.15 deadzone and a 0.25 snap. Across 8 corpus windows a face's total
 * horizontal excursion is 0.001–0.173, and its 90th-percentile drift from the
 * opening position is 0.001–0.025 when static and 0.073–0.081 when moving. A
 * 0.15 deadzone therefore never opens: `fullscreen-follow` would render
 * identically to `static-center` and look like a bug in the router. The values
 * below straddle the 0.025 / 0.073 gap. A 0.25 snap likewise never fires,
 * because no measured face ever jumps that far.
 *
 * `track_jitter` (5 px ≈ 0.005 normalized) from the plan's table is deliberately
 * absent: the deadzone is 6–12× larger and already swallows everything jitter
 * would have caught. Two knobs meaning "don't move" is one knob and a bug.
 */
export const PRESETS: Record<PresetName, SmoothingPreset> = {
  calm: { step: 0.25, deadzone: 0.06, smooth: 0.18, snap: 0.12, hold: 3.0 },
  dynamic: { step: 0.25, deadzone: 0.03, smooth: 0.45, snap: 0.1, hold: 1.2 },
};

/** A track is considered dropped when its samples gap by more than this. */
const MAX_SAMPLE_GAP = 0.75;

/** The most-present track — the one a single-subject crop should follow. */
export function primaryTrack(tracks: FaceTrack[]): FaceTrack | null {
  let best: FaceTrack | null = null;
  for (const t of tracks) {
    if (t.samples.length && (!best || t.samples.length > best.samples.length)) best = t;
  }
  return best;
}

/**
 * Horizontal centre of the track at time `t`, or null when the face is not on
 * screen — before it appears, after it leaves, or inside a gap long enough to
 * be a real dropout rather than one missed detection.
 */
function sampleAt(track: FaceTrack, t: number): number | null {
  const s = track.samples;
  if (!s.length || t < s[0].t || t > s[s.length - 1].t) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i].t < t) continue;
    const a = s[i - 1];
    const b = s[i];
    if (b.t - a.t > MAX_SAMPLE_GAP) return null;
    const span = b.t - a.t;
    return span <= 0 ? b.cx : a.cx + ((t - a.t) / span) * (b.cx - a.cx);
  }
  return s[s.length - 1].cx;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Keyframes for a 9:16 window following one face.
 *
 * `static-center` is the degenerate case of this — a constant path — so the
 * renderer has one code path, not two.
 */
export function buildCameraPath(
  track: FaceTrack | null,
  cuts: number[],
  duration: number,
  cropWidth: number,
  preset: SmoothingPreset
): CameraKeyframe[] {
  const half = Math.min(cropWidth, 1) / 2;
  // The window cannot leave the frame, so cx is bounded before anything else
  // reads it. A path that says 0.9 on a 0.5625-wide window is not a camera move,
  // it is a black bar.
  const clamp = (x: number) => Math.min(1 - half, Math.max(half, x));

  if (!track || !track.samples.length) return [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }];

  const out: CameraKeyframe[] = [];
  let cur = clamp(sampleAt(track, 0) ?? track.samples[0].cx);
  let lastGood = 0;
  // Hysteresis: without it the camera stops the moment the face re-enters the
  // deadzone, leaving it parked a deadzone-width off centre for the whole clip.
  let moving = false;

  for (let t = 0; t <= duration + 1e-6; t += preset.step) {
    const seen = sampleAt(track, t);
    const recentring = seen === null && t - lastGood > preset.hold;
    let target: number;
    if (seen !== null) {
      target = seen;
      lastGood = t;
    } else if (!recentring) {
      target = cur; // hold the last position through a brief dropout
    } else {
      target = 0.5; // then ease back to centre rather than sitting on nothing
    }
    target = clamp(target);

    const d = target - cur;
    const cutHere = cuts.some((c) => c > t - preset.step && c <= t);

    if (cutHere || (!recentring && Math.abs(d) > preset.snap)) {
      // Panning smoothly through a hard cut reads as a rendering bug, not a style.
      // Recentring is exempt: a lost face is not a subject change, and snapping
      // to the middle the instant the hold expires is the jarring version.
      cur = target;
      moving = false;
    } else if (recentring) {
      cur = cur + preset.smooth * d; // always eases, deadzone does not apply
      moving = false;
    } else {
      if (Math.abs(d) > preset.deadzone) moving = true;
      else if (Math.abs(d) < preset.deadzone / 4) moving = false;
      if (moving) cur = cur + preset.smooth * d;
    }

    out.push({ t: r4(t), cx: r4(clamp(cur)), cy: 0.5, zoom: 1 });
  }
  return out;
}
