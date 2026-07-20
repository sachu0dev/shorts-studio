import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "error";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runVersion(bin: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec(bin, args);
  return (stdout || stderr).split("\n")[0].trim();
}

// ─── individual checks ────────────────────────────────────────────────────────

async function checkBinary(name: string, bin: string, versionArgs: string[]): Promise<CheckResult> {
  const path = await which(bin);
  if (!path) {
    return { name, status: "error", detail: `"${bin}" not found on PATH. Install it to enable this feature.` };
  }
  try {
    const ver = await runVersion(bin, versionArgs);
    return { name, status: "ok", detail: `${path}  —  ${ver}` };
  } catch (e: any) {
    return { name, status: "warn", detail: `Found at ${path} but version check failed: ${e.message}` };
  }
}

async function checkFfmpeg(): Promise<CheckResult> {
  return checkBinary("ffmpeg", "ffmpeg", ["-version"]);
}

async function checkFfprobe(): Promise<CheckResult> {
  return checkBinary("ffprobe", "ffprobe", ["-version"]);
}

async function checkYtDlp(): Promise<CheckResult> {
  return checkBinary("yt-dlp", "yt-dlp", ["--version"]);
}

async function checkWhisper(): Promise<CheckResult> {
  const result = await checkBinary("Whisper (optional)", "whisper", ["--help"]);
  // Whisper is optional — downgrade errors to warnings
  if (result.status === "error") {
    return { ...result, status: "warn", detail: result.detail + " (optional — only needed if video has no subtitles)" };
  }
  return result;
}

async function checkAnthropicKey(): Promise<CheckResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { name: "Anthropic API key", status: "error", detail: "ANTHROPIC_API_KEY not set in .env" };

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    // Cheapest possible call: list models
    await client.models.list();
    return { name: "Anthropic API key", status: "ok", detail: "Key valid — API reachable" };
  } catch (e: any) {
    const msg: string = e?.message || String(e);
    const isAuth = msg.includes("401") || msg.toLowerCase().includes("auth");
    return {
      name: "Anthropic API key",
      status: isAuth ? "error" : "warn",
      detail: isAuth ? "Key present but auth failed — check your key" : `Key present but check failed: ${msg.slice(0, 120)}`,
    };
  }
}

async function checkOpenAiKey(): Promise<CheckResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { name: "OpenAI API key", status: "warn", detail: "OPENAI_API_KEY not set (optional — needed only if you choose GPT-4o)" };

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: key });
    await client.models.list();
    return { name: "OpenAI API key", status: "ok", detail: "Key valid — API reachable" };
  } catch (e: any) {
    const msg: string = e?.message || String(e);
    const isAuth = msg.includes("401") || msg.toLowerCase().includes("auth") || msg.toLowerCase().includes("incorrect");
    return {
      name: "OpenAI API key",
      status: isAuth ? "error" : "warn",
      detail: isAuth ? "Key present but auth failed — check your key" : `Key present but check failed: ${msg.slice(0, 120)}`,
    };
  }
}

async function checkGeminiKey(): Promise<CheckResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { name: "Gemini API key", status: "warn", detail: "GEMINI_API_KEY not set (optional — needed only if you choose Gemini)" };

  try {
    const { GoogleGenAI } = await import("@google/genai");
    const client = new GoogleGenAI({ apiKey: key });
    // Minimal call: list models
    await client.models.list();
    return { name: "Gemini API key", status: "ok", detail: "Key valid — API reachable" };
  } catch (e: any) {
    const msg: string = e?.message || String(e);
    const isAuth = msg.includes("401") || msg.includes("403") || msg.toLowerCase().includes("api_key");
    return {
      name: "Gemini API key",
      status: isAuth ? "error" : "warn",
      detail: isAuth ? "Key present but auth failed — check your key" : `Key present but check failed: ${msg.slice(0, 120)}`,
    };
  }
}

// ─── main export ──────────────────────────────────────────────────────────────

export interface SystemCheckReport {
  overall: CheckStatus;
  checkedAt: string;
  results: CheckResult[];
}

export async function runSystemCheck(): Promise<SystemCheckReport> {
  const results = await Promise.all([
    checkFfmpeg(),
    checkFfprobe(),
    checkYtDlp(),
    checkWhisper(),
    checkAnthropicKey(),
    checkOpenAiKey(),
    checkGeminiKey(),
  ]);

  const overall: CheckStatus =
    results.some((r) => r.status === "error") ? "error" :
    results.some((r) => r.status === "warn")  ? "warn"  : "ok";

  return { overall, checkedAt: new Date().toISOString(), results };
}
