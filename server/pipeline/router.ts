import type { Signals, FaceTrack, AnalysisArtifact } from "./signals.js";
import type { CompositionType } from "./classify.js";
import { buildCameraPath, primaryTrack, PRESETS, type CameraKeyframe, type PresetName } from "./camera.js";
import { activeTrackIn, type AsdArtifact, type SpeakerBinding } from "./binding.js";

export type LayoutMode =
  | "static-center"
  | "fullscreen-follow"
  | "blurred-fill"
  | "group-crop"
  | "camera-switch"
  | "split-screen";

export interface Route {
  modes: LayoutMode[];
  reason: string;
}

export const ROUTE_THRESHOLDS = {
  /**
   * Below this, the subject is sitting still and the camera should too.
   *
   * The master plan says 0.15. Measured over 8 corpus windows, `subjectMotion`
   * (the primary track's positional standard deviation) runs 0.0006–0.072 —
   * 0.15 would route every real clip to static and make `fullscreen-follow`
   * unreachable. The static windows top out at 0.029 and the two genuinely
   * mobile ones sit at 0.053 and 0.072, so the threshold goes in that gap.
   */
  subjectMotion: 0.04,
  /** Phase 5 confidence under this means the type itself is a guess. */
  confidence: 0.6,
  /** Genuine crosstalk, the thing that earns split-screen over camera-switch. */
  overlapRatio: 0.25,
};

/** What `render.py` can actually draw today. Everything else falls back. */
export const IMPLEMENTED_MODES: LayoutMode[] = ["static-center", "fullscreen-follow"];

/**
 * Which layouts are *possible* for this clip, best first — measured facts only,
 * no taste (CLAUDE.md rule 3). The LLM may later choose among these; it can
 * never add to them, which is what makes a physically impossible layout
 * unreachable rather than merely unlikely.
 */
export function route(sig: Signals, type: CompositionType, confidence: number): Route {
  const T = ROUTE_THRESHOLDS;

  if (confidence < T.confidence) {
    // A generic edit on an ambiguous clip beats a confident wrong one.
    return {
      modes: ["static-center", "blurred-fill"],
      reason: `classifier confidence ${confidence} < ${T.confidence} — routing conservatively`,
    };
  }

  switch (type) {
    case "b-roll":
      return { modes: ["static-center", "blurred-fill"], reason: "b-roll, no subject to follow" };

    case "screen-rec":
      return {
        modes: ["blurred-fill", "static-center"],
        reason: "screen-rec — a 9:16 crop throws away most of the screen",
      };

    case "talking-head":
      return sig.subjectMotion < T.subjectMotion
        ? {
            modes: ["static-center"],
            reason: `talking-head, subjectMotion ${sig.subjectMotion} < ${T.subjectMotion} — plain centre is the right edit`,
          }
        : {
            modes: ["fullscreen-follow", "static-center"],
            reason: `talking-head, subjectMotion ${sig.subjectMotion} >= ${T.subjectMotion}`,
          };

    case "multi-speaker": {
      // Two faces must be on screen AT ONCE for any two-subject layout to mean
      // anything. `distinctFaceTracks` over-counts multi-camera footage — phase
      // 4 measured 3 tracks for the 2-person podcast because every cut mints a
      // new id — so the guard is the tracking-free count. This is the
      // factual-impossibility rule, and it is asserted directly in the tests.
      if (sig.medianConcurrentFaces < 2 || sig.distinctFaceTracks < 2) {
        return {
          modes: ["fullscreen-follow", "static-center"],
          reason:
            `multi-speaker but ${sig.medianConcurrentFaces} face(s) on screen at once ` +
            `(${sig.distinctFaceTracks} tracks) — multi-cam, nothing to place side by side`,
        };
      }
      if (sig.facesFitOneCrop) {
        return { modes: ["group-crop", "fullscreen-follow"], reason: "multi-speaker, faces fit one 9:16 crop" };
      }
      if (sig.overlapRatio > T.overlapRatio) {
        return {
          modes: ["split-screen", "camera-switch"],
          reason: `multi-speaker, crosstalk ${sig.overlapRatio} > ${T.overlapRatio} — both faces need to be visible`,
        };
      }
      return {
        modes: ["camera-switch", "split-screen"],
        reason: `multi-speaker, turn-taking (overlap ${sig.overlapRatio}) — switch rather than split`,
      };
    }
  }
}

export interface LayoutSegment {
  t0: number;
  t1: number;
  mode: LayoutMode;
  target?: number;
  /**
   * Where `target` came from. `asd` means it was measured to be the person
   * talking; `presence` means it is only the most-present face and nothing
   * checked whether that face was speaking.
   */
  targetSource?: "asd" | "presence";
  /** Segment begins at a scene cut, so the camera jumped rather than eased. */
  snapped?: boolean;
}

export interface Composition {
  schemaVersion: number;
  clipId: string;
  compositionType: CompositionType | null;
  allowedModes: LayoutMode[];
  routedReason: string;
  /** What was actually drawn — `allowedModes[0]` unless it isn't built yet. */
  mode: LayoutMode;
  fallbackReason?: string;
  preset: PresetName;
  /** Normalized width of the 9:16 window in source coordinates. */
  cropWidth: number;
  layoutTimeline: LayoutSegment[];
  cameraPath: CameraKeyframe[];
  /** Diarized speaker → face track, from phase 8. Absent when ASD did not run. */
  speakers?: Record<string, SpeakerBinding>;
}

/** The 9:16 window as a fraction of source width; 1 if the source is already tall. */
export function cropWidthFor(sourceWidth: number, sourceHeight: number): number {
  if (!sourceWidth || !sourceHeight) return 9 / 16;
  return Math.min(1, (9 / 16) / (sourceWidth / sourceHeight));
}

/**
 * The complete edit decision for one clip: reviewable before render, debuggable
 * when wrong, and re-renderable in a different style without re-running any
 * inference.
 */
export function buildComposition(
  clipId: string,
  duration: number,
  analysis: AnalysisArtifact | null,
  presetName: PresetName,
  log: (line: string) => void,
  asd: AsdArtifact | null = null
): Composition {
  const preset = PRESETS[presetName];
  const type = analysis?.classification?.type ?? null;
  const confidence = analysis?.classification?.confidence ?? 0;

  const routed: Route = analysis && type
    ? route(analysis.signals, type, confidence)
    : { modes: ["static-center"], reason: "no analysis for this clip — static centre" };

  const track: FaceTrack | null = primaryTrack(analysis?.faceTracks ?? []);
  let mode = routed.modes.find((m) => IMPLEMENTED_MODES.includes(m));
  let fallbackReason: string | undefined;
  if (!mode) {
    // Never crash on an unbuilt mode, and never silently pretend it rendered.
    mode = track ? "fullscreen-follow" : "static-center";
    fallbackReason = `${routed.modes[0]} is not implemented yet — rendering ${mode}`;
    log(`${clipId}: ⚠️ ${fallbackReason}`);
  }

  const cropWidth = cropWidthFor(analysis?.sourceWidth ?? 0, analysis?.sourceHeight ?? 0);
  const cuts = analysis?.signals.sceneCuts ?? [];
  const cameraPath =
    mode === "fullscreen-follow"
      ? buildCameraPath(track, cuts, duration, cropWidth, preset)
      : [{ t: 0, cx: 0.5, cy: 0.5, zoom: 1 }];

  // Segment boundaries are the scene cuts: a segment that starts at one is a
  // jump, and saying so in the artifact is what makes "did it pan across a cut"
  // answerable without watching the video.
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
  const layoutTimeline: LayoutSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    // Who to frame. Phase 7 shipped this as "the most-present face" with nothing
    // checking that face was the one talking; ASD makes it measured. Presence is
    // still the fallback — a segment where nobody speaks has to frame someone.
    const speaking = asd ? activeTrackIn(asd.activeTrack, asd.sampleStep, bounds[i], bounds[i + 1]) : null;
    const target = speaking ?? track?.id;
    layoutTimeline.push({
      t0: bounds[i],
      t1: bounds[i + 1],
      mode,
      ...(target != null ? { target, targetSource: speaking != null ? "asd" as const : "presence" as const } : {}),
      ...(i > 0 ? { snapped: true } : {}),
    });
  }

  return {
    schemaVersion: 2,
    clipId,
    compositionType: type,
    allowedModes: routed.modes,
    routedReason: routed.reason,
    mode,
    fallbackReason,
    preset: presetName,
    cropWidth,
    layoutTimeline,
    cameraPath,
    ...(asd ? { speakers: asd.speakers } : {}),
  };
}
