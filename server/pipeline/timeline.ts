import type { LayoutMode, LayoutSegment } from "./router.js";

export const TIMELINE = {
  /**
   * Default minimum time on one speaker. The router passes the **preset's**
   * `minHold` instead (calm 2.5 s, dynamic 1.5 s); this is only what a caller
   * gets for not choosing.
   *
   * This is the single most important number in phase 9. Without it every
   * "yeah" and "mhm" triggers a cut: `activeTrack` is already hysteresis-stable
   * at 0.75 s (phase 8), which is enough to stop *flicker* but nowhere near
   * enough to stop a backchannel from stealing the frame.
   */
  minHold: 2.0,
};

export interface Timeline {
  segments: LayoutSegment[];
  /** Segments actually emitted. */
  heldSegments: number;
  /**
   * Speaker changes min-hold rejected. Zero on a fast podcast means min-hold
   * is not working; twenty on a calm interview means it is too aggressive.
   * It is the fastest way to tell whether the tuning is right.
   */
  suppressedSwitches: number;
}

/**
 * Per-sample "who is talking" → held segments.
 *
 * Rules, in the order they win:
 *  1. **A scene cut always starts a segment.** A source cut is a fact; min-hold
 *     is a preference, and a preference never overrides a fact.
 *  2. **Min-hold.** A turn shorter than `minHold` is absorbed into the segment
 *     around it rather than becoming one.
 *  3. **`null` holds.** Nobody speaking — or a speaker bound off-camera — keeps
 *     the current frame. Cutting to the nearest visible face is confidently
 *     wrong, which is worse than being late.
 *
 * Segments are contiguous and cover [0, duration] exactly. A gap here is a
 * black frame, which is why the test asserts it directly.
 */
export function buildLayoutTimeline(
  activeTrack: (number | null)[],
  sampleStep: number,
  cuts: number[],
  duration: number,
  mode: LayoutMode,
  fallbackTarget: number | null,
  minHold: number = TIMELINE.minHold
): Timeline {
  const cutTimes = [...new Set(cuts.filter((c) => c > 0 && c < duration))].sort((a, b) => a - b);
  const at = (t: number) => activeTrack[Math.floor(t / sampleStep)] ?? null;

  const segments: LayoutSegment[] = [];
  let suppressedSwitches = 0;

  let target = at(0) ?? fallbackTarget;
  let source: "asd" | "presence" = at(0) != null ? "asd" : "presence";
  let t0 = 0;
  let snapped = false;

  const close = (t1: number, nextSnapped: boolean) => {
    if (t1 - t0 < 1e-9) return;
    segments.push({
      t0: round(t0), t1: round(t1), mode,
      ...(target != null ? { target, targetSource: source } : {}),
      ...(snapped ? { snapped: true } : {}),
    });
    t0 = t1;
    snapped = nextSnapped;
  };

  let nextCut = 0;
  let lastSuppressed: number | null = null;
  for (let k = 0; k < Math.ceil(duration / sampleStep); k++) {
    const t = k * sampleStep;

    // rule 1 — cuts first, and they reset the hold
    while (nextCut < cutTimes.length && cutTimes[nextCut] <= t) {
      close(cutTimes[nextCut], true);
      const now = at(t);
      target = now ?? target ?? fallbackTarget;
      source = now != null ? "asd" : "presence";
      lastSuppressed = null;
      nextCut++;
    }

    const now = activeTrack[k] ?? null;
    if (now == null || now === target) {
      if (now === target) {
        lastSuppressed = null;
        // A segment that opened on presence — the hysteresis window at the start
        // of a clip or after a cut — is measured after all once ASD agrees.
        source = "asd";
      }
      continue; // rule 3, and nothing to do
    }

    // rule 2, both halves. The current segment has to have earned its hold, and
    // the challenger has to be worth switching to — a switch rejected only by
    // the first is DEFERRED, not dropped, so it lands the moment the hold ends.
    if (t - t0 < minHold || turnLength(activeTrack, k, now, sampleStep) < minHold) {
      if (now !== lastSuppressed) suppressedSwitches++; // count turns, not samples
      lastSuppressed = now;
      continue;
    }
    close(t, false);
    target = now;
    source = "asd";
    lastSuppressed = null;
  }

  // trailing cuts past the last sample still split the timeline
  while (nextCut < cutTimes.length) close(cutTimes[nextCut++], true);
  close(duration, false);

  return { segments, heldSegments: segments.length, suppressedSwitches };
}

/**
 * How long `id` stays the active speaker from sample `k`.
 *
 * Silence extends a turn rather than ending it: holding on whoever spoke last
 * through a three-second pause is right, and it stops a pause from making a
 * genuine turn look too short to be worth cutting to.
 */
function turnLength(activeTrack: (number | null)[], k: number, id: number, step: number): number {
  let j = k;
  while (j < activeTrack.length && (activeTrack[j] === id || activeTrack[j] == null)) j++;
  return (j - k) * step;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
