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
