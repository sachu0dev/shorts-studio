import type { Artifact } from "../artifacts.js";
import type { Classification } from "./classify.js";
import type { TranscriptWord } from "./transcribe.js";

export interface FaceSample {
  t: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
  conf: number;
}

export interface FaceTrack {
  id: number;
  firstSeen: number;
  lastSeen: number;
  samples: FaceSample[];
}

export interface Signals {
  faceCoverage: number;
  distinctFaceTracks: number;
  rawTrackCount: number;
  medianConcurrentFaces: number;
  maxConcurrentFaces: number;
  subjectMotion: number;
  facesFitOneCrop: boolean;
  faceSizeRatio: number;
  // transcript-derived, filled in on the Node side
  speakerCount: number;
  /**
   * Aligned words in the window. This is the narration signal, and it is
   * deliberately not `speakerCount > 0`: speaker labels come from diarization,
   * which can be unavailable, whereas "were any words spoken" always holds.
   */
  wordCount: number;
  /**
   * Speakers measured by ASD (phase 8) — how many face tracks actually talk.
   * Absent until the ASD stage has run for the clip. Preferred over
   * `speakerCount` wherever both exist: this one owes nothing to diarization,
   * which is gated and returns 0 on every real job.
   */
  asdSpeakerCount?: number;
  overlapRatio: number;
  turnRate: number;
  sceneCuts: number[];
  /**
   * Whole-clip reporting only (phase 29) — a preference, not a decision.
   * Phase 30 calls `retentionOver` per segment; it will routinely disagree with
   * this row, which is expected: a clip that summarises to 16:9 can still open
   * on a correct 9:16 close-up. Absent when the clip has no real faces at all.
   */
  retention?: Record<string, number>;
  /** Same, restricted to moments where ASD names this face the active speaker. */
  speakerRetention?: Record<string, number>;
  /** Narrowest aspect clearing the retention floor(s) over the whole clip. */
  narrowestSafe?: string;
}

export interface AnalysisArtifact extends Artifact {
  clipId: string;
  start: number;
  end: number;
  sourceWidth: number;
  sourceHeight: number;
  sampleStep: number;
  faceTracks: FaceTrack[];
  signals: Signals;
  /** Absent on artifacts written before phase 5. */
  classification?: Classification;
  peakVramMb?: number;
  ms?: number;
}

/** Words overlapping [start, end), clamped to the window. */
export function wordsInWindow(words: TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((w) => w.end > start && w.start < end);
}

/** Distinct non-null speakers in the window. */
export function speakerCount(words: TranscriptWord[]): number {
  return new Set(words.map((w) => w.speaker).filter(Boolean)).size;
}

/**
 * Speaker switches per minute. Counts changes between consecutive labelled
 * words, so an unlabelled gap doesn't fake a turn.
 */
export function turnRate(words: TranscriptWord[], windowSeconds: number): number {
  if (windowSeconds <= 0) return 0;
  const labelled = words.filter((w) => w.speaker);
  let switches = 0;
  for (let i = 1; i < labelled.length; i++) {
    if (labelled[i].speaker !== labelled[i - 1].speaker) switches++;
  }
  return Math.round((switches / (windowSeconds / 60)) * 100) / 100;
}

/**
 * Fraction of the window where two or more speakers are talking at once.
 *
 * This is the signal that earns split-screen in phase 10: genuine crosstalk,
 * not merely "two people are present". Computed by sweeping the per-speaker
 * word intervals rather than sampling, so short overlaps aren't missed.
 */
export function overlapRatio(words: TranscriptWord[], start: number, end: number): number {
  const windowSeconds = end - start;
  if (windowSeconds <= 0) return 0;

  const labelled = words.filter((w) => w.speaker);
  if (labelled.length === 0) return 0;

  type Edge = { t: number; delta: number; speaker: string };
  const edges: Edge[] = [];
  for (const w of labelled) {
    const a = Math.max(start, w.start);
    const b = Math.min(end, w.end);
    if (b <= a) continue;
    edges.push({ t: a, delta: 1, speaker: w.speaker! });
    edges.push({ t: b, delta: -1, speaker: w.speaker! });
  }
  if (!edges.length) return 0;
  edges.sort((x, y) => x.t - y.t || x.delta - y.delta);

  // Count DISTINCT speakers active, not word count — one speaker's overlapping
  // words must never look like crosstalk.
  const active = new Map<string, number>();
  let overlapped = 0;
  let prevT = edges[0].t;
  for (const e of edges) {
    if (e.t > prevT && [...active.values()].filter((n) => n > 0).length >= 2) {
      overlapped += e.t - prevT;
    }
    active.set(e.speaker, (active.get(e.speaker) ?? 0) + e.delta);
    prevT = e.t;
  }
  return Math.round((overlapped / windowSeconds) * 10000) / 10000;
}

/** Scene cuts inside the window, expressed relative to the clip start. */
export function cutsInWindow(cuts: number[], start: number, end: number): number[] {
  return cuts.filter((c) => c > start && c < end).map((c) => Math.round((c - start) * 1000) / 1000);
}

/** Everything the CV stage can't know, computed from transcript + scenes. */
export function transcriptSignals(
  words: TranscriptWord[],
  cuts: number[],
  start: number,
  end: number
): Pick<Signals, "speakerCount" | "wordCount" | "overlapRatio" | "turnRate" | "sceneCuts"> {
  const inWindow = wordsInWindow(words, start, end);
  return {
    speakerCount: speakerCount(inWindow),
    wordCount: inWindow.length,
    overlapRatio: overlapRatio(inWindow, start, end),
    turnRate: turnRate(inWindow, end - start),
    sceneCuts: cutsInWindow(cuts, start, end),
  };
}
