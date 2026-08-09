# Shorts Studio

**Paste a YouTube link → get a fully auto-edited, publish-ready Short.**

Shorts Studio is an end-to-end pipeline that takes a long-form video, finds
the moments worth clipping, edits them into vertical 9:16 Shorts with
AI-chosen layouts, animated captions, meme overlays and thumbnails, and can
push the finished clips straight to YouTube across multiple channels on a
staggered release schedule — all from a local web UI, tuned to run entirely
on a single consumer GPU.

No cloud render farm, no SaaS subscription, no manual editing. One machine,
one GPU, a handful of API keys.

---

## What it actually does

1. **Download** — `yt-dlp` pulls the source video (or any URL it supports) plus platform subtitles.
2. **Transcribe** — WhisperX produces word-level timings; falls back cleanly when there's no subtitle track.
3. **Find scene/silence boundaries** — clip edges snap to real cuts and pauses instead of chopping mid-sentence.
4. **Analyze** — an LLM (Claude, GPT, Gemini, or a local Ollama model) reads the full transcript and proposes clip-worthy moments, titles, hooks, scripts and hashtags.
5. **Classify composition** — deterministic rules (not the LLM) decide the *possible* layouts from measured signals: talking-head, panel/multi-speaker, gaming with facecam, or b-roll.
6. **Track speakers & faces** — active-speaker detection binds voices to face tracks across the frame.
7. **Compute the crop/camera path** — a retention window follows whoever's talking, per aspect ratio and per time range, with smooth camera keyframes instead of hard jumps.
8. **Route the composition** — picks the concrete layout from what the classifier allows; the LLM only picks *taste* (effects, pacing) among options the router has already proven physically possible.
9. **Render** — a Python worker (ffmpeg + OpenCV) cuts the clip, applies the layout/effect filter graph, composites meme/GIF overlays, and burns word-by-word animated captions.
10. **Thumbnail** — grabs and grades the best frame for the clip.
11. **Upload** — multi-channel YouTube OAuth, a drag-and-drop upload queue, and either immediate public/unlisted publish or a staggered scheduled release with a configurable gap between videos. A stale schedule (e.g. after hitting YouTube's daily upload cap) self-heals: it's regenerated from *now* using the original gap on the next retry, no manual fix required.

Everything streams to the browser live over SSE. Every pipeline stage writes
a typed, versioned JSON artifact to disk — nothing lives only in memory — so
a crash or a server restart mid-job resumes exactly where it left off instead
of re-running (and re-billing) finished work.

## Why it's built this way

- **6 GB VRAM is a hard constraint, not a suggestion.** Every stage runs as
  its own process and only one model is ever resident on the GPU at a time.
  Face detection stays on CPU so the GPU is free for transcription and
  speaker detection. A local LLM is never co-resident with CV work.
- **Rules own facts, the LLM owns taste.** What layouts are *possible* comes
  from measured signals (who's on screen, who's speaking, aspect ratio) —
  never from an LLM guess. The LLM only chooses among options a deterministic
  router has already validated. A malformed LLM response always falls back
  to a valid render; a broken JSON reply never breaks a job.
- **Stages talk only through artifacts.** Every pipeline stage reads and
  writes typed JSON under `storage/<jobId>/`, never shared in-process state.
  That's what makes every stage idempotent, resumable, and — eventually —
  distributable across machines.
- **Optional services fail soft.** Giphy, Google Fonts, and the LLM taste
  layer can all be down or unconfigured without ever blocking a render.
- **Every stage is instrumented from day one** — wall time, peak VRAM, input
  duration, all logged per run. On a laptop GPU, the bottleneck is rarely
  where you'd guess.

## Architecture

```
server/                   Express + SSE control plane (Node/TypeScript)
  index.ts                 runPipeline() orchestrates every stage
  jobs.ts                   in-memory job map + ClipPlan (the central contract)
  stages.ts                 runStage() — idempotency, timing, peak VRAM, one place
  artifacts.ts               LocalStore — atomic typed JSON under storage/<jobId>/
  systemCheck.ts            /api/system-check — binary + API-key preflight
  pipeline/                 download → transcribe → boundaries → analyze →
                             signals → classify → binding → retention →
                             camera → router → edit → captions → layouts
  youtube/                  multi-channel OAuth, resumable upload, publish queue
worker/                    Python media plane, its own venv (torch + CUDA)
  stages/                    transcribe, scenes, analyze_clip, asd, render, probe
  vendor/                    third-party model code, vendored with license
  models/                    weights (gitignored, downloaded on first run)
web/                       Vite + React 19 + shadcn/ui + Tailwind v4
  src/pages/                 New Job, Job (live SSE), System Check, Dashboard
  src/components/            upload queue dialog with drag-and-drop reordering
```

`npm run dev` runs the Express API (`:5177`) and the Vite dev server
(`:5173`, proxied to Express) together. `npm run build:web` builds a static
bundle Express serves directly in production — one process to deploy.

## Requirements

**Hardware:** built and tuned against an RTX 4050 laptop GPU — **6 GB VRAM**
is the assumed ceiling, not a minimum recommendation to exceed. NVENC
hardware encoding (`h264_nvenc`) is used when available; CPU encoding works
as a slower fallback.

**Software:**

| Requirement | Why |
|---|---|
| Node.js 20+ | control plane runtime |
| Python 3.10–3.12 in its own venv | the media worker — **not** system Python (see below) |
| `ffmpeg` + `ffprobe` on `PATH`, with real H.264/HEVC decoders | source decode + render + caption burn-in |
| `yt-dlp` on `PATH` | video download |
| CUDA-enabled `torch` in the worker venv | WhisperX transcription + active-speaker detection |
| At least one LLM API key (Anthropic, OpenAI, Gemini, Groq, OpenRouter, Cerebras) or a running Ollama instance | clip planning + taste layer |

> **Do not install the worker's Python packages into your system Python.**
> Torch, CTranslate2 and pyannote don't ship wheels for every Python version,
> and a version mismatch silently falls back to a CPU-only build you won't
> notice until a transcription job runs 40× slower than it should. Pin the
> worker to its own 3.10–3.12 venv.

> Some Linux distros (Fedora included) ship an `ffmpeg` build with H.264/HEVC
> decoding patent-disabled — it can encode but not read most real-world
> video. If `ffmpeg -hide_banner -decoders` doesn't list a native `h264`
> decoder, install a full/GPL ffmpeg build instead of the distro package.

## Setup

### 1. Clone and install Node dependencies

```bash
git clone <this-repo-url>
cd shorts-studio
npm install
npm install --prefix web
```

### 2. Install the toolchain

```bash
# uv manages both the yt-dlp install and the isolated Python venv
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install yt-dlp

# Python 3.12 venv for the media worker — separate from system Python
uv python install 3.12
uv venv --python 3.12 worker/.venv
uv pip install --python worker/.venv/bin/python torch torchaudio
uv pip install --python worker/.venv/bin/python whisperx opencv-python mediapipe pyannote.audio
```

Verify CUDA actually attached (a silent CPU fallback is the #1 setup trap):

```bash
worker/.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

If `torch.cuda.is_available()` prints `False`, reinstall `torch` from the
CUDA index URL matching your driver (see [pytorch.org](https://pytorch.org)'s
install selector) before continuing.

### 3. Accept the pyannote model terms

WhisperX bundles `pyannote/speaker-diarization-3.1`, a gated model. Accept
its terms at huggingface.co, then generate a Hugging Face access token.

### 4. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
# At least one of these LLM providers, for clip planning + the taste layer
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
# ...or run a local model instead — see .env.example for Ollama config

# Required for transcription + speaker diarization
HF_TOKEN=
WORKER_PYTHON=./worker/.venv/bin/python

# Optional — meme/GIF overlays; skipped silently if unset
GIPHY_API_KEY=

# Optional — caption fonts fetched + cached on first use; falls back to a bundled font if unset
GOOGLE_FONTS_API_KEY=

# Optional — only needed to enable YouTube upload
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=
```

### 5. Run it

```bash
npm run dev
```

Open **http://localhost:5177**, and check `/api/system-check` in the UI —
it verifies every binary, GPU capability and API key before you run a real
job, so setup problems surface immediately instead of three stages deep into
a render.

## YouTube upload (optional)

1. Create an OAuth 2.0 client in Google Cloud Console (APIs & Services →
   Credentials), with `http://localhost:5177/api/channels/callback` (or your
   configured `PORT`) registered exactly as an authorized redirect URI.
2. Enable the YouTube Data API v3 for that project.
3. Set `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` in `.env`.
4. From the app's **Channels** page, link as many channels as you want to
   publish to — each stores its own refresh token.
5. From a finished job, select clips, choose a channel, and pick a release
   strategy: immediate (public/unlisted) or a scheduled staggered release
   with a configurable gap between each video's publish time. Reorder the
   queue by drag-and-drop before starting.

YouTube enforces a daily upload cap per channel (tighter for new/unverified
channels; phone-verifying the channel raises it). If a scheduled item's
release time has already passed by the time a retry succeeds, the queue
regenerates the remaining schedule from the current time automatically,
keeping the original gap — no manual timestamp fixing required.

## Development

```bash
npm run dev     # tsx watch on the server, Vite dev server on the client
npm test        # node --test, colocated *.test.ts, no framework
```

Conventions worth knowing before touching the code:

- ESM throughout — relative imports need an explicit `.js` extension.
- Every pipeline stage is idempotent: re-running with identical inputs
  returns the cached artifact instead of re-processing.
- Every artifact carries a `schemaVersion` field.
- Component work goes through `npx shadcn@latest add <name> --cwd web`.

## Project status

Core pipeline (download → transcribe → classify → route → render → caption
→ thumbnail), adaptive framing correctness for panels/multi-speaker shots,
gaming composition, the multi-channel YouTube upload queue with scheduled
release, a source catalog with dedup/telemetry, and an operations dashboard
are all built and working end to end. See `docs/phases/README.md` for the
detailed build log if you want the phase-by-phase history.

## License

Private project — all rights reserved. Not licensed for reuse or
redistribution.
