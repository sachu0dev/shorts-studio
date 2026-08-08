import { readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { run } from "./download.js";
import type { TranscriptArtifact, TranscriptWord } from "./transcribe.js";

/**
 * YouTube's own caption track as a transcript source.
 *
 * The old rule was "never use platform subtitles" because VTT carries
 * sentence-level timings only, which desynced captions. That reasoning does not
 * apply to the `json3` format: its `segs` carry per-word `tOffsetMs`, so we get
 * word timings without running a model at all.
 *
 * Why bother when WhisperX exists: on a code-switched Hinglish show, YouTube's
 * ASR measurably beats what a 6 GB card can run locally, and it hands us a free
 * English translation track — which both reads better as burned-in captions and
 * gives the planning LLM text it fully understands.
 *
 * ponytail: word timings inside one caption event are evenly spaced by YouTube,
 * not measured. Good enough for 3-4 word caption cards; if per-word karaoke ever
 * looks loose, forced-align this text against the audio instead of re-running ASR.
 */

/** Words shorter than this are still emitted; this only bounds a missing end. */
const MAX_WORD_SECONDS = 2;

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
}

/** Pure parser — the whole reason this is separable from the yt-dlp call. */
export function parseJson3(raw: string): TranscriptWord[] {
  let doc: { events?: Json3Event[] };
  try {
    doc = JSON.parse(raw);
  } catch {
    return [];
  }

  const words: TranscriptWord[] = [];
  for (const ev of doc.events ?? []) {
    if (!ev.segs || typeof ev.tStartMs !== "number") continue;
    const evStart = ev.tStartMs / 1000;
    const evEnd = evStart + (ev.dDurationMs ?? 0) / 1000;
    for (const seg of ev.segs) {
      const text = (seg.utf8 ?? "").trim();
      if (!text) continue; // newline-only spacer events
      const start = evStart + (seg.tOffsetMs ?? 0) / 1000;
      words.push({ w: text, wNative: text, start, end: Math.max(start, evEnd), speaker: null, confidence: null });
    }
  }

  words.sort((a, b) => a.start - b.start);
  // A word ends where the next begins — YouTube gives every seg in an event the
  // event's end, which would overlap them all.
  for (let i = 0; i < words.length; i++) {
    const next = words[i + 1];
    const cap = words[i].start + MAX_WORD_SECONDS;
    words[i].end = Math.min(next ? Math.max(next.start, words[i].start) : words[i].end, cap);
    if (words[i].end <= words[i].start) words[i].end = words[i].start + 0.08;
  }
  return words;
}

/**
 * Fetches one caption track and shapes it like a WhisperX transcript so every
 * downstream stage is unchanged. Returns null when the video has no such track
 * — the caller falls back to WhisperX.
 */
export async function fetchYoutubeCaptions(
  url: string,
  jobDir: string,
  language: string,
  onLine: (l: string) => void,
): Promise<TranscriptArtifact | null> {
  const stem = path.join(jobDir, "ytcaptions");
  try {
    await run("yt-dlp", [
      "--no-playlist", "--skip-download",
      // Manual track preferred; auto-generated is the usual case.
      "--write-subs", "--write-auto-subs",
      "--sub-langs", language,
      "--sub-format", "json3",
      "-o", stem,
      url,
    ], onLine);
  } catch (e) {
    onLine(`caption fetch failed: ${(e as Error).message}`);
    return null;
  }

  const dir = path.dirname(stem);
  const base = path.basename(stem);
  const file = readdirSync(dir).find((f) => f.startsWith(`${base}.`) && f.endsWith(".json3"));
  if (!file) {
    onLine(`no '${language}' caption track published for this video`);
    return null;
  }

  const full = path.join(dir, file);
  const words = parseJson3(readFileSync(full, "utf8"));
  rmSync(full, { force: true });
  if (words.length < 50) {
    onLine(`caption track had only ${words.length} words — ignoring it`);
    return null;
  }

  return {
    schemaVersion: 1,
    language,
    romanized: false,
    modelTier: `youtube-captions/${language}`,
    words,
    // No diarization on this path. Downstream speaker binding already fails
    // soft to ASD alone, which is rule 5 (never block a render on optional data).
    speakers: [],
    unalignedWords: 0,
    lowConfidenceRatio: 0,
    warnings: ["transcript came from YouTube captions — no speaker labels"],
  };
}
