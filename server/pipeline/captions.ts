import type { CaptionAnimation, CaptionPalette } from "../jobs.js";
import type { TranscriptWord } from "./transcribe.js";

export interface EmphasisWord {
  word: string;
  punch: boolean;
}

export interface TimedWord extends EmphasisWord {
  start: number;
  end: number;
}

/** Strip **markers** from caption text and flag which words were emphasized. */
export function parseEmphasis(text: string): EmphasisWord[] {
  const tokens: EmphasisWord[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  for (const part of parts) {
    const isPunch = part.startsWith("**") && part.endsWith("**");
    const clean = isPunch ? part.slice(2, -2) : part;
    for (const word of clean.trim().split(/\s+/).filter(Boolean)) {
      tokens.push({ word, punch: isPunch });
    }
  }
  return tokens;
}

/** Compare words ignoring case and surrounding punctuation. */
function norm(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Real word timings from the transcript, clipped to the plan's window and made
 * clip-relative. The LLM no longer supplies timings — only which words to
 * emphasize — so its **punch** marks are matched onto the aligned words.
 *
 */
export interface PhraseGroup {
  words: TimedWord[];
  start: number;
  end: number;
}

/**
 * Groups 1-word aligned tokens into readable 3-4 word phrase cards.
 * Breaks on punctuation (. ! ? ,), pauses (> 0.4s), or reaching 4 words.
 *
 * Punctuation/pause only close a group once it has `MIN_WORDS` — otherwise a
 * word that happens to open a new group AND end in a comma (extremely common
 * in natural speech) becomes its own orphaned one-word card, on screen for a
 * flash and disconnected from the sentence around it. Measured on a real
 * 19-clip batch: 37.7% of all cards were a single word before this guard.
 * `maxWords` still closes unconditionally so a group can never grow unbounded.
 */
export function groupWordsIntoPhrases(words: TimedWord[], maxWords = 4): PhraseGroup[] {
  const MIN_WORDS = 2;
  const groups: PhraseGroup[] = [];
  let current: TimedWord[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    current.push(w);

    const prev = current[current.length - 2];
    const pause = prev ? w.start - prev.end > 0.4 : false;
    const punct = /[.!?,]$/.test(w.word);
    const full = current.length >= maxWords;
    const last = i === words.length - 1;

    if (full || last || ((pause || punct) && current.length >= MIN_WORDS)) {
      const gStart = current[0].start;
      let gEnd = current[current.length - 1].end;
      const nextWord = words[i + 1];
      if (nextWord && (nextWord.start - gEnd) <= HOLD_THROUGH_GAP) {
        gEnd = nextWord.start;
      }
      groups.push({ words: [...current], start: gStart, end: gEnd });
      current = [];
    }
  }
  return groups;
}

/** Real word timings from the transcript, clipped to the plan's window and made clip-relative. */
export function wordsForClip(
  words: TranscriptWord[],
  plan: { start: number; end: number; captions: { text: string }[] }
): TimedWord[] {
  const punches = new Set<string>();
  for (const group of plan.captions ?? []) {
    for (const w of parseEmphasis(group.text)) {
      if (w.punch) punches.add(norm(w.word));
    }
  }

  const dur = plan.end - plan.start;
  const out: TimedWord[] = [];
  for (const w of words) {
    if (w.end <= plan.start || w.start >= plan.end) continue;
    const start = Math.max(0, w.start - plan.start);
    const end = Math.min(dur, w.end - plan.start);
    if (end <= start) continue;
    out.push({ word: w.w, punch: punches.has(norm(w.w)), start, end });
  }

  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].start - out[i].end;
    if (gap > 0 && gap <= HOLD_THROUGH_GAP) out[i].end = out[i + 1].start;
  }
  return out;
}

/** Silences shorter than this are held through rather than shown as a blank. */
const HOLD_THROUGH_GAP = 0.5;

/** ASS colors are &HAABBGGRR (alpha, blue, green, red — note the reversed order). */
export const PALETTES: Record<CaptionPalette, { normal: string; punch: string; outline: string; back: string }> = {
  "gaming-neon":    { normal: "&H00FFFFFF", punch: "&H00FF00D7", outline: "&H00000000", back: "&H96000000" },
  "meme-comic":     { normal: "&H00FFFFFF", punch: "&H000080FF", outline: "&H00000000", back: "&H96000000" },
  "news-serious":   { normal: "&H00F0F0F0", punch: "&H0000FFFF", outline: "&H00202020", back: "&HB4000000" },
  "hype-yellow":    { normal: "&H00FFFFFF", punch: "&H0000FFFF", outline: "&H00000000", back: "&H96000000" },
  "pop-white-red":  { normal: "&H00FFFFFF", punch: "&H000000FF", outline: "&H00000000", back: "&H96000000" },
  "minimal-clean":  { normal: "&H00FFFFFF", punch: "&H0000FFFF", outline: "&H00000000", back: "&HB4000000" },
};

/** Build the ASS override-tag block ({...}) for one word event. */
export function buildWordOverrideTags(
  word: TimedWord,
  animation: CaptionAnimation,
  palette: CaptionPalette
): string {
  const colors = PALETTES[palette];
  const colorTag = word.punch ? `\\c${colors.punch}` : `\\c${colors.normal}`;
  const punchScale = word.punch ? "\\fscx135\\fscy135" : "";

  switch (animation) {
    case "karaoke-reveal":
      return `{${colorTag}${punchScale}\\fad(50,0)}`;
    case "punch-scale-bounce":
      return word.punch
        ? `{${colorTag}\\t(0,120,\\fscx145\\fscy145)\\t(120,220,\\fscx100\\fscy100)}`
        : `{${colorTag}}`;
    case "typewriter":
      return `{${colorTag}${punchScale}}`; // no \fad — instant cut-in
    case "slide-up":
      return `{${colorTag}${punchScale}\\move(540,1000,540,940,0,120)}`;
    case "shake":
      return word.punch
        ? `{${colorTag}\\t(0,60,\\frz-4)\\t(60,120,\\frz4)\\t(120,180,\\frz0)}`
        : `{${colorTag}\\t(0,60,\\frz-2)\\t(60,120,\\frz2)\\t(120,180,\\frz0)}`;
    case "glitch-rgb-split":
      return `{${colorTag}${punchScale}\\1c&H00FF00\\3c&H00FFFF\\fad(0,40)}`;
    default:
      return `{${colorTag}}`;
  }
}

/** One [V4+ Styles] "Style:" line for a given palette+font+size. */
export function buildStyleLine(palette: CaptionPalette, font: string, fontsize: number): string {
  const c = PALETTES[palette];
  return `Style: Cap,${font},${fontsize},${c.normal},&H000000FF,${c.outline},${c.back},-1,0,0,0,100,100,0,0,1,5,2,2,60,60,260,1`;
}
