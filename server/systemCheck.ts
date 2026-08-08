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

/** WhisperX is the only transcript source since phase 2 — a missing import is fatal. */
async function checkWhisperX(): Promise<CheckResult> {
  const name = "WhisperX";
  try {
    const { stdout } = await exec(WORKER_PYTHON, ["-c", 'import whisperx;print("WHISPERX", whisperx.__version__ if hasattr(whisperx,"__version__") else "ok")']);
    const ver = stdout.split("\n").find((l) => l.startsWith("WHISPERX")) || "ok";
    return { name, status: "ok", detail: ver.replace("WHISPERX", "whisperx").trim() };
  } catch (e: any) {
    return {
      name,
      status: "error",
      detail: `not importable in the worker venv — run: uv pip install --python ${WORKER_PYTHON} whisperx (${String(e?.message || e).slice(0, 80)})`,
    };
  }
}

// ─── pure parsers (exported for tests — no shelling out in tests) ─────────────

/**
 * Wheels for torch/CTranslate2/pyannote exist for 3.10–3.12 only. System python
 * on this box is 3.14, where installing silently source-builds a CPU-only torch.
 */
export function isSupportedPythonVersion(versionLine: string): boolean {
  const m = /Python (\d+)\.(\d+)/.exec(versionLine);
  if (!m) return false;
  return Number(m[1]) === 3 && Number(m[2]) >= 10 && Number(m[2]) <= 12;
}

export function parseTorchProbe(stdout: string): { version: string; cuda: boolean; device: string } | null {
  const line = stdout.split("\n").find((l) => l.startsWith("TORCH "));
  if (!line) return null;
  const [, version, avail, ...rest] = line.trim().split(" ");
  return { version, cuda: avail === "True", device: rest.join(" ") || "-" };
}

/** Fedora's ffmpeg-free ships `--disable-decoder=h264` — only the do-nothing
 *  libopenh264 stub remains, so most YouTube sources fail to decode. */
export function hasNativeH264Decoder(decodersOutput: string): boolean {
  return decodersOutput.split("\n").some((l) => /^\s*V[\w.]*\s+h264\s/.test(l));
}

export function parseVramMiB(stdout: string): number | null {
  const m = /(\d+)/.exec(stdout.trim());
  return m ? Number(m[1]) : null;
}

export function rollup(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "error")) return "error";
  if (results.some((r) => r.status === "warn")) return "warn";
  return "ok";
}

// ─── worker / GPU checks ──────────────────────────────────────────────────────

const WORKER_PYTHON = process.env.WORKER_PYTHON || "./worker/.venv/bin/python";

const TORCH_PROBE =
  'import torch;print("TORCH",torch.__version__,torch.cuda.is_available(),' +
  'torch.cuda.get_device_name(0) if torch.cuda.is_available() else "-")';

async function checkWorkerPython(): Promise<CheckResult> {
  const name = "Worker Python (3.12)";
  try {
    const ver = await runVersion(WORKER_PYTHON, ["--version"]);
    if (!isSupportedPythonVersion(ver)) {
      return { name, status: "error", detail: `${ver} — needs 3.10–3.12. Run: uv venv --python 3.12 worker/.venv` };
    }
    return { name, status: "ok", detail: `${WORKER_PYTHON} — ${ver}` };
  } catch {
    return { name, status: "error", detail: `${WORKER_PYTHON} not found. Run: uv venv --python 3.12 worker/.venv` };
  }
}

async function checkCudaTorch(): Promise<CheckResult> {
  const name = "CUDA torch";
  try {
    const { stdout } = await exec(WORKER_PYTHON, ["-c", TORCH_PROBE]);
    const probe = parseTorchProbe(stdout);
    if (!probe) return { name, status: "error", detail: "torch probe produced no output" };
    if (!probe.cuda) {
      return { name, status: "error", detail: `torch ${probe.version} is CPU-only — reinstall from the CUDA index URL` };
    }
    return { name, status: "ok", detail: `torch ${probe.version} — ${probe.device}` };
  } catch (e: any) {
    return { name, status: "error", detail: `torch not importable in worker venv: ${String(e?.message || e).slice(0, 120)}` };
  }
}

async function checkH264Decoder(): Promise<CheckResult> {
  const name = "H.264 decoder";
  try {
    const { stdout } = await exec("ffmpeg", ["-hide_banner", "-decoders"], { maxBuffer: 1024 * 1024 * 8 });
    if (!hasNativeH264Decoder(stdout)) {
      return {
        name,
        status: "error",
        detail: "No native h264 decoder — most YouTube sources will fail. Fedora's ffmpeg-free strips it; install a full build into ~/.local/bin",
      };
    }
    return { name, status: "ok", detail: "native h264 decoder present" };
  } catch (e: any) {
    return { name, status: "error", detail: `could not list decoders: ${String(e?.message || e).slice(0, 120)}` };
  }
}

async function checkNvenc(): Promise<CheckResult> {
  const name = "NVENC (GPU encode)";
  try {
    const { stdout } = await exec("ffmpeg", ["-hide_banner", "-encoders"], { maxBuffer: 1024 * 1024 * 8 });
    if (!stdout.includes("h264_nvenc")) {
      return { name, status: "warn", detail: "h264_nvenc unavailable — CPU encoding works but is much slower" };
    }
    return { name, status: "ok", detail: "h264_nvenc available" };
  } catch (e: any) {
    return { name, status: "warn", detail: `could not list encoders: ${String(e?.message || e).slice(0, 120)}` };
  }
}

async function checkVram(): Promise<CheckResult> {
  const name = "GPU VRAM";
  try {
    const { stdout } = await exec("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
    const mib = parseVramMiB(stdout);
    if (mib === null) return { name, status: "warn", detail: "could not parse nvidia-smi output" };
    if (mib < 6000) return { name, status: "warn", detail: `${mib} MiB — below the 6 GB the pipeline is tuned for` };
    return { name, status: "ok", detail: `${mib} MiB total` };
  } catch {
    return { name, status: "warn", detail: "nvidia-smi not available — GPU stages will fall back to CPU" };
  }
}

async function checkHfToken(): Promise<CheckResult> {
  const name = "Hugging Face token";
  const token = process.env.HF_TOKEN;
  if (!token) {
    // Transcription still works without it; only speaker labels are lost.
    return { name, status: "warn", detail: "HF_TOKEN not set — WhisperX will transcribe but produce no speaker labels" };
  }
  return { name, status: "ok", detail: "HF_TOKEN set" };
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

async function checkOllama(): Promise<CheckResult> {
  const name = "Ollama (Local LLM)";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const modelName = process.env.OLLAMA_MODEL || "qwen2.5:3b";

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ baseURL: baseUrl, apiKey: "ollama" });
    const modelsResponse = await client.models.list();
    const models = modelsResponse.data || [];

    const baseModel = modelName.split(":")[0];
    const hasModel = models.some(
      (m: any) =>
        m.id === modelName ||
        m.id.startsWith(`${baseModel}:`) ||
        m.id === baseModel
    );

    if (hasModel) {
      return {
        name,
        status: "ok",
        detail: `Ollama reachable at ${baseUrl} — Model "${modelName}" ready`,
      };
    } else {
      return {
        name,
        status: "warn",
        detail: `Ollama reachable at ${baseUrl} but model "${modelName}" is not pulled. Run: ollama pull ${modelName}`,
      };
    }
  } catch (e: any) {
    return {
      name,
      status: "warn",
      detail: `Ollama service unreachable at ${baseUrl} — run "ollama serve" and "ollama pull ${modelName}"`,
    };
  }
}

async function checkGroqKey(): Promise<CheckResult> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { name: "Groq API key", status: "warn", detail: "GROQ_API_KEY not set (optional — needed for Groq Llama 3.3 70B)" };
  return { name: "Groq API key", status: "ok", detail: "Key present" };
}

async function checkOpenRouterKey(): Promise<CheckResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { name: "OpenRouter API key", status: "warn", detail: "OPENROUTER_API_KEY not set (optional — needed for OpenRouter Free tier)" };
  return { name: "OpenRouter API key", status: "ok", detail: "Key present" };
}

async function checkCerebrasKey(): Promise<CheckResult> {
  const key = process.env.CEREBRAS_API_KEY || process.env.CERABRAS_API_KEY;
  if (!key) return { name: "Cerebras API key", status: "warn", detail: "CEREBRAS_API_KEY not set (optional — needed for Cerebras ultra-fast 70B)" };
  return { name: "Cerebras API key", status: "ok", detail: "Key present" };
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
    checkH264Decoder(),
    checkNvenc(),
    checkYtDlp(),
    checkWorkerPython(),
    checkCudaTorch(),
    checkVram(),
    checkHfToken(),
    checkWhisperX(),
    checkAnthropicKey(),
    checkOpenAiKey(),
    checkGeminiKey(),
    checkGroqKey(),
    checkOpenRouterKey(),
    checkCerebrasKey(),
    checkOllama(),
  ]);

  return { overall: rollup(results), checkedAt: new Date().toISOString(), results };
}
