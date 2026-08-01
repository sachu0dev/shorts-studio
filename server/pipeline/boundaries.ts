import type { TranscriptWord } from "./transcribe.js";

export type SnapReason = "scene-cut" | "silence" | "word" | "none";

export interface Silence {
  start: number;
  end: number;
}

export interface ScenesArtifact {
  schemaVersion: number;
  cuts: number[];
  silences: Silence[];
  detector: string;
  cutsPerMinute?: number;
  fastCut?: boolean;
}

export interface SnappedWindow {
  start: number;
  end: number;
  snappedTo: SnapReason;
  shiftedBy: number;
}

/** The prompt's contract and the Shorts limit. Snapping must not break either. */
export const MIN_CLIP = 20;
export const MAX_CLIP = 58;

function nearest(candidates: number[], target: number, budget: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - target);
    if (d <= budget && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/**
 * True when t falls strictly inside a spoken word.
 *
 * This is why scene cuts cannot simply outrank everything: a multi-camera
 * podcast cuts *while someone is mid-sentence*, so the cut is often inside a
 * word. Snapping there produces exactly the clipped syllable this phase exists
 * to remove, so such candidates are dropped rather than ranked.
 */
function insideWord(t: number, words: TranscriptWord[]): boolean {
  const EPS = 1e-6;
  return words.some((w) => t > w.start + EPS && t < w.end - EPS);
}

/**
 * Best boundary for one edge, in priority order:
 *   1. a scene cut  — a hard cut is the cleanest boundary that exists
 *   2. a silence    — starting in a gap sounds deliberate
 *   3. a word edge  — the floor; guarantees we never begin mid-word
 */
function snapEdge(
  target: number,
  edge: "start" | "end",
  cuts: number[],
  silences: Silence[],
  words: TranscriptWord[],
  budget: number
): { at: number; reason: SnapReason } {
  // Only candidates that don't land mid-word are eligible, at every tier.
  const usable = (xs: number[]) => xs.filter((x) => !insideWord(x, words));

  const cut = nearest(usable(cuts), target, budget);
  if (cut !== null) return { at: cut, reason: "scene-cut" };

  // Mid-gap: audibly inside the pause rather than clipping its edge.
  const mids = usable(silences.map((s) => (s.start + s.end) / 2));
  const silence = nearest(mids, target, budget);
  if (silence !== null) return { at: silence, reason: "silence" };

  const edges = edge === "start" ? words.map((w) => w.start) : words.map((w) => w.end);
  const word = nearest(edges, target, budget);
  if (word !== null) return { at: word, reason: "word" };

  return { at: target, reason: "none" };
}

/** Word-boundary-only snap — the guaranteed floor used by the duration fallback. */
function wordOnly(
  target: number,
  edge: "start" | "end",
  words: TranscriptWord[],
  budget: number
): { at: number; reason: SnapReason } {
  const edges = edge === "start" ? words.map((w) => w.start) : words.map((w) => w.end);
  // widen the budget here: a mid-word boundary is worse than a slightly larger shift
  const at = nearest(edges, target, budget) ?? nearest(edges, target, budget * 3);
  return at !== null ? { at, reason: "word" } : { at: target, reason: "none" };
}

/**
 * Aligns one LLM-chosen window to something real. Pure — cuts, silences and
 * words in, numbers out — which is what makes it testable without ffmpeg.
 *
 * A snap that would push the clip outside 20–58s is rejected rather than
 * applied: a correct boundary is not worth an unpublishable clip.
 */
export function snapWindow(
  start: number,
  end: number,
  cuts: number[],
  silences: Silence[],
  words: TranscriptWord[],
  maxShiftSec = 1.2
): SnappedWindow {
  const s = snapEdge(start, "start", cuts, silences, words, maxShiftSec);
  const e = snapEdge(end, "end", cuts, silences, words, maxShiftSec);

  let newStart = s.at;
  let newEnd = e.at;
  let startReason = s.reason;
  let endReason = e.reason;

  // Reject either edge individually if the pair violates the duration bounds.
  const dur = newEnd - newStart;
  if (dur < MIN_CLIP || dur > MAX_CLIP) {
    // Fall back to a WORD boundary, never to the raw LLM value — that value is
    // exactly what lands mid-word, which no duration rule may reintroduce.
    const keepStart = wordOnly(start, "start", words, maxShiftSec);
    const keepEnd = wordOnly(end, "end", words, maxShiftSec);
    const options: Array<[{ at: number; reason: SnapReason }, { at: number; reason: SnapReason }]> = [
      [s, keepEnd],
      [keepStart, e],
      [keepStart, keepEnd],
    ];
    const ok = options.find(([a, b]) => {
      const d = b.at - a.at;
      return d >= MIN_CLIP && d <= MAX_CLIP;
    });
    const [a, b] = ok ?? [keepStart, keepEnd];
    newStart = a.at;
    newEnd = b.at;
    startReason = a.reason;
    endReason = b.reason;
  }

  // Report the better of the two edges — "scene-cut" beats "word".
  const rank: Record<SnapReason, number> = { "scene-cut": 3, silence: 2, word: 1, none: 0 };
  const snappedTo = rank[startReason] >= rank[endReason] ? startReason : endReason;

  return {
    start: newStart,
    end: newEnd,
    snappedTo,
    shiftedBy: Math.round((Math.abs(newStart - start) + Math.abs(newEnd - end)) * 1000) / 1000,
  };
}

/**
 * Snaps every clip in a plan, then resolves any overlap snapping introduced.
 * Collisions are settled in favour of the earlier clip's `end`, matching the
 * non-overlap guarantee the planning prompt already promises.
 */
export function snapPlans<T extends { start: number; end: number }>(
  plans: T[],
  scenes: { cuts: number[]; silences: Silence[] } | null,
  words: TranscriptWord[],
  maxShiftSec = 1.2
): (T & { snappedTo: SnapReason; shiftedBy: number })[] {
  const cuts = scenes?.cuts ?? [];
  const silences = scenes?.silences ?? [];

  const snapped = plans.map((p) => {
    const w = snapWindow(p.start, p.end, cuts, silences, words, maxShiftSec);
    return { ...p, start: w.start, end: w.end, snappedTo: w.snappedTo, shiftedBy: w.shiftedBy };
  });

  const ordered = [...snapped].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    if (cur.start < prev.end) {
      cur.start = prev.end;
      // if pushing the start broke the minimum length, undo this clip's snap
      if (cur.end - cur.start < MIN_CLIP) {
        const target = Math.max(cur.end, cur.start + MIN_CLIP);
        cur.end = wordOnly(target, "end", words, maxShiftSec).at;
      }
      cur.snappedTo = "none";
    }
  }
  return snapped;
}
