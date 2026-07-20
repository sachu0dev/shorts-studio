import type { ClipPlan, LayoutTemplate, MemeOverlay } from "../jobs.js";

/**
 * Pure ffmpeg filter-chain builders per layout template. Each returns a
 * comma-joinable filter fragment (no crop/scale/ass — the caller composes
 * those around this). Empty string means "no extra filter beyond the base
 * crop/scale" (fullscreen, meme-corner reserve no extra filter here — the
 * meme-corner reservation happens via the meme overlay step in layouts.ts's
 * overlay builders, not here).
 */
export function buildLayoutFilter(template: LayoutTemplate, plan: ClipPlan): string {
  switch (template) {
    case "fullscreen":
      return "";
    case "meme-corner":
      return "";
    case "blurred-fill":
      return "split=2[bg][fg];[bg]scale=1080:1920,boxblur=20:5[bgblur];[fg]scale=1080:960[fgsharp];[bgblur][fgsharp]overlay=0:0";
    case "zoom-punch":
      return "zoompan=z='if(lte(mod(t,2),0.3),1.08,1.0)':d=1:s=1080x1920";
    case "shake-on-beat":
      return "crop=iw-20:ih-20:10+5*sin(t*30):10+5*cos(t*30)";
    case "speed-ramp":
      return "setpts=if(lt(mod(t\\,10)\\,1)\\,2.0*PTS\\,PTS)";
    case "vignette-pulse":
      return "vignette=PI/4+0.1*sin(t*3)";
    case "glitch-cut":
      return "rgbashift=rh=4:bh=-4:rv=2:bv=-2";
    case "color-grade-pop":
      return plan.contentMode === "gaming"
        ? "eq=saturation=1.5:contrast=1.15"
        : plan.contentMode === "political"
          ? "curves=preset=cross_process,eq=saturation=0.9"
          : "eq=saturation=1.3:contrast=1.1"; // funny
    case "split-screen-duo":
      return "split=2[top][bottom];[top]crop=iw:ih/2:0:0,scale=1080:960[t2];[bottom]crop=iw:ih/2:0:ih/2,scale=1080:960[b2];[t2][b2]vstack";
    case "letterbox-cinematic":
      return "pad=1080:1920:0:120:black";
    case "freeze-frame-callout":
      return "tpad=stop_mode=clone:stop_duration=0.6";
    default:
      return "";
  }
}

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
      return `${memeLabel}scale=540:1920[m];${baseLabel}crop=540:1920:0:0[left];[left][m]hstack${outputLabel}`;
    default:
      return `${baseLabel}copy${outputLabel}`;
  }
}
