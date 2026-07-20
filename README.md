# Shorts Studio

Fully automated YouTube → Shorts pipeline with a local web UI.

Feed it a video URL (YouTube or anything yt-dlp supports) or upload a file, tell it how many clips you want, and it will:

1. **Download** the video (yt-dlp, ≤1080p mp4) + platform subtitles (en/hi)
2. **Transcribe** — parses the platform's VTT subtitles; falls back to local Whisper if none exist
3. **Research trends** — Claude with live web search builds a brief on what's trending in Indian short-form video right now, seeded by your video's topic
4. **Plan clips** — Claude reads the full timestamped transcript + trend brief, picks non-overlapping 20–58s moments, and writes for each: title, hook, script, hashtags, word-grouped emphasis-marked captions, a content mode (funny/gaming/political), a caption animation + palette + font, a layout/effect template, meme/GIF placements, and a monetization-risk self-assessment.
5. **Auto-edit** — ffmpeg cuts each clip, applies the AI-chosen layout/effect filter graph, composites any meme/GIF overlays (via Giphy), and burns word-level karaoke-style animated captions using the AI-chosen animation + palette + Google Font (cached locally after first use).
6. **Thumbnails** — grabs the chosen frame, punches contrast/saturation, overlays bold title text

Everything streams live to the browser (SSE) and finished clips render in 9:16 phone-frame cards with download buttons.

## Requirements

- Node 20+
- `ffmpeg` + `ffprobe` on PATH
- `yt-dlp` on PATH (`pip install yt-dlp` or `brew install yt-dlp`)
- Optional: `openai-whisper` on PATH — only used when a video has no subtitles (`pip install openai-whisper`)
- An Anthropic API key

## Setup

```bash
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:5177

## Notes

- Only use this with videos you have the rights/permission to repurpose.
- Output files land in `storage/<jobId>/out/`.
- Caption animations/palettes live in `server/pipeline/captions.ts`, layout/effect templates in `server/pipeline/layouts.ts` — both are plain lookup functions, easy to extend with new options.
- Meme/GIF insertion requires `GIPHY_API_KEY` in `.env` (free from Giphy's developer portal) — without it, meme placements are silently skipped and clips render without them.
- Fonts are fetched from Google Fonts on first use per family (needs `GOOGLE_FONTS_API_KEY`) and cached in `fonts/` — subsequent jobs reuse the cached file, no repeat network calls.
- The "Allow controversial/edgy content" toggle only shifts the AI's clip-*selection* bias — every clip renders regardless, monetization risk is always surfaced as an informational badge, never a block.
