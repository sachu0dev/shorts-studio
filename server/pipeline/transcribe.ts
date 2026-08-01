import { runPythonStage } from "./python.js";

export interface Segment {
  start: number;
  end: number;
  text: string;
  /** Original script (e.g. Devanagari) when romanized. The LLM reads it better. */
  textNative?: string;
  speaker?: string | null;
}

export interface TranscriptWord {
  w: string;
  wNative: string;
  start: number;
  end: number;
  speaker?: string | null;
  confidence?: number | null;
}

export interface TranscriptArtifact {
  schemaVersion: number;
  language: string;
  romanized: boolean;
  modelTier: string;
  words: TranscriptWord[];
  speakers: string[];
  unalignedWords: number;
  lowConfidenceRatio: number;
  warnings: string[];
  peakVramMb?: number;
  ms?: number;
}

/** Runs WhisperX. There is no subtitle path — sentence-level VTT timings are
 *  what produced the caption desync this replaces. */
export async function transcribeWithWhisperX(jobDir: string, onLine: (l: string) => void): Promise<void> {
  await runPythonStage("transcribe", jobDir, onLine);
}

const MAX_SEGMENT_SECONDS = 8;
const MAX_SEGMENT_WORDS = 14;
/** A pause this long reads as a sentence boundary. */
const PAUSE_BREAK = 0.7;

/**
 * Groups words into readable segments for the planning LLM. Breaks on speaker
 * change, long pause, sentence punctuation, or length — so a segment never
 * spans two speakers, which would confuse clip selection.
 */
export function wordsToSegments(words: TranscriptWord[]): Segment[] {
  const segments: Segment[] = [];
  let cur: (Segment & { count: number }) | null = null;

  const flush = () => {
    if (cur && cur.text.trim()) {
      const { count, ...seg } = cur;
      seg.text = seg.text.trim();
      seg.textNative = (seg.textNative || "").trim() || undefined;
      segments.push(seg);
    }
    cur = null;
  };

  for (const word of words) {
    const speakerChanged = cur !== null && (cur.speaker ?? null) !== (word.speaker ?? null);
    const pause = cur !== null && word.start - cur.end > PAUSE_BREAK;
    const tooLong = cur !== null && (word.end - cur.start > MAX_SEGMENT_SECONDS || cur.count >= MAX_SEGMENT_WORDS);
    if (cur && (speakerChanged || pause || tooLong)) flush();

    if (!cur) {
      cur = {
        start: word.start,
        end: word.end,
        text: word.w,
        textNative: word.wNative,
        speaker: word.speaker ?? null,
        count: 1,
      };
    } else {
      cur.text += ` ${word.w}`;
      cur.textNative += ` ${word.wNative}`;
      cur.end = word.end;
      cur.count++;
    }

    // end the segment on sentence-final punctuation
    if (cur && /[.!?]$/.test(word.w)) flush();
  }
  flush();
  return segments;
}
