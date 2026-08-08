# Shorts Studio — agent brief

Paste a YouTube link → fully auto-edited Short. Node/TS control plane today; a
Python media plane is being added phase by phase. **Build one phase at a time,
refine it until its gate passes, then start the next.**

**What to build next lives in the execution queue in
`docs/phases/README.md` — take the topmost unbuilt row. Phase numbers are file
IDs, not a schedule; never pick the next phase by number.** Phases 0–10, 29, 30
and 31 are built (framing correctness is done); 11 → 13 resumes the original
Block A next. Upload (14–15) and Content Hunt (16–23) are unblocked now that
29–31 pass, but the queue still finishes Block A first.

## Reference documents

- `shorts-studio-master-plan.md` — architecture, composition router, optimization playbook
- `content-hunt-and-local-agents.md` — Content Hunt module, local model ladder, agent roster
- `docs/phases/` — the executable slicing of both, one feature per phase

## Current shape

```
server/index.ts          express + SSE, runPipeline() orchestrates everything
server/jobs.ts           in-memory job map, ClipPlan type (the central contract)
server/stages.ts         runStage() — idempotency, timing, peak VRAM, one place
server/artifacts.ts      LocalStore — atomic typed JSON under storage/<jobId>/
server/systemCheck.ts    /api/system-check — binary + API-key preflight
server/pipeline/
  download.ts            yt-dlp; run() is the shared spawn helper
  transcribe.ts          WhisperX word timings (the only transcript path)
  boundaries.ts          snap clip edges to scene cuts + silences
  analyze.ts             provider switch (anthropic|openai|gemini) + prompt building
  signals.ts             Signals/AnalysisArtifact types + transcript-derived signals
  classify.ts            compositionType from measured signals only
  binding.ts             ASD hysteresis + speaker↔face-track binding
  retention.ts           faces a crop window keeps whole, per aspect + time range
  camera.ts              smoothing presets, camera path keyframes
  router.ts              allowed layouts + the whole Composition artifact
  edit.ts                composition request + invoke render.py + thumbnail
  captions.ts            palettes, per-word ASS override tags
  layouts.ts             meme overlay filter (layouts moved to render.py)
  memes.ts / fonts.ts    Giphy + Google Fonts, both fail soft
worker/                  the Python media plane (own venv, .venv/bin/python)
  stages/_base.py        run_stage() — args, atomic IO, VRAM sampling, teardown
  stages/*.py            transcribe, scenes, analyze_clip, asd, render, probe
  vendor/                third-party model code, vendored verbatim + licence
  models/                weights (gitignored)
web/                     Vite + React + shadcn/ui + Tailwind v4 — the UI
  src/App.tsx            sidebar/header shell, view = new job | job | system check
  src/pages/             NewJobPage, JobPage (SSE), SystemCheckPage
  src/lib/api.ts         fetch wrappers + the SSE subscription
```

`npm run dev` runs both (Express on :5177, Vite on :5173, proxied). `npm run
build:web` builds `web/dist`, which Express serves in production. Component
work goes through `npx shadcn@latest add <name> --cwd web` — if it drops files
under a literal `web/@/` directory instead of `web/src/`, that's the CLI
misresolving the `@/` alias; move them into `src/` and delete the `@/` folder.

## Target rig (fixed constraint, not a preference)

RTX 4050 laptop, **6141 MiB VRAM**, i7 13th-gen HX, Fedora, single user.
NVENC available (`h264_nvenc`, `hevc_nvenc`, `av1_nvenc`).

Everything downstream follows from the 6 GB ceiling:
- **One model resident at a time.** Each media stage is its own process invocation.
- Face detection stays on **CPU** (MediaPipe) so the GPU is free for Whisper/ASD.
- A local LLM is never co-resident with CV work. Only CPU embeddings run concurrently.

## Rules that must stay true

1. **Stages talk through artifacts, never memory.** Each writes typed JSON to
   `storage/<jobId>/`. This is what makes stages resumable now and distributable later.
2. **Every artifact carries `schemaVersion`.** They will change.
3. **Deterministic rules own facts; the LLM owns taste.** The router decides what
   layouts are *possible* from measured signals; the LLM only picks among them.
   A malformed LLM response must always fall back to a valid render.
4. **Stages are idempotent.** Re-running with identical inputs returns cached output.
5. **Never block a render on an optional service.** Giphy, Google Fonts, and the
   LLM taste layer all already fail soft — keep that property.
6. **Rights posture is structural.** When publishing lands, `third-party` content
   must be rejected by the publish adapter itself, not by documentation.
7. **Instrument from the first commit of every stage** — stage name, wall time,
   peak VRAM, input duration. The laptop's bottleneck is not where you think.

## Conventions

- ESM (`"type": "module"`) — **relative imports need the `.js` extension**.
- Tests: `node --test` via tsx, colocated `*.test.ts`, no framework. `npm test`.
- `run(cmd, args, onLine)` in `download.ts` is the only subprocess helper — reuse it.
- Progress goes through `progress(job, stage, line?)`, which drives the SSE stream.
- Secrets live in `.env` only. `storage/` and `fonts/*` are gitignored.

## Commands

```bash
npm run dev     # tsx watch, http://localhost:5177
npm test        # node --test
```
