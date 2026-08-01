# Phase 0 — Environment & toolchain setup

**Goal:** the machine can run the pipeline, and can prove it.

> **Status: built 2026-07-31.** Everything below was executed. Two traps the
> original plan did not predict were found and fixed — see *What actually
> happened*. Remaining: paste `HF_TOKEN` into `.env`, and finish the corpus
> renders for podcast / gaming / hinglish.

## Why now

`yt-dlp` is not installed, so the pipeline cannot download anything at all.
Everything after this phase assumes a working GPU Python environment; getting it
wrong here surfaces as a confusing CUDA failure three phases later.

## Probed state (2026-07-31)

| Thing | State |
|---|---|
| GPU | RTX 4050 Laptop, **6141 MiB**, driver 610.43.03 ✅ |
| ffmpeg / ffprobe | `/usr/bin` ✅ |
| NVENC | `h264_nvenc`, `hevc_nvenc`, `av1_nvenc` ✅ |
| Node | v24.18.1 ✅ |
| `.env` | present ✅ |
| **`yt-dlp`** | **MISSING — blocks everything** |
| `python3` | 3.14.3 — **too new**, see below |
| `pip3`, `uv`, `whisper` | missing |

### The one real trap: Python 3.14

System Python is 3.14.3. Torch, CTranslate2 and pyannote publish no cp314
wheels. Installing there either fails or silently source-builds a **CPU-only**
torch you won't notice until phase 2 runs at 40× real time.

**Pin the worker to 3.12 in its own venv. Do not touch system Python.**

## Scope

Toolchain only. No worker code, no pipeline changes.

## Out of scope

Python worker skeleton and artifact schemas → phase 1. WhisperX itself → phase 2.
Ollama → phase 16. The web UI needs no work — pasting a URL at `localhost:5177`
already runs the pipeline and stays the only input through Block B.

## Changes

### 1. `uv` + `yt-dlp`

`server/index.ts:2` already prepends `~/.local/bin` to `PATH`, which is exactly
where `uv tool install` places binaries — no config change needed.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install yt-dlp
yt-dlp --version
```

### 2. Python 3.12 worker venv

```bash
uv python install 3.12
uv venv --python 3.12 worker/.venv
```

`.gitignore` — add `worker/.venv/`

### 3. CUDA torch — verify, don't assume

```bash
uv pip install --python worker/.venv/bin/python torch torchaudio
worker/.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

`torch.cuda.is_available() == False` means CPU-only. **Fix it here.** Use the
index URL from pytorch.org's selector for this driver if the default wheel is CPU.

### 4. Hugging Face token

pyannote 3.1 (bundled in WhisperX) is gated — accept the model terms on the HF
model page, then add to `.env` and `.env.example`:

```
HF_TOKEN=hf_...
WORKER_PYTHON=./worker/.venv/bin/python
```

`.env` is gitignored and already populated — add the two keys, don't regenerate it.

### 5. Extend `server/systemCheck.ts`

Existing checks stay. Reuse `checkBinary` / `which` / `runVersion` — the file
already has the shape.

| Check | Method | Fail level |
|---|---|---|
| Worker Python | `$WORKER_PYTHON --version` reports 3.12.x | `error` |
| CUDA torch | the one-liner from step 3 | `error` if `is_available()` false |
| NVENC | `ffmpeg -encoders` contains `h264_nvenc` | `warn` (CPU encode works, slower) |
| `HF_TOKEN` | set and non-empty | `warn` (only phase 2 needs it) |
| VRAM | `nvidia-smi` total ≥ 6000 MiB | `warn` |

Leave the `whisper` check; phase 2 removes it.

### 6. Test corpus

Create `docs/phases/test-corpus.md` with four fixed URLs: solo talking-head,
podcast with crosstalk, gaming with facecam, heavy Hinglish. Every gate from
phase 4 onward measures against these. Never change them.

## Gate

1. `GET /api/system-check` returns `overall: "ok"`.
2. All four corpus URLs render a clip end to end via the web UI.
3. **Archive one output clip per source** as `docs/phases/baseline/`. Phase 2
   and phase 13 are judged against these by eye — without them "is it better?"
   has no answer.

## Tests

`systemCheck.ts` has no tests today. Add one small `systemCheck.test.ts` covering
the version-parse and status-rollup logic (the `some(error) → error` reduction)
with injected fake results. Do not shell out in tests.

## What actually happened

The predicted work (uv, yt-dlp, 3.12 venv, CUDA torch) went exactly as planned:
`torch 2.13.0+cu130`, `cuda_available True`, verified with a real GPU matmul
rather than a version string. Note torch reports **5799 MiB** usable where
`nvidia-smi` reports 6141 — budget against 5799.

Two traps the plan did **not** predict, both silent:

### 1. Fedora ships an ffmpeg that cannot decode H.264

`ffmpeg-free` is built with `--disable-decoder='h264,hevc,vc1,vvc'` for patent
reasons, leaving only `libopenh264` — and the installed `noopenh264` package is
a **stub that decodes nothing**. No `h264_cuvid` either. The pipeline could
encode but not read most YouTube sources, and `ffprobe` failed on its own output.

Fixed without `sudo` or touching system packages: a static full-GPL build in
`~/.local/bin`, which the server already prepends to `PATH`. Verified after:
native h264 + hevc decoders, NVDEC (`h264_cuvid`) on yuv420p, all three NVENC
encoders, libass + fontconfig for caption burn-in.

**This is now a hard `error` check in `systemCheck.ts`** — it is far too quiet
to leave undetected.

### 2. yt-dlp downloaded ~100 subtitle tracks per video

`--sub-langs "en.*,en"` — `en.*` matches YouTube's auto-**translated** tracks
(`en-ur`, `en-uz`, `en-vi`, …). Two consequences, one cosmetic and one not:

- downloads took ~13× longer than they should have;
- `files.find(f => f.endsWith(".vtt"))` picked the **alphabetically first** file,
  so `source.en-af.vtt` (Afrikaans) could silently become the English transcript.

Fixed in `download.ts`: explicit `en,en-orig,en-US,en-GB`, plus a
`pickSubtitle()` helper that selects by preference order instead of by accident.
Covered by `download.test.ts`.

### 3. YouTube now requires a JS runtime

yt-dlp warns `No supported JavaScript runtime` and silently drops formats.
Installed `deno`, symlinked into `~/.local/bin`, and enabled the challenge
solver in `~/.config/yt-dlp/config` (`--remote-components ejs:github`) so the
pipeline picks it up with **no code change**. Formats went 0 warnings / 25 found.

### Also changed

- **Gemini is now the default provider** (UI pill + server fallback). The
  Anthropic key is valid but has **no credit balance** — and `models.list()`
  still succeeds without credits, so the system check reports it `ok`. A key
  check cannot detect an empty balance without spending money; treat provider
  choice as the real control.

## Risks

| Risk | Mitigation |
|---|---|
| CPU-only torch installed silently | Step 3's assertion is the gate, not the install command |
| pyannote terms not accepted → phase 2 dies with a stack trace | `HF_TOKEN` check now; phase 2 adds a readable error |
| `uv` puts binaries somewhere else | Verify `which yt-dlp` resolves under `~/.local/bin` |
| Corpus videos deleted from YouTube later | Keep local copies of all four in `storage/corpus/` (gitignored) |
