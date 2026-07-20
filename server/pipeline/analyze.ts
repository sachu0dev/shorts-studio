import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import type { Segment } from "./transcribe.js";
import type { ClipPlan, AiProvider } from "../jobs.js";

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
  userDescription: string
): Promise<ClipPlan[]> {
  const compact = transcript
    .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
    .join("\n")
    .slice(0, 180_000);

  const descriptionSection = userDescription.trim()
    ? `\nADDITIONAL CREATOR INSTRUCTIONS (high priority — incorporate these into clip selection, hooks and scripts):\n${userDescription.trim()}\n`
    : "";

  const prompt = `You are a viral shorts editor for the Indian market.

TREND BRIEF (current Indian shorts trends):
${trendBrief}
${descriptionSection}
FULL VIDEO TRANSCRIPT with [start-end] second timestamps (video duration ${videoDuration.toFixed(0)}s):
${compact}

Task: choose exactly ${clipCount} clips for YouTube Shorts. Rules:
- Each clip 20-58 seconds long, must start/end at natural sentence boundaries from the transcript.
- Prioritize moments matching the trend brief AND the creator instructions: strong hooks, emotion, payoff, controversy, "wait for it" moments.
- Clips must not overlap.
- captions: word-grouped caption chunks (2-5 words each) covering the clip's speech, with start/end in seconds RELATIVE TO THE CLIP START, derived from the transcript timing.
- captionStyle: pick per clip from "pop" (bold white + color pop words), "minimal" (clean lower-third), "hype" (big yellow punch-ins) — whichever suits the clip's energy.
- thumbnailTimestamp: an absolute second in the source video with a strong facial expression or key visual for that clip.
- hashtags: 5-8, mix of English + Hindi/Hinglish, India-relevant.
- title: <=90 chars, curiosity-driven, no clickbait lies.
- hook: <=8 words shown on screen for the first 2 seconds.
- script: a 2-3 sentence description of the clip's narrative arc (used for description text).

Respond ONLY with a JSON array of ${clipCount} objects with keys:
index, title, hook, start, end, reason, script, hashtags, captionStyle, thumbnailText, thumbnailTimestamp, captions.
No markdown fences, no commentary.`;

  const text = (await complete(provider, prompt, 8000))
    .replace(/```json|```/g, "")
    .trim();

  const plans = JSON.parse(text) as ClipPlan[];

  // sanity clamps
  for (const p of plans) {
    p.start = Math.max(0, p.start);
    p.end = Math.min(videoDuration, p.end);
    if (p.end - p.start > 59) p.end = p.start + 58;
    if (p.end - p.start < 15) p.end = Math.min(videoDuration, p.start + 25);
    p.thumbnailTimestamp = Math.min(Math.max(p.thumbnailTimestamp, p.start), p.end);
    p.captions = (p.captions || []).filter((c) => c.end > c.start);
  }
  return plans;
}
