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
 * This replaces the old even-split interpolation, which gave every word in a
 * caption group the same duration and was the visible caption desync.
 */
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

  // Real speech leaves short silences between words. Ending each caption on the
  // word's true end makes the text blink out for a frame or two between words,
  // so hold it until the next word starts. Only the START drives sync, so this
  // costs no accuracy — and gaps longer than a beat stay as real pauses.
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
  "news-serious":   { normal: "&H00F0F0F0", punch: "&H00E0E0E0", outline: "&H00202020", back: "&HB4000000" },
  "hype-yellow":    { normal: "&H0000FFFF", punch: "&H000000FF", outline: "&H00000000", back: "&H96000000" },
  "pop-white-red":  { normal: "&H00FFFFFF", punch: "&H000000FF", outline: "&H00000000", back: "&H96000000" },
  "minimal-clean":  { normal: "&H00FFFFFF", punch: "&H00FFFFFF", outline: "&H00000000", back: "&HB4000000" },
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
