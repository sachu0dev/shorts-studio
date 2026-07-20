import type { CaptionAnimation, CaptionPalette } from "../jobs.js";

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

/**
 * Split a transcript-timed caption group into per-word events, linearly
 * interpolating each word's sub-timestamp across the group's window.
 *
 * ponytail: no real per-word alignment exists from platform subtitles —
 * this is an even-split approximation. Upgrade path: forced alignment
 * (e.g. whisper word timestamps) if visual quality demands tighter sync.
 */
export function splitWordsWithTiming(group: { start: number; end: number; text: string }): TimedWord[] {
  const words = parseEmphasis(group.text);
  if (words.length === 0) return [];
  const slice = (group.end - group.start) / words.length;
  return words.map((w, i) => ({
    ...w,
    start: group.start + i * slice,
    end: group.start + (i + 1) * slice,
  }));
}

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
