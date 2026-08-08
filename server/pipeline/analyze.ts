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
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-4-26b-a4b-it:free";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "llama-3.3-70b";

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

async function completeOpenAiCompatible(
  apiKey: string,
  baseURL: string,
  model: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const client = new OpenAI({ apiKey, baseURL });
  const res = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return res.choices[0]?.message?.content ?? "";
}

async function completeGroq(prompt: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured in .env");
  return completeOpenAiCompatible(apiKey, "https://api.groq.com/openai/v1", GROQ_MODEL, prompt, maxTokens);
}

async function completeOpenRouter(prompt: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured in .env");
  return completeOpenAiCompatible(apiKey, "https://openrouter.ai/api/v1", OPENROUTER_MODEL, prompt, maxTokens);
}

async function completeCerebras(prompt: string, maxTokens: number): Promise<string> {
  const apiKey = process.env.CEREBRAS_API_KEY || process.env.CERABRAS_API_KEY;
  if (!apiKey) throw new Error("CEREBRAS_API_KEY / CERABRAS_API_KEY is not configured in .env");
  return completeOpenAiCompatible(apiKey, "https://api.cerebras.ai/v1", CEREBRAS_MODEL, prompt, maxTokens);
}

/**
 * Format raw transcript segments into clean, sentence-grouped narrative blocks.
 * Prevents LLMs (especially 7B local models) from making micro-timestamp errors or random cuts.
 */
export function formatTranscriptForPlanning(transcript: Segment[]): string {
  const totalDuration = (transcript[transcript.length - 1]?.end ?? 0) - (transcript[0]?.start ?? 0);
  const targetWindow = totalDuration > 600 ? 15 : 10;
  const blocks: { start: number; end: number; text: string }[] = [];
  let current: { start: number; end: number; text: string } | null = null;

  for (const s of transcript) {
    const text = s.text.trim();
    if (!text) continue;
    if (!current) {
      current = { start: s.start, end: s.end, text };
    } else {
      current.text += " " + text;
      current.end = s.end;
    }

    const isSentenceEnd = /[.!?]$/.test(text);
    const duration = current.end - current.start;
    if ((isSentenceEnd && duration >= 5) || duration >= targetWindow) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);

  return blocks
    .map((b) => `[${b.start.toFixed(1)}s - ${b.end.toFixed(1)}s] ${b.text}`)
    .join("\n");
}

  // ─── Windowed transcript splitting for Ollama ──────────────────────────────────

  export interface TranscriptWindow {
    text: string;
    startTime: number;
    endTime: number;
    windowIndex: number;
    totalWindows: number;
  }

  /**
   * Splits a formatted transcript into overlapping windows that each fit inside
   * Ollama's context budget. Splits only at line boundaries (between sentence
   * blocks), never mid-block.
   *
   * A transcript shorter than `maxChars` returns a single window — no regression
   * for short videos.
   */
  export function splitTranscriptWindows(
    formatted: string,
    maxChars: number = 10_000,
    overlapChars: number = 2_500
  ): TranscriptWindow[] {
    if (formatted.length <= maxChars) {
      const startTime = parseBlockTime(formatted, "start");
      const endTime = parseBlockTime(formatted, "end");
      return [{ text: formatted, startTime, endTime, windowIndex: 0, totalWindows: 1 }];
    }

    const lines = formatted.split("\n");
    const windows: TranscriptWindow[] = [];
    let lineIdx = 0;

    while (lineIdx < lines.length) {
      let charCount = 0;
      let endLineIdx = lineIdx;
      while (endLineIdx < lines.length) {
        const lineLen = lines[endLineIdx].length + 1; // +1 for \n
        if (charCount + lineLen > maxChars && endLineIdx > lineIdx) break;
        charCount += lineLen;
        endLineIdx++;
      }

      const windowLines = lines.slice(lineIdx, endLineIdx);
      const text = windowLines.join("\n");
      const startTime = parseBlockTime(text, "start");
      const endTime = parseBlockTime(text, "end");
      windows.push({ text, startTime, endTime, windowIndex: windows.length, totalWindows: 0 });

      if (endLineIdx >= lines.length) break;

      let overlapCount = 0;
      let overlapStart = endLineIdx;
      for (let i = endLineIdx - 1; i > lineIdx; i--) {
        overlapCount += lines[i].length + 1;
        if (overlapCount >= overlapChars) {
          overlapStart = i;
          break;
        }
      }
      lineIdx = overlapStart;
    }

    for (const w of windows) w.totalWindows = windows.length;
    return windows;
  }

  /** Extract the first or last timestamp from formatted transcript blocks. */
  function parseBlockTime(text: string, edge: "start" | "end"): number {
    if (edge === "start") {
      const m = text.match(/\[(\d+\.\d+)s/);
      return m ? parseFloat(m[1]) : 0;
    }
    const matches = [...text.matchAll(/- (\d+\.\d+)s\]/g)];
    return matches.length ? parseFloat(matches[matches.length - 1][1]) : 0;
  }

  /**
   * Deduplicates clips from overlapping windows. Two clips overlap when their
   * time intersection exceeds 50% of the shorter clip's duration. When they
   * do, the longer clip wins. Result is sorted by start time and re-indexed.
   */
  export function mergeWindowedPlans(allPlans: ClipPlan[]): ClipPlan[] {
    if (allPlans.length <= 1) return allPlans;

    const sorted = [...allPlans].sort((a, b) => a.start - b.start);
    const kept: ClipPlan[] = [];

    for (const clip of sorted) {
      const dominated = kept.findIndex((existing) => {
        const overlapStart = Math.max(existing.start, clip.start);
        const overlapEnd = Math.min(existing.end, clip.end);
        const intersection = Math.max(0, overlapEnd - overlapStart);
        const shorter = Math.min(existing.end - existing.start, clip.end - clip.start);
        return shorter > 0 && intersection / shorter > 0.5;
      });

      if (dominated >= 0) {
        const existing = kept[dominated];
        const existingDur = existing.end - existing.start;
        const clipDur = clip.end - clip.start;
        if (clipDur > existingDur) {
          kept[dominated] = clip;
        }
      } else {
        kept.push(clip);
      }
    }

    return kept.map((p, i) => ({ ...p, index: i + 1 }));
  }

  /**
   * How large a transcript chunk each provider gets before `planClips` splits
   * it into windows. Ollama/Groq are real context-budget limits; the cloud
   * providers could swallow the whole thing in one call, but this is deliberately
   * far smaller than their actual limits — it exists to force a genuine
   * per-section pass over long dense videos, not to avoid an error.
   */
  function maxCharsForProvider(provider: AiProvider): number {
    switch (provider) {
      case "ollama": return 10_000;
      case "groq": return 7_000;
      default: return 12_000;
    }
  }

  /** Estimate tokens and choose the optimal power-of-2 context window for Ollama */
  function calculateDynamicContextSize(prompt: string, maxTokens: number): number {
    const estimatedInputTokens = Math.ceil(prompt.length / 3.8);
    const totalNeeded = estimatedInputTokens + maxTokens + 512;
    if (totalNeeded <= 4096) return 4096;
    if (totalNeeded <= 8192) return 8192;
    return 12288;
  }

  /** JSON schema for Ollama structured output — forces the model to produce exactly this shape. */
  const CLIP_PLAN_JSON_SCHEMA = {
    type: "array" as const,
    items: {
      type: "object" as const,
      properties: {
        index: { type: "number" as const },
        title: { type: "string" as const },
        hook: { type: "string" as const },
        start: { type: "number" as const },
        end: { type: "number" as const },
        reason: { type: "string" as const },
        script: { type: "string" as const },
        hashtags: { type: "array" as const, items: { type: "string" as const } },
        thumbnailText: { type: "string" as const },
        thumbnailTimestamp: { type: "number" as const },
        captions: { type: "array" as const, items: { type: "object" as const, properties: { start: { type: "number" as const }, end: { type: "number" as const }, text: { type: "string" as const } }, required: ["start", "end", "text"] } },
        contentMode: { type: "string" as const, enum: ["funny", "gaming", "political"] },
        captionAnimation: { type: "string" as const, enum: ["karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split"] },
        captionPalette: { type: "string" as const, enum: ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"] },
        captionFont: { type: "string" as const },
        layoutTemplate: { type: "string" as const, enum: ["fullscreen", "blurred-fill", "meme-corner", "vignette-pulse", "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout"] },
        memes: { type: "array" as const, items: { type: "object" as const, properties: { start: { type: "number" as const }, end: { type: "number" as const }, query: { type: "string" as const }, display: { type: "string" as const, enum: ["corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split"] } }, required: ["start", "end", "query", "display"] } },
        monetizationFlag: { type: "object" as const, properties: { risky: { type: "boolean" as const }, reasons: { type: "array" as const, items: { type: "string" as const } } }, required: ["risky", "reasons"] },
      },
      required: ["index", "title", "hook", "start", "end", "reason", "script", "hashtags", "thumbnailText", "thumbnailTimestamp", "captions", "contentMode", "captionAnimation", "captionPalette", "captionFont", "layoutTemplate", "memes", "monetizationFlag"],
    },
  };

  /**
   * Call Ollama's native /api/chat.
   * For clip planning (isClipPlan: true), enforces strict structured JSON schema.
   * For general prompts (isClipPlan: false, like trend research), outputs plain text.
   */
  async function completeOllama(
    prompt: string,
    maxTokens: number,
    opts: { isClipPlan?: boolean; useSchema?: boolean } = {}
  ): Promise<string> {
    const isClipPlan = opts.isClipPlan ?? false;
    const useSchema = opts.useSchema ?? true;
    const cappedMaxTokens = Math.min(maxTokens, 2048);
    const numCtx = calculateDynamicContextSize(prompt, cappedMaxTokens);
    const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/v1\/?$/, "");

    const body: Record<string, unknown> = {
      model: OLLAMA_MODEL,
      stream: false,
      keep_alive: "0s",
      options: {
        num_ctx: numCtx,
        num_predict: cappedMaxTokens,
        temperature: isClipPlan ? 0.3 : 0.7,
        top_p: 0.85,
        top_k: 30,
        num_gpu: 99,
      },
      messages: [
        {
          role: "system",
          content: isClipPlan
            ? "You are Qwen 2.5, a master short-form video editor for YouTube Shorts and Reels. You MUST respond with ONLY a valid JSON array of clip objects. No text before or after the JSON. Every field must be present."
            : "You are Qwen 2.5, a master video editor researching current viral short-form video trends. Provide a concise, bulleted text summary.",
        },
        { role: "user", content: prompt },
      ],
    };

    if (isClipPlan) {
      body.format = useSchema ? CLIP_PLAN_JSON_SCHEMA : "json";
    }

    console.log(`[ollama] Requesting ${OLLAMA_MODEL} num_ctx=${numCtx} num_predict=${cappedMaxTokens} isClipPlan=${isClipPlan} schema=${useSchema}`);

    const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 minute hard timeout
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Ollama /api/chat error ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as { message?: { content?: string }; total_duration?: number; eval_count?: number };
    const content = data.message?.content ?? "";
    const durationSec = data.total_duration ? (data.total_duration / 1e9).toFixed(1) : "?";
    const tokens = data.eval_count ?? "?";

    if (!content.trim()) {
      throw new Error("Ollama returned an empty response — model may have run out of context or stalled.");
    }

    console.log(`[ollama] Got ${content.length} chars, ${tokens} tokens in ${durationSec}s`);
    return content;
  }

  /** Fetch live search results for current internet trends. */
  async function fetchWebTrendSnippets(query: string): Promise<string[]> {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(3000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
      if (!res.ok) return [];
      const html = await res.text();
      const snippets = [...html.matchAll(/<a class="result__snippet[^>]*>(.*?)<\/a>/g)]
        .map((m) =>
          m[1]
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&#x27;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim()
        )
        .filter((s) => s.length > 20);
      return snippets.slice(0, 5);
    } catch {
      return [];
    }
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
      case "openai": return completeOpenAI(prompt, maxTokens);
      case "gemini": return completeGemini(prompt);
      case "ollama": return completeOllama(prompt, maxTokens);
      case "groq": return completeGroq(prompt, maxTokens);
      case "openrouter": return completeOpenRouter(prompt, maxTokens);
      case "cerebras": return completeCerebras(prompt, maxTokens);
      default: return completeAnthropic(prompt, maxTokens, useWebSearch);
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

    let liveSearchSection = "";
    if (provider !== "anthropic") {
      const snippets = await fetchWebTrendSnippets(`trending Indian short form video reels shorts 2026 ${topicHint}`);
      if (snippets.length > 0) {
        liveSearchSection = `\nLIVE INTERNET TREND RESULTS (Fetched real-time from web search):\n${snippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
      }
    }

    const prompt = `Research what is trending RIGHT NOW in Indian short-form video (YouTube Shorts, Instagram Reels — Indian audience). Focus on: viral formats, hook styles, caption/edit styles, trending audio vibes, and topics adjacent to: "${topicHint}".${descriptionSection}${liveSearchSection}
Return a compact brief (bullet points, <=300 words) that a video editor can use to make clips more likely to perform in India this week. No preamble.`;

    return complete(provider, prompt, 1500, provider === "anthropic");
  }

  const VALID_CONTENT_MODES: ContentMode[] = ["funny", "gaming", "political"];
  const VALID_ANIMATIONS: CaptionAnimation[] = ["karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split"];
  const VALID_PALETTES: CaptionPalette[] = ["gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean"];
  export const VALID_LAYOUTS: LayoutTemplate[] = ["fullscreen", "blurred-fill", "meme-corner", "vignette-pulse", "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout"];
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
    // Raised from a 59s hard cap: a full comedy bit or talent-show performance
    // routinely needs more room than a single joke does, and YouTube Shorts
    // itself allows up to 180s — 118s leaves headroom under the prompt's own
    // stated 20-110s range instead of clamping right at its edge.
    if (end - start > 120) end = start + 118;
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
    /** When running windowed planning, provides window index & timestamp range. */
    windowContext?: { index: number; total: number; startTime: number; endTime: number };
    /**
     * Windowed planning only: compute the auto min/max range from this
     * section's own duration rather than the whole video's. A 15-minute
     * slice of a 90-minute show shouldn't be told to find as many clips as
     * the entire show — each window gets its own proportional range instead.
     */
    autoRangeDuration?: number;
  }): string {
    const monetizationInstruction = args.controversialMode
      ? `Edgy, opinionated, or politically controversial moments are explicitly permitted — the creator has opted in to controversial content.`
      : `Actively avoid clips centered on hate speech, graphic violence, sexual content, harassment, or dangerous misinformation — prefer the next-best safe moment from the transcript instead.`;

    const windowHeader = args.windowContext
      ? `WINDOW CONTEXT: You are analyzing SECTION ${args.windowContext.index} OF ${args.windowContext.total} (${args.windowContext.startTime.toFixed(0)}s–${args.windowContext.endTime.toFixed(0)}s of the total ${args.videoDuration.toFixed(0)}s video).\nOnly pick clips that fall inside this section's transcript timestamps.\n\n`
      : "";

    const auto = args.clipCount <= 0;
    // Aggressive extraction: roughly 1 clip per 90s of material, up to 30 —
    // dense comedy/panel formats (roast shows, talk shows) genuinely support
    // that many standalone moments and a hard cap of 15 was leaving real
    // moments on the table for anything over ~9 minutes of dense material.
    const rangeBasis = args.autoRangeDuration ?? args.videoDuration;
    const maxAuto = Math.max(2, Math.min(30, Math.floor(rangeBasis / 90)));
    const minAuto = Math.min(maxAuto, Math.max(1, Math.floor(rangeBasis / 240)));
    const countInstruction = auto
      ? `HIGH EXTRACTION EFFORT: Thoroughly scan this ENTIRE section from start to finish, not just the first minute. High-density content (stand-up, roast/panel comedy, gaming streams, podcasts, talk shows) contains MULTIPLE hilarious jokes, bits, and viral moments spread evenly throughout — not clustered near the start. Extract ALL top-tier standalone moments you find here — return between ${minAuto} and ${maxAuto} distinct clips. Never pad the count with mediocre filler to hit the range, and never stop early because you found one or two: a section with more genuine moments than ${maxAuto} should still return ${maxAuto} of the strongest ones, and a quiet section should return fewer than ${minAuto} if that is honestly all there is.`
      : `choose exactly ${args.clipCount} clips`;

    const lang = (args.language || "en").toLowerCase();
    const hinglish = args.romanized === true || lang.startsWith("hi");
    const languageRule = hinglish
      ? `This video is HINGLISH (Hindi/English code-switching). The transcript is romanized into
  Latin script. Write titles, hooks and hashtags in that same romanized Hinglish register,
  mixing Hindi and English the way the speaker actually does. Never output Devanagari.`
      : `This video is in ${lang.toUpperCase()} and contains no code-switching. Write titles, hooks
  and hashtags in that same language. Do NOT sprinkle in Hindi or Hinglish words — forced
  Hinglish on an English clip reads as inauthentic and hurts reach.`;
    const hinglishComedyRule = hinglish
      ? `\n6. HINGLISH COMEDIC TIMING: in this code-switched Hindi/English delivery, the punchline is frequently the language switch itself, or wordplay that only works in that mix — do not undervalue a moment just because it doesn't translate cleanly to English. Judge it the way the live room reacted, not the way it reads as plain English text.`
      : "";

    const cuts = args.sceneCuts ?? [];
    const cutsSection = cuts.length
      ? `SCENE CUTS (seconds — prefer clip boundaries at or very near these):
${cuts.slice(0, 80).map((c) => c.toFixed(1)).join(", ")}

`
      : "";

    return `You are a master short-form video editor for YouTube Shorts and Instagram Reels.

${windowHeader}LANGUAGE (binding — match the source, do not translate):
${languageRule}

CRITICAL EDITING & CLIP SELECTION RULES:
1. STRICT NARRATIVE ARC: Every selected clip MUST tell a complete standalone story (Hook at 0s-3s -> Setup -> Main Payoff/Punchline -> Natural Conclusion).
2. ZERO MID-SENTENCE CUTS: Start and end every clip ONLY at natural sentence boundaries matching the [start s - end s] blocks in the transcript below. NEVER cut off mid-thought or mid-sentence.
3. HIGH-RETENTION SELECTION: Select high-energy, viral-worthy, funny, surprising, or deeply informative moments. Skip boring small-talk, greetings, or filler transitions.
4. THOROUGH TRANSCRIPT COVERAGE: Stand-up comedy, podcasts, and talk shows have punchlines throughout the whole video. Extract clips from early, middle, and late sections of the video.
5. ROAST/PANEL/JUDGE-SHOW FORMATS: on shows built around judges, contestants, and a live audience, the funniest moment is very often an EXCHANGE, not a single person's line — a judge's roast, the contestant's comeback, a co-judge piling on, a group reaction. Read across speaker turns for the whole bit, not just the one sentence that sounds punchy in isolation. A one-liner that lands because of what was said 10 seconds earlier needs both halves in the clip.${hinglishComedyRule}

${cutsSection}TREND BRIEF (current Indian shorts trends):
${args.trendBrief}
${args.descriptionSection}
FULL VIDEO TRANSCRIPT IN SENTENCE BLOCKS [start s - end s] (video duration ${args.videoDuration.toFixed(0)}s):
${args.transcript}

Task: ${countInstruction} for YouTube Shorts. Rules:
- Each clip 20-110 seconds long, starting and ending precisely at sentence boundaries from the transcript blocks. A full comedy bit, performance, or story with a real beginning/middle/end is allowed to run the full length rather than being cut short for time.
- Clips must not overlap.
- captions: optional array of key phrase strings with **punch words** wrapped in double asterisks for visual emphasis (e.g. ["this is **insane**"]). Keep captions brief or empty — exact word timings are extracted automatically by Node.
- contentMode: classify the clip as "funny", "gaming", or "political" based on its content and tone.
- captionAnimation: pick per clip from "karaoke-reveal", "punch-scale-bounce", "typewriter", "slide-up", "shake", "glitch-rgb-split" — whichever suits the clip's energy.
- captionPalette: pick per clip from "gaming-neon", "meme-comic", "news-serious", "hype-yellow", "pop-white-red", "minimal-clean" — match to contentMode (e.g. gaming -> gaming-neon, political -> news-serious).
- captionFont: pick a bold, high-impact Google Fonts family name appropriate to the palette (e.g. "Anton", "Bebas Neue", "Luckiest Guy", "Archivo Black", "Poppins", "Montserrat").
- layoutTemplate: pick per clip from "fullscreen", "blurred-fill", "meme-corner", "vignette-pulse", "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout".
- memes: an array (can be empty) of {start, end, query, display} for moments where a meme/reaction GIF would land well. display is one of "corner-overlay", "full-cutaway", "pip-bounce", "sticker-pop", "side-by-side-split". query is a short search term (e.g. "shocked cat", "mind blown").
- monetizationFlag: {risky: boolean, reasons: string[]} — your honest self-assessment of demonetization risk for this clip's content (hate speech, graphic violence, sexual content, harassment, dangerous misinformation, excessive profanity). ${monetizationInstruction}
- thumbnailTimestamp: an absolute second in the source video with a strong facial expression or key visual for that clip.
- hashtags: 5-8, in the LANGUAGE register defined above; India-relevant only where it fits naturally.
- title: <=90 chars, curiosity-driven, no clickbait lies.
- hook: <=8 words shown on screen for the first 2 seconds.
- script: a 2-3 sentence description of the clip's narrative arc (used for description text).

Respond ONLY with a JSON array of ${auto ? minAuto + " to " + maxAuto : args.clipCount} objects with keys:
index, title, hook, start, end, reason, script, hashtags, thumbnailText, thumbnailTimestamp, captions, contentMode, captionAnimation, captionPalette, captionFont, layoutTemplate, memes, monetizationFlag.
No markdown fences, no commentary.`;
  }

  function repairJson(str: string): string {
    let s = str.trim().replace(/,\s*$/, "");
    let openBrackets = 0;
    let openBraces = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < s.length; i++) {
      const char = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === "[") openBrackets++;
        else if (char === "]") openBrackets = Math.max(0, openBrackets - 1);
        else if (char === "{") openBraces++;
        else if (char === "}") openBraces = Math.max(0, openBraces - 1);
      }
    }

    if (inString) s += '"';
    s = s.replace(/,\s*$/, "");

    while (openBraces > 0 || openBrackets > 0) {
      s = s.replace(/,\s*$/, "");
      if (openBraces > 0 && (openBrackets === 0 || s.lastIndexOf("{") > s.lastIndexOf("["))) {
        s += "}";
        openBraces--;
      } else if (openBrackets > 0) {
        s += "]";
        openBrackets--;
      }
    }

    return s.replace(/,\s*([\]}])/g, "$1");
  }

  function extractJsonArray(text: string): string {
    let cleaned = text.replace(/```json|```/g, "").trim();
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");

    // 1. Direct parse attempt
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) return cleaned;
      if (parsed && typeof parsed === "object") {
        const arr = Object.values(parsed).find(Array.isArray);
        if (arr) return JSON.stringify(arr);
      }
    } catch { }

    // 2. Find array starting with [{ (array of clip objects)
    const matchObjArray = cleaned.match(/\[\s*\{[\s\S]*/);
    if (matchObjArray) {
      const candidate = matchObjArray[0];
      const lastBracket = candidate.lastIndexOf("]");
      const subStr = lastBracket !== -1 ? candidate.slice(0, lastBracket + 1) : candidate;
      try {
        const parsed = JSON.parse(subStr.replace(/,\s*([\]}])/g, "$1"));
        if (Array.isArray(parsed)) return JSON.stringify(parsed);
      } catch {
        try {
          const repaired = repairJson(subStr);
          const parsed = JSON.parse(repaired);
          if (Array.isArray(parsed)) return JSON.stringify(parsed);
        } catch { }
      }
    }

    // 3. Fallback to generic bracket search
    const arrStart = cleaned.indexOf("[");
    const arrEnd = cleaned.lastIndexOf("]");
    if (arrStart !== -1) {
      const subStr = arrEnd > arrStart ? cleaned.slice(arrStart, arrEnd + 1) : cleaned.slice(arrStart);
      try {
        const repaired = repairJson(subStr);
        return repaired;
      } catch { }
    }

    return repairJson(cleaned);
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
    const formatted = formatTranscriptForPlanning(transcript);

    let creatorBackgroundSection = "";
    const searchQuery = userDescription.trim() || transcript.slice(0, 3).map((s) => s.text).join(" ").slice(0, 100);
    if (searchQuery) {
      const bgSnippets = await fetchWebTrendSnippets(`${searchQuery} creator background context viral`);
      if (bgSnippets.length > 0) {
        creatorBackgroundSection = `\nCREATOR & TOPIC BACKGROUND (Real-time web research):\n${bgSnippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`;
      }
    }

    const descriptionSection = userDescription.trim() || creatorBackgroundSection
      ? `\nADDITIONAL CREATOR INSTRUCTIONS & CONTEXT (high priority — incorporate these into clip selection, hooks and scripts):\n${userDescription.trim()}${creatorBackgroundSection}\n`
      : "";

    // ── Windowed planning for every provider ──────────────────────────────────
    // Originally Ollama/Groq-only (real context-budget limits). Cloud APIs have
    // room to take the whole transcript in one call, but a single call over a
    // long dense video (a 50+ minute panel show) is exactly how real moments
    // get missed — one pass either clusters near the start or thins out picks
    // across material it never really re-reads. Windowing forces a genuine
    // per-section pass regardless of provider; short/typical videos still fit
    // one window and take the old single-call path unchanged.
    const maxChars = maxCharsForProvider(provider);
    if (formatted.length > maxChars) {
      const windows = splitTranscriptWindows(formatted, maxChars);
      console.log(`[planClips] ${provider} windowed planning: ${windows.length} window(s) over ${formatted.length} chars (maxChars=${maxChars})`);

      const allPlans: ClipPlan[] = [];
      for (const win of windows) {
        // Fixed clipCount: divide the total across windows proportionally.
        // Auto mode: let each window find its own range from its own
        // duration — forcing an exact per-window quota was padding out
        // mediocre picks in quiet windows to hit the number.
        const windowDuration = win.endTime - win.startTime;
        const clipsPerWindow = clipCount > 0 ? Math.max(1, Math.round(clipCount / windows.length)) : 0;

        const prompt = buildPlanPrompt({
          transcript: win.text,
          trendBrief,
          descriptionSection,
          clipCount: clipsPerWindow,
          videoDuration,
          controversialMode,
          language,
          romanized,
          sceneCuts: sceneCuts.filter((c) => c >= win.startTime && c <= win.endTime),
          windowContext: windows.length > 1
            ? { index: win.windowIndex + 1, total: win.totalWindows, startTime: win.startTime, endTime: win.endTime }
            : undefined,
          autoRangeDuration: clipsPerWindow > 0 ? undefined : windowDuration,
        });

        console.log(`[planClips] [${provider}] window ${win.windowIndex + 1}/${win.totalWindows}: ${win.startTime.toFixed(0)}s–${win.endTime.toFixed(0)}s (${win.text.length} chars${clipsPerWindow > 0 ? `, asking for ${clipsPerWindow} clips` : ", auto range"})`);

        let windowPlans: ClipPlan[] = [];
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            let rawText: string;
            if (provider === "ollama") {
              const useSchema = attempt < 3;
              rawText = await completeOllama(prompt, 2048, { isClipPlan: true, useSchema });
            } else if (provider === "groq") {
              rawText = await completeGroq(prompt, 2048);
            } else {
              rawText = await complete(provider, prompt, 8000);
            }
            const jsonString = extractJsonArray(rawText);
            const rawPlans = JSON.parse(jsonString) as (Partial<ClipPlan> & { index: number })[];
            if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
              throw new Error("empty or non-array response");
            }
            windowPlans = rawPlans.map((p, i) => sanitizePlan({ ...p, index: i + 1 }, videoDuration));
            console.log(`[planClips] [${provider}] window ${win.windowIndex + 1}: ${windowPlans.length} clip(s) found`);
            break;
          } catch (err: any) {
            lastError = err;
            console.error(`[planClips] [${provider}] window ${win.windowIndex + 1} attempt ${attempt}/3 failed: ${err?.message}`);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
          }
        }

        if (windowPlans.length === 0 && lastError) {
          console.error(`[planClips] [${provider}] window ${win.windowIndex + 1} failed all attempts — skipping section ${win.startTime.toFixed(0)}s–${win.endTime.toFixed(0)}s`);
        }
        allPlans.push(...windowPlans);
      }

      if (allPlans.length === 0) {
        throw new Error(`planClips [${provider}]: every window failed — no clips found in any section`);
      }

      const merged = mergeWindowedPlans(allPlans);
      console.log(`[planClips] [${provider}] merged: ${allPlans.length} raw → ${merged.length} clips after dedup`);
      return merged;
    }

    // ── Single-call path: transcript fits inside this provider's window threshold ──
    const compact = formatted.slice(0, 180_000);
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

    const rawText = await complete(provider, prompt, 8000);
    const jsonString = extractJsonArray(rawText);
    let rawPlans: (Partial<ClipPlan> & { index: number })[];
    try {
      rawPlans = JSON.parse(jsonString) as (Partial<ClipPlan> & { index: number })[];
    } catch (err: any) {
      throw new Error(`Planner LLM JSON syntax error: ${err?.message}\nRaw JSON snippet: ${jsonString.slice(0, 200)}`);
    }

    if (!Array.isArray(rawPlans)) throw new Error("planner did not return a JSON array");
    if (rawPlans.length === 0) throw new Error("planner returned an empty array — no clips found");

    console.log(`[planClips] ${provider}: ${rawPlans.length} clips`);
    return rawPlans.map((p, i) => sanitizePlan({ ...p, index: i + 1 }, videoDuration));
  }
