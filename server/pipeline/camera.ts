import type { FaceTrack } from "./signals.js";
import type { LayoutSegment } from "./router.js";

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
  /**
   * Minimum time on one speaker before `camera-switch` may cut away — phase 9's
   * most important number. It lives on the preset because "how twitchy is the
   * edit" is exactly what a creator means by calm vs dynamic.
   */
  minHold: number;
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
  calm: { step: 0.25, deadzone: 0.06, smooth: 0.18, snap: 0.12, hold: 3.0, minHold: 2.5 },
  dynamic: { step: 0.25, deadzone: 0.03, smooth: 0.45, snap: 0.1, hold: 1.2, minHold: 1.5 },
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

/** The same track with its samples re-based to `t0`, dropping anything outside. */
function sliceTrack(track: FaceTrack, t0: number, t1: number): FaceTrack | null {
  const samples = track.samples
    .filter((s) => s.t >= t0 - 1e-9 && s.t <= t1 + 1e-9)
    .map((s) => ({ ...s, t: r4(s.t - t0) }));
  return samples.length ? { ...track, firstSeen: 0, lastSeen: r4(t1 - t0), samples } : null;
}

/**
 * `camera-switch`: follow one face per segment, and **cut** between segments.
 *
 * Panning between two people two metres apart reads as a rendering bug, not a
 * style. The cut is expressed as two keyframes sharing a timestamp — the old
 * position and the new one — which the renderer's interpolator resolves to a
 * jump because the span between them is zero. That keeps one interpolator in
 * `render.py` rather than a second "is this a cut" code path.
 *
 * Scene cuts are not passed down to the per-segment paths: a segment already
 * begins at every cut, so a snap inside one is impossible by construction.
 */
export function buildSwitchPath(
  segments: LayoutSegment[],
  tracks: FaceTrack[],
  cropWidth: number,
  preset: SmoothingPreset
): CameraKeyframe[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const out: CameraKeyframe[] = [];

  for (const seg of segments) {
    const full = seg.target != null ? byId.get(seg.target) ?? null : null;
    const local = buildCameraPath(
      full && sliceTrack(full, seg.t0, seg.t1),
      [], seg.t1 - seg.t0, cropWidth, preset
    );
    // Hold the previous position right up to the boundary, then jump. Only
    // needed when the previous segment's last keyframe fell short of it, which
    // happens whenever a segment length is not a whole number of steps.
    const prev = out[out.length - 1];
    if (prev && prev.t < seg.t0 - 1e-9) out.push({ ...prev, t: r4(seg.t0) });
    for (const k of local) out.push({ ...k, t: r4(seg.t0 + k.t) });
  }
  return out.length ? out : [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }];
}

/**
 * `group-crop`: one window wide enough for everyone, held perfectly still.
 *
 * The router only reaches this mode when `facesFitOneCrop` is true — every
 * active face box inside one 9:16 window with ≥5% margin — so there is nothing
 * to follow and nothing to switch between. Centring on the group rather than on
 * the frame is the entire difference from `static-center`, and switching when a
 * single crop would work is a gimmick the system has to be able to decide against.
 */
export function groupCenter(tracks: FaceTrack[], cropWidth: number): CameraKeyframe[] {
  const xs = tracks.flatMap((t) => t.samples.map((s) => s.cx));
  if (!xs.length) return [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }];
  const half = Math.min(cropWidth, 1) / 2;
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  return [{ t: 0, cx: r4(Math.min(1 - half, Math.max(half, mid))), cy: 0.5, zoom: 1 }];
}
