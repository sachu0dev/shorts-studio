import type { MemeOverlay } from "../jobs.js";

// `buildLayoutFilter` lived here until phase 6. The 12 templates are now
// per-frame functions in `worker/stages/render.py` (EFFECTS), because dynamic
// camera paths and split-screen cannot be expressed as one ffmpeg filter graph.
// Meme overlays stayed in ffmpeg — see the note in `edit.ts`.

/**
 * Build one filter_complex fragment compositing a meme input over the base
 * video for its [start,end] window, per display mode. baseLabel/memeLabel
 * are existing filter_complex node labels (e.g. "[base]", "[meme0]");
 * outputLabel is the new node this fragment produces (e.g. "[out0]").
 */
export function buildMemeOverlayFilter(
  meme: MemeOverlay,
  memeLabel: string,
  baseLabel: string,
  outputLabel: string
): string {
  const window = `enable='between(t,${meme.start},${meme.end})'`;

  switch (meme.display) {
    case "corner-overlay":
      return `${memeLabel}scale=320:-1[m];${baseLabel}[m]overlay=W-w-40:H-h-400:${window}${outputLabel}`;
    case "full-cutaway":
      return `${memeLabel}scale=1080:1920[m];${baseLabel}[m]overlay=0:0:${window}${outputLabel}`;
    case "pip-bounce":
      return `${memeLabel}scale=300:-1[m];${baseLabel}[m]overlay=x='(W-w)*abs(sin(t))':y='(H-h)*abs(cos(t))':${window}${outputLabel}`;
    case "sticker-pop":
      return `${memeLabel}scale=360:-1[m];${baseLabel}[m]overlay=x='(W-w)/2':y='H*0.3':${window}${outputLabel}`;
    case "side-by-side-split":
      // ponytail: hstack has no timeline/enable support, so a true split would need the
      // meme input gated with trim/setpts instead. Using overlay (which does support
      // enable) on the right half gets correct [start,end] windowing in one line.
      return `${memeLabel}scale=540:1920[m];${baseLabel}[m]overlay=540:0:${window}${outputLabel}`;
    default:
      return `${baseLabel}copy${outputLabel}`;
  }
}
