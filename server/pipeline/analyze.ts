import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { Segment } from "./transcribe.js";
import type { ClipPlan, AiProvider, ContentMode, CaptionAnimation, CaptionPalette, LayoutTemplate, MemeOverlay, MemeDisplayMode } from "../jobs.js";

// ─── Lazy singletons ───────────────────────────────────────────────────────────
function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
function getGemini() {
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const OPENAI_MODEL    = process.env.OPENAI_MODEL    || "gpt-4o";
const GEMINI_MODEL    = process.env.GEMINI_MODEL    || "gemini-2.0-flash";

// ─── Low-level text completion per provider ────────────────────────────────────

async function completeAnthropic(prompt: string, maxTokens: number, useWebSearch = false): Promise<string> {
  const client = getAnthropic();
  const tools: any[] = useWebSearch
    ? [{ type: "web_search_20250305" as any, name: "web_search" } as any]
    : [];

  const params: any = {
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (tools.length) params.tools = tools;

  const res = await client.messages.create(params);
  return (res.content as any[])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function completeOpenAI(prompt: string, maxTokens: number): Promise<string> {
  const client = getOpenAI();
  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content ?? "";
}

async function completeGemini(prompt: string): Promise<string> {
  const client = getGemini();
  const res = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
  });
  return res.text ?? "";
}

/** Route a text prompt to the selected provider and return the raw text. */
async function complete(
  provider: AiProvider,
  prompt: string,
  maxTokens: number,
  useWebSearch = false
): Promise<string> {
  switch (provider) {
    case "anthropic": return completeAnthropic(prompt, maxTokens, useWebSearch);
    case "openai":    return completeOpenAI(prompt, maxTokens);
    case "gemini":    return completeGemini(prompt);
    default:          return completeAnthropic(prompt, maxTokens, useWebSearch);
  }
}

// ─── Pipeline steps ────────────────────────────────────────────────────────────

/**
 * Step 1: Research what's currently trending in Indian short-form video.
 * Also incorporates the user's own description / trend notes if provided.
 */
export async function researchTrends(
  topicHint: string,
  provider: AiProvider,
  userDescription: string
): Promise<string> {
  const descriptionSection = userDescription.trim()
    ? `\nUSER-PROVIDED CONTEXT & TRENDS (treat these as high-priority signals):\n${userDescription.trim()}\n`
    : "";

  const prompt = `Research what is trending RIGHT NOW in Indian short-form video (YouTube Shorts, Instagram Reels — Indian audience). Focus on: viral formats, hook styles, caption/edit styles, trending audio vibes, and topics adjacent to: "${topicHint}".${descriptionSection}
Return a compact brief (bullet points, <=300 words) that a video editor can use to make clips more likely to perform in India this week. No preamble.`;

  // Only Anthropic supports web_search tool natively; others get a static prompt
  return complete(provider, prompt, 1500, provider === "anthropic");
}

const VALID_CONTENT_MODES: ContentMode[] = ["funny", "gaming", "political"];
const VALID_ANIMATIONS: CaptionAnimation[] = ["karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split"];
const VALID_PALETTES: CaptionPalette[] = ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"];
export const VALID_LAYOUTS: LayoutTemplate[] = ["fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat", "vignette-pulse", "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout"];
const VALID_MEME_DISPLAYS: MemeDisplayMode[] = ["corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split"];

/**
 * Validate/clamp AI-supplied meme overlays against the (already-clamped)
 * clip duration. Drops anything malformed instead of letting NaN/out-of-range
 * timings reach ffmpeg's filter_complex (which would fail the whole render) —
 * mirrors the "meme failure never fails the job" guarantee that already
 * holds for missing/failed Giphy fetches.
 */
function sanitizeMemes(raw: Partial<MemeOverlay>[] | undefined, clipDuration: number): MemeOverlay[] {
  const out: MemeOverlay[] = [];
  for (const m of raw ?? []) {
    const start = Number(m.start);
    const end = Number(m.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    if (start < 0 || end > clipDuration) continue;
    out.push({
      start,
      end,
      query: m.query ?? "",
      display: VALID_MEME_DISPLAYS.includes(m.display as MemeDisplayMode) ? (m.display as MemeDisplayMode) : "corner-overlay",
    });
  }
  return out;
}

/** Default-fill and clamp every field of a raw AI-returned clip plan. Never throws. */
export function sanitizePlan(p: Partial<ClipPlan> & { index: number }, videoDuration: number): ClipPlan {
  let start = Math.max(0, p.start ?? 0);
  let end = Math.min(videoDuration, p.end ?? start + 25);
  if (end - start > 59) end = start + 58;
  if (end - start < 15) end = Math.min(videoDuration, start + 25);
  const thumbnailTimestamp = Math.min(Math.max(p.thumbnailTimestamp ?? start, start), end);

  return {
    index: p.index,
    title: p.title ?? "",
    hook: p.hook ?? "",
    start,
    end,
    reason: p.reason ?? "",
    script: p.script ?? "",
    hashtags: p.hashtags ?? [],
    thumbnailText: p.thumbnailText ?? "",
    thumbnailTimestamp,
    captions: (p.captions ?? []).filter((c) => c.end > c.start),
    contentMode: VALID_CONTENT_MODES.includes(p.contentMode as ContentMode) ? (p.contentMode as ContentMode) : "funny",
    captionAnimation: VALID_ANIMATIONS.includes(p.captionAnimation as CaptionAnimation) ? (p.captionAnimation as CaptionAnimation) : "karaoke-reveal",
    captionPalette: VALID_PALETTES.includes(p.captionPalette as CaptionPalette) ? (p.captionPalette as CaptionPalette) : "pop-white-red",
    // Strip commas/newlines: this value flows raw into ASS "Style:" lines downstream,
    // where a comma/newline would inject spurious fields or an extra line.
    captionFont: (p.captionFont ?? "Anton").replace(/[,\n\r]/g, ""),
    layoutTemplate: VALID_LAYOUTS.includes(p.layoutTemplate as LayoutTemplate) ? (p.layoutTemplate as LayoutTemplate) : "fullscreen",
    memes: sanitizeMemes(p.memes, end - start),
    monetizationFlag: p.monetizationFlag ?? { risky: false, reasons: [] },
  };
}

/** Build the planClips prompt text. Pure function — no API call — for testability. */
export function buildPlanPrompt(args: {
  transcript: string;
  trendBrief: string;
  descriptionSection: string;
  /** 0 = let the model decide how many genuinely good clips the video supports. */
  clipCount: number;
  videoDuration: number;
  controversialMode: boolean;
  /** Detected transcript language, e.g. "en" or "hi". */
  language?: string;
  /** True when Devanagari was transliterated to Latin (i.e. genuine Hinglish). */
  romanized?: boolean;
  /** Scene-cut timestamps, so the model can pick windows that already align. */
  sceneCuts?: number[];
}): string {
  const monetizationInstruction = args.controversialMode
    ? `Edgy, opinionated, or politically controversial moments are explicitly permitted — the creator has opted in to controversial content.`
    : `Actively avoid clips centered on hate speech, graphic violence, sexual content, harassment, or dangerous misinformation — prefer the next-best safe moment from the transcript instead.`;

  // clipCount 0 = auto. Padding to a fixed number is what makes tools ship
  // filler clips, so in auto mode quality is stated as the binding constraint.
  const auto = args.clipCount <= 0;
  const maxAuto = Math.max(1, Math.min(10, Math.floor(args.videoDuration / 90)));
  const countInstruction = auto
    ? `choose as many clips as this video GENUINELY supports — between 1 and ${maxAuto}.
  Judge each candidate on its own merit: a clip earns its place only if it has a real hook,
  a payoff, and works with no outside context. If the video only supports one strong clip,
  return exactly one. Do NOT pad to reach a number — a weak clip costs the channel more
  than a missing one. State in each clip's "reason" why it clears that bar.`
    : `choose exactly ${args.clipCount} clips`;

  // Source language drives the output register. Forcing Hinglish onto a fully
  // English video reads as inauthentic, and plenty of Indian creators publish
  // entirely in English.
  const lang = (args.language || "en").toLowerCase();
  const hinglish = args.romanized === true || lang.startsWith("hi");
  const languageRule = hinglish
    ? `This video is HINGLISH (Hindi/English code-switching). The transcript is romanized into
  Latin script. Write titles, hooks and hashtags in that same romanized Hinglish register,
  mixing Hindi and English the way the speaker actually does. Never output Devanagari.`
    : `This video is in ${lang.toUpperCase()} and contains no code-switching. Write titles, hooks
  and hashtags in that same language. Do NOT sprinkle in Hindi or Hinglish words — forced
  Hinglish on an English clip reads as inauthentic and hurts reach.`;

  // Steering selection toward real cuts is cheaper than correcting it after,
  // and it improves which moments get picked rather than only where they end.
  const cuts = args.sceneCuts ?? [];
  const cutsSection = cuts.length
    ? `SCENE CUTS (seconds — prefer clip boundaries at or very near these):
${cuts.slice(0, 400).map((c) => c.toFixed(1)).join(", ")}

`
    : "";

  return `You are a viral shorts editor. Primary audience: India.

LANGUAGE (binding — match the source, do not translate):
${languageRule}

${cutsSection}TREND BRIEF (current Indian shorts trends):
${args.trendBrief}
${args.descriptionSection}
FULL VIDEO TRANSCRIPT with [start-end] second timestamps (video duration ${args.videoDuration.toFixed(0)}s):
${args.transcript}

Task: ${countInstruction} for YouTube Shorts. Rules:
- Each clip 20-58 seconds long, must start/end at natural sentence boundaries from the transcript.
- Prioritize moments matching the trend brief AND the creator instructions: strong hooks, emotion, payoff, controversy, "wait for it" moments.
- Clips must not overlap.
- captions: word-grouped caption chunks (2-5 words each) covering the clip's speech, with start/end in seconds RELATIVE TO THE CLIP START, derived from the transcript timing. Wrap the single most important word or short phrase per chunk in **double asterisks** to mark it for visual emphasis (e.g. "this is **insane**").
- contentMode: classify the clip as "funny", "gaming", or "political" based on its content and tone.
- captionAnimation: pick per clip from "karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split" — whichever suits the clip's energy.
- captionPalette: pick per clip from "gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean" — match to contentMode (e.g. gaming -> gaming-neon, political -> news-serious).
- captionFont: pick a bold, high-impact Google Fonts family name appropriate to the palette (e.g. "Anton", "Bebas Neue", "Luckiest Guy", "Archivo Black", "Poppins", "Montserrat").
- layoutTemplate: pick per clip from "fullscreen", "blurred-fill", "meme-corner", "zoom-punch", "shake-on-beat", "vignette-pulse", "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout".
- memes: an array (can be empty) of {start, end, query, display} for moments where a meme/reaction GIF would land well. display is one of "corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split". query is a short search term (e.g. "shocked cat", "mind blown").
- monetizationFlag: {risky: boolean, reasons: string[]} — your honest self-assessment of demonetization risk for this clip's content (hate speech, graphic violence, sexual content, harassment, dangerous misinformation, excessive profanity). ${monetizationInstruction}
- thumbnailTimestamp: an absolute second in the source video with a strong facial expression or key visual for that clip.
- hashtags: 5-8, in the LANGUAGE register defined above; India-relevant only where it fits naturally.
- title: <=90 chars, curiosity-driven, no clickbait lies.
- hook: <=8 words shown on screen for the first 2 seconds.
- script: a 2-3 sentence description of the clip's narrative arc (used for description text).

Respond ONLY with a JSON array of ${auto ? "1 to " + maxAuto : args.clipCount} objects with keys:
index, title, hook, start, end, reason, script, hashtags, thumbnailText, thumbnailTimestamp, captions, contentMode, captionAnimation, captionPalette, captionFont, layoutTemplate, memes, monetizationFlag.
No markdown fences, no commentary.`;
}

/**
 * Step 2: Pick clips and write scripts/captions/hashtags as strict JSON.
 * The userDescription is injected into the prompt for additional creative direction.
 */
export async function planClips(
  transcript: Segment[],
  clipCount: number,
  trendBrief: string,
  videoDuration: number,
  provider: AiProvider,
  userDescription: string,
  controversialMode: boolean,
  language = "en",
  romanized = false,
  sceneCuts: number[] = []
): Promise<ClipPlan[]> {
  const compact = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n")
    .slice(0, 180_000);

  const descriptionSection = userDescription.trim()
    ? `\nADDITIONAL CREATOR INSTRUCTIONS (high priority — incorporate these into clip selection, hooks and scripts):\n${userDescription.trim()}\n`
    : "";

  const prompt = buildPlanPrompt({
    transcript: compact,
    trendBrief,
    descriptionSection,
    clipCount,
    videoDuration,
    controversialMode,
    language,
    romanized,
    sceneCuts,
  });

  const text = (await complete(provider, prompt, 8000))
    .replace(/```json|```/g, "")
    .trim();

  const rawPlans = JSON.parse(text) as (Partial<ClipPlan> & { index: number })[];
  if (!Array.isArray(rawPlans)) throw new Error("planner did not return a JSON array");
  return rawPlans.map((p) => sanitizePlan(p, videoDuration));
}
