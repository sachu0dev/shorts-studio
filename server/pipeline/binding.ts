import type { Artifact } from "../artifacts.js";
import type { TranscriptWord } from "./transcribe.js";

/** Per-track P(speaking) on the 4 Hz grid; null where the face is off screen. */
export type AsdScores = Record<string, (number | null)[]>;

export interface SpeakerBinding {
  trackId: number | null;
  confidence: number;
  reason?: string;
  /** The window the track is actually on screen — binding is time-ranged. */
  from?: number;
  to?: number;
}

export interface AsdArtifact extends Artifact {
  clipId: string;
  sampleStep: number;
  frames?: number;
  device?: string;
  scores: AsdScores;
  /** Hysteresis-stabilised "who is talking now" — what phase 9 consumes. */
  activeTrack: (number | null)[];
  speakers: Record<string, SpeakerBinding>;
  /**
   * Speakers counted from ASD alone. This owes nothing to diarization, which is
   * the point: it is what lets a multi-speaker clip clear phase 5's confidence
   * floor while `pyannote` stays gated.
   */
  asdSpeakerCount: number;
  peakVramMb?: number;
  ms?: number;
}

export const ASD_THRESHOLDS = {
  /** P(speaking) above which a face counts as talking. */
  speaking: 0.5,
  /**
   * Consecutive samples before the active speaker may change — 3 at 4 Hz is
   * 0.75 s. Without it the score flickers at every turn boundary and phase 9
   * produces a seizure rather than an edit.
   */
  hysteresis: 3,
  /** Minimum score separation to bind a diarized speaker to a face track. */
  bind: 0.15,
  /** A track must talk this long to count as a person who speaks in the clip. */
  minSpeakingSeconds: 1.0,
};

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Longest score array across tracks — the clip's sample count. */
function sampleCount(scores: AsdScores): number {
  return Math.max(0, ...Object.values(scores).map((s) => s.length));
}

/**
 * Loudest face per sample, then held until a challenger has led for
 * `hysteresis` consecutive samples. Returns null while nobody is speaking.
 */
export function stabilizeActiveTrack(
  scores: AsdScores,
  hysteresis: number = ASD_THRESHOLDS.hysteresis
): (number | null)[] {
  const ids = Object.keys(scores);
  const n = sampleCount(scores);
  const out: (number | null)[] = [];

  let active: number | null = null;
  let candidate: number | null = null;
  let run = 0;

  for (let k = 0; k < n; k++) {
    let best: number | null = null;
    let bestScore = ASD_THRESHOLDS.speaking;
    for (const id of ids) {
      const v = scores[id][k];
      if (v != null && v >= bestScore) {
        best = Number(id);
        bestScore = v;
      }
    }
    if (best === candidate) run++;
    else {
      candidate = best;
      run = 1;
    }
    if (run >= hysteresis) active = candidate;
    out.push(active);
  }
  return out;
}

/** Samples in which this speaker has at least one word. */
function speakingMask(words: TranscriptWord[], clipStart: number, step: number, n: number): boolean[] {
  const mask = new Array<boolean>(n).fill(false);
  for (const w of words) {
    const a = Math.max(0, Math.floor((w.start - clipStart) / step));
    const b = Math.min(n - 1, Math.ceil((w.end - clipStart) / step) - 1);
    for (let k = a; k <= b; k++) mask[k] = true;
  }
  return mask;
}

/**
 * How well a track's ASD score separates this speaker's talking from their
 * silence. Mean separation rather than Pearson: it stays defined when the
 * speaker never stops talking inside the window, which Pearson does not.
 */
function agreement(mask: boolean[], score: (number | null)[]): number {
  const on: number[] = [];
  const off: number[] = [];
  for (let k = 0; k < mask.length; k++) {
    const v = score[k];
    if (v == null) continue; // face off screen — says nothing either way
    (mask[k] ? on : off).push(v);
  }
  if (on.length + off.length < 4 || !on.length) return 0;
  // A speaker who never pauses in-window has nothing to contrast against, so
  // their own score level is all the evidence there is.
  return Math.max(0, off.length ? mean(on) - mean(off) : mean(on));
}

/** [first, last] time the track is on screen, from its non-null samples. */
function span(score: (number | null)[], step: number): [number, number] | null {
  const idx = score.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  return idx.length ? [r4(idx[0] * step), r4((idx[idx.length - 1] + 1) * step)] : null;
}

/**
 * Which face each diarized speaker is. Correlation over the whole window, not
 * per moment — one sample is noise, thirty seconds of agreement is not.
 *
 * `words` are in source time; `clipStart` shifts them onto the clip's grid.
 */
export function bindSpeakersToTracks(
  scores: AsdScores,
  sampleStep: number,
  words: TranscriptWord[],
  clipStart: number,
  log?: (line: string) => void
): Record<string, SpeakerBinding> {
  const n = sampleCount(scores);
  const labels = [...new Set(words.map((w) => w.speaker).filter(Boolean))] as string[];
  if (!n || !labels.length) return {};

  const candidates: { speaker: string; trackId: number; score: number }[] = [];
  for (const speaker of labels) {
    const mask = speakingMask(words.filter((w) => w.speaker === speaker), clipStart, sampleStep, n);
    for (const id of Object.keys(scores)) {
      candidates.push({ speaker, trackId: Number(id), score: agreement(mask, scores[id]) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const out: Record<string, SpeakerBinding> = {};
  const takenBy = new Map<number, string>();
  for (const c of candidates) {
    if (out[c.speaker] || c.score < ASD_THRESHOLDS.bind) continue;
    const owner = takenBy.get(c.trackId);
    if (owner) {
      // Two speakers on one face means diarization over-split one person. Keep
      // the stronger binding and say so — it is a transcript-quality signal,
      // not something to silently resolve.
      out[c.speaker] = {
        trackId: null,
        confidence: r4(c.score),
        reason: `track ${c.trackId} already bound to ${owner} — diarization likely over-split one person`,
      };
      log?.(`⚠️ ${c.speaker} and ${owner} both match face track ${c.trackId}`);
      continue;
    }
    takenBy.set(c.trackId, c.speaker);
    const range = span(scores[String(c.trackId)], sampleStep);
    out[c.speaker] = {
      trackId: c.trackId,
      confidence: r4(c.score),
      ...(range ? { from: range[0], to: range[1] } : {}),
    };
  }

  for (const speaker of labels) {
    if (out[speaker]) continue;
    // Phase 9 must hold the current frame for these, not cut to the nearest face.
    out[speaker] = { trackId: null, confidence: 0, reason: "off-camera" };
  }
  return out;
}

/** Face tracks that speak for at least `minSpeakingSeconds`. */
export function asdSpeakerCount(scores: AsdScores, sampleStep: number): number {
  const T = ASD_THRESHOLDS;
  const need = T.minSpeakingSeconds / sampleStep;
  return Object.values(scores).filter(
    (s) => s.filter((v) => v != null && v >= T.speaking).length >= need
  ).length;
}

/** The track speaking for most of [t0, t1), or null when nobody is. */
export function activeTrackIn(
  activeTrack: (number | null)[],
  sampleStep: number,
  t0: number,
  t1: number
): number | null {
  const tally = new Map<number, number>();
  for (let k = Math.floor(t0 / sampleStep); k < Math.min(activeTrack.length, Math.ceil(t1 / sampleStep)); k++) {
    const id = activeTrack[k];
    if (id != null) tally.set(id, (tally.get(id) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [id, n] of tally) if (n > bestN) [best, bestN] = [id, n];
  return best;
}
