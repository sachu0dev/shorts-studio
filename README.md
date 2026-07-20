# Shorts Studio

Fully automated YouTube → Shorts pipeline with a local web UI.

Feed it a video URL (YouTube or anything yt-dlp supports) or upload a file, tell it how many clips you want, and it will:

1. **Download** the video (yt-dlp, ≤1080p mp4) + platform subtitles (en/hi)
2. **Transcribe** — parses the platform's VTT subtitles; falls back to local Whisper if none exist
3. **Research trends** — Claude with live web search builds a brief on what's trending in Indian short-form video right now, seeded by your video's topic
4. **Plan clips** — Claude reads the full timestamped transcript + trend brief, picks non-overlapping 20–58s moments, and writes for each: title, 2-second hook text, script, 5–8 Hinglish hashtags, word-grouped caption timings, a caption style, and the best thumbnail frame
5. **Auto-edit** — ffmpeg cuts each clip, center-crops to 9:16 @1080×1920, and burns animated ASS captions using one of three auto-chosen templates (`pop`, `minimal`, `hype`) plus a pop-in hook overlay for the first 2 seconds
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
- Caption styles live in `server/pipeline/edit.ts` (`STYLES`) — they're plain ASS style lines, easy to tweak fonts/colors or add new templates. Claude picks the template per clip based on the clip's energy.
- Clip count is clamped 1–8. Adjust in `server/index.ts` if you want more.
- The crop is a center crop (works well for talking heads). For content where the subject moves around, swap the `crop` filter in `renderClip` for ffmpeg's `cropdetect` or a face-tracking pass.
