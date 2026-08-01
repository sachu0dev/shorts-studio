import type { Signals, FaceTrack, AnalysisArtifact } from "./signals.js";
import type { CompositionType } from "./classify.js";
import {
  buildFramedPath, buildSplitPath, primaryTrack, PRESETS,
  type CameraKeyframe, type PresetName,
} from "./camera.js";
import { activeTrackIn, speakingTracks, type AsdArtifact, type SpeakerBinding } from "./binding.js";
import { buildLayoutTimeline, buildSplitAwareTimeline } from "./timeline.js";
import {
  cropWidthFor, retentionOver, speakerRetentionOver, narrowestSafe, RETENTION,
  type FrameAspect,
} from "./retention.js";

export { cropWidthFor } from "./retention.js";

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
  /** Three or more concurrent faces → treat as a panel, not a two-person conversation. */
  panelFaces: 3,
};

/**
 * Panel-specific routing constants (phase 31).
 *
 * A panel earns a camera-switch differently than a two-person conversation:
 * the switch has to be worth losing everyone else's reaction for, which is a
 * higher bar than "did this person just say something".
 */
export const PANEL = {
  /**
   * How long one person has to hold the floor, uninterrupted, before a panel
   * switches to them specifically. Deliberately well above phase 9's ordinary
   * `minHold` (2.5s calm / 1.5s dynamic) — a two-person switch only has to
   * beat "was that a real turn or a backchannel"; a panel switch has to beat
   * "is losing everyone else's reaction worth it", which is a higher bar.
   * Starting value, moved only when the corpus says so.
   */
  monologueSeconds: 6.0,
};

/** What `render.py` can actually draw today. Everything else falls back. */
export const IMPLEMENTED_MODES: LayoutMode[] = [
  "static-center", "fullscreen-follow", "group-crop", "camera-switch", "split-screen",
];

/** Modes that cannot be drawn without knowing who is speaking. */
const NEEDS_ASD: LayoutMode[] = ["camera-switch", "split-screen"];

/**
 * Which layouts are *possible* for this clip, best first — measured facts only,
 * no taste (CLAUDE.md rule 3). The LLM may later choose among these; it can
 * never add to them, which is what makes a physically impossible layout
 * unreachable rather than merely unlikely.
 */
export function route(sig: Signals, type: CompositionType, confidence: number): Route {
  const T = ROUTE_THRESHOLDS;

  if (confidence < T.confidence) {
    // Unsure WHAT the clip is, but certain there are several faces in it —
    // keeping all of them is the conservative answer. Centre-cropping a panel
    // is a confident, destructive guess wearing a cautious label.
    // Phase 31: face-aware fallback replaces the blind static-center-for-all.
    if (sig.medianConcurrentFaces >= 2) {
      return {
        modes: ["group-crop", "blurred-fill"],
        reason: `classifier confidence ${confidence} < ${T.confidence} but ${sig.medianConcurrentFaces} concurrent faces — keeping the group`,
      };
    }
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

      // Phase 31: panels of 3+ are a different format from two-person conversations.
      // Split-screen on 8 people is meaningless; camera-switch that chases every
      // 3-second reply loses the reactions that make a panel interesting.
      // Default: keep everyone (group-crop). Switch only on a sustained monologue
      // — enforced by buildComposition passing PANEL.monologueSeconds as minHold.
      if (sig.medianConcurrentFaces >= T.panelFaces) {
        return {
          modes: ["group-crop", "camera-switch"],
          reason: `panel (${sig.medianConcurrentFaces} concurrent faces) — group-crop default, camera-switch only on sustained monologue (${PANEL.monologueSeconds}s)`,
        };
      }

      // Two-person paths below are unchanged (phase 9).
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

/** How the remainder of the canvas is filled when the window is wider than 9:16. */
export type Fill = "blur" | "black";

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
  /** `split-screen` only: the two tracks shown, index 0 on top. Order is fixed for the whole clip. */
  targets?: [number, number];
  arrangement?: "stacked";
  /**
   * Window aspect for this segment (phase 30). Absent means `"9:16"`, so
   * artifacts written before this phase still read correctly.
   */
  frameAspect?: FrameAspect;
  fill?: Fill;
  /** Why this aspect — the retention number that earned or blocked a widen. */
  reason?: string;
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
  /**
   * The published file's fixed dimensions (phase 30) — never anything else, so
   * a wide `frameAspect` window is letterboxed into this, not shipped as a
   * landscape file. A Short is 1080x1920; only the framing window moves.
   */
  canvas: { w: number; h: number };
  /** Normalized width of the default 9:16 window in source coordinates. */
  cropWidth: number;
  layoutTimeline: LayoutSegment[];
  cameraPath: CameraKeyframe[];
  /** `split-screen` only: one independent camera path per half. */
  splitPath?: { top: CameraKeyframe[]; bottom: CameraKeyframe[] };
  /** Segments actually emitted. */
  heldSegments: number;
  /** Speaker changes that min-hold rejected — see `timeline.ts`. */
  suppressedSwitches: number;
  /** Diarized speaker → face track, from phase 8. Absent when ASD did not run. */
  speakers?: Record<string, SpeakerBinding>;
  /**
   * Raw ASD output, carried through so `render.py` can dim the half that isn't
   * currently talking during a `split-screen` segment without re-deriving it.
   */
  activeTrack?: (number | null)[];
  sampleStep?: number;
}

/** The published file's fixed dimensions — see `Composition.canvas`. */
export const CANVAS = { w: 1080, h: 1920 };

export const ASPECT = {
  /**
   * Minimum time at one aspect before it may change again (phase 30). A
   * resize is a heavier event than a target switch — phase 9's ordinary
   * `minHold` governs *who* is framed, this governs the *shape* of the frame
   * — so it is deliberately longer. Without it, a conversation alternating
   * between a close-up and a group shot would breathe 9:16 → 4:3 → 9:16 every
   * couple of seconds. Starting value, moved only when the corpus says so.
   */
  minHold: 5.0,
};

/**
 * `frameAspect` + `fill` for every segment, decided from the retention that
 * segment's OWN time range measures — one clip can open 9:16 on a close-up,
 * widen to 4:3 when a group enters, and return, because retention is a
 * function of `[t0,t1)`, not of the clip (phase 29).
 *
 * `ASPECT.minHold` gives this the same two-condition inertia phase 9's
 * `buildLayoutTimeline` uses for target switches: the current aspect must
 * have earned its hold, and the challenger's own run must itself clear the
 * bar — consecutive segments wanting the same new aspect count as one run.
 * The one exception is `speakerRetention`: if holding would put the active
 * speaker outside the frame, it widens immediately regardless of the hold.
 *
 * `split-screen` segments are untouched — phase 10's half-crop geometry
 * assumes a fixed 9:16-derived window.
 */
export function assignFrameAspects(
  segments: LayoutSegment[],
  tracks: FaceTrack[],
  sourceWidth: number,
  sourceHeight: number,
  activeTrack?: (number | null)[],
  sampleStep?: number,
  minHold: number = ASPECT.minHold
): LayoutSegment[] {
  if (!segments.length) return segments;

  const ideal: FrameAspect[] = segments.map((s) =>
    s.mode === "split-screen"
      ? "9:16"
      : narrowestSafe(tracks, sourceWidth, sourceHeight, s.t0, s.t1, activeTrack, sampleStep)
  );

  const out: LayoutSegment[] = [];
  let committed = ideal[0];
  let committedSince = segments[0].t0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.mode !== "split-screen" && ideal[i] !== committed) {
      let j = i;
      let runEnd = seg.t0;
      while (j < segments.length && segments[j].mode !== "split-screen" && ideal[j] === ideal[i]) {
        runEnd = segments[j].t1;
        j++;
      }
      const challengerRun = runEnd - seg.t0;
      const heldLongEnough = seg.t0 - committedSince >= minHold;
      const speakerViolation =
        !!activeTrack &&
        sampleStep != null &&
        speakerRetentionOver(tracks, sourceWidth, sourceHeight, seg.t0, seg.t1, committed, activeTrack, sampleStep) <
          RETENTION.speakerFloor;

      if (speakerViolation || (heldLongEnough && challengerRun >= minHold)) {
        committed = ideal[i];
        committedSince = seg.t0;
      }
    }

    const aspect = seg.mode === "split-screen" ? "9:16" : committed;
    const r916 = retentionOver(tracks, sourceWidth, sourceHeight, seg.t0, seg.t1, "9:16");
    const reason =
      aspect === "9:16"
        ? `retention ${r916.toFixed(3)} at 9:16`
        : `retention ${r916.toFixed(3)} at 9:16 — widened to ${aspect}`;
    out.push({ ...seg, frameAspect: aspect, fill: "blur", reason });
  }
  return out;
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

  const tracks = analysis?.faceTracks ?? [];
  const track: FaceTrack | null = primaryTrack(tracks);
  // An ASD artifact with no stabilised track says nothing about who is talking,
  // so it must not unlock a mode that is only about who is talking.
  const canSwitch = !!asd?.activeTrack?.length;
  // "Bound to a real speaker" without diarization (phase 8's workaround, since
  // `pyannote` stays gated): a track earns it by measured ASD talking time. The
  // two most-talkative such tracks, ordered by first appearance — fixed for the
  // whole clip, because phase 10 requires split-screen never swaps sides mid-clip.
  const speakerIds = asd
    ? speakingTracks(asd.scores, asd.sampleStep).filter((id) => tracks.some((t) => t.id === id))
    : [];
  const splitTargets: [number, number] | null =
    speakerIds.length >= 2
      ? (speakerIds
          .slice(0, 2)
          .sort((x, y) => (tracks.find((t) => t.id === x)?.firstSeen ?? 0) - (tracks.find((t) => t.id === y)?.firstSeen ?? 0)) as [
          number,
          number
        ])
      : null;
  const asdReady = (m: LayoutMode) => (m === "split-screen" ? !!splitTargets : canSwitch);

  // Phase 31: for a panel (group-crop leads), check whether ASD confirms a
  // sustained monologue before committing to group-crop. If one speaker holds
  // the floor for >= PANEL.monologueSeconds, camera-switch earns priority over
  // the default group shot — that is rule 3 from the spec.
  const isPanelRoute =
    routed.modes[0] === "group-crop" &&
    (analysis?.signals.medianConcurrentFaces ?? 0) >= ROUTE_THRESHOLDS.panelFaces;
  const effectiveMinHold = isPanelRoute ? PANEL.monologueSeconds : preset.minHold;

  const hasSustainedPanelSpeaker = isPanelRoute && canSwitch && asd
    ? (() => {
        // Count longest uninterrupted run for any single track in seconds
        let maxRun = 0;
        let currRun = 0;
        let lastId: number | null = null;
        for (const id of asd.activeTrack) {
          if (id != null && id === lastId) {
            currRun++;
          } else {
            currRun = id != null ? 1 : 0;
            lastId = id;
          }
          if (currRun > maxRun) maxRun = currRun;
        }
        return (maxRun * asd.sampleStep) >= PANEL.monologueSeconds;
      })()
    : false;

  let mode = routed.modes.find((m) => {
    if (!IMPLEMENTED_MODES.includes(m)) return false;
    if (NEEDS_ASD.includes(m) && !asdReady(m)) return false;
    // On a panel: skip group-crop if ASD confirms a sustained speaker —
    // camera-switch (the next mode) should get the chance to render.
    if (isPanelRoute && m === "group-crop" && hasSustainedPanelSpeaker) return false;
    return true;
  });

  const chosenMode = mode;
  mode ??= track ? "fullscreen-follow" : "static-center";

  let fallbackReason: string | undefined;
  if (chosenMode !== routed.modes[0]) {
    // Never crash on an unbuilt mode, and never silently pretend it rendered —
    // including when a *later* allowed mode was drawn instead of the best one.
    const first = routed.modes[0];
    // For panels with a sustained speaker, camera-switch correctly wins over
    // group-crop — this is intentional and must not log as a fallback warning.
    const isPanelUpgrade = isPanelRoute && hasSustainedPanelSpeaker && chosenMode === "camera-switch";
    if (!isPanelUpgrade) {
      fallbackReason =
        `${first} ${IMPLEMENTED_MODES.includes(first)
          ? "needs active-speaker detection, which did not run for this clip"
          : "is not implemented yet"} — rendering ${mode}`;
      log(`${clipId}: ⚠️ ${fallbackReason}`);
    }
  }

  const sourceWidth = analysis?.sourceWidth ?? 0;
  const sourceHeight = analysis?.sourceHeight ?? 0;
  const cropWidth = cropWidthFor(sourceWidth, sourceHeight);
  const cuts = analysis?.signals.sceneCuts ?? [];

  // Segment boundaries are the scene cuts: a segment that starts at one is a
  // jump, and saying so in the artifact is what makes "did it pan across a cut"
  // answerable without watching the video.
  let layoutTimeline: LayoutSegment[];
  let heldSegments = 1;
  let suppressedSwitches = 0;

  if (mode === "split-screen" && splitTargets && asd) {
    const tl = buildSplitAwareTimeline(
      asd.activeTrack, asd.scores, splitTargets, asd.sampleStep, cuts, duration, track?.id ?? null, preset.minHold
    );
    ({ heldSegments, suppressedSwitches } = tl);
    layoutTimeline = tl.segments;
  } else if (mode === "camera-switch" && canSwitch && asd) {
    const tl = buildLayoutTimeline(
      asd.activeTrack, asd.sampleStep, cuts, duration, mode, track?.id ?? null, effectiveMinHold
    );
    ({ heldSegments, suppressedSwitches } = tl);
    layoutTimeline = tl.segments;
  } else {
    const bounds = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
    layoutTimeline = [];
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
    heldSegments = layoutTimeline.length;
  }

  // phase 30: the window's aspect is a per-segment decision, from every
  // branch above — a camera-switch clip can open 9:16 on a close-up and widen
  // for a group shot exactly the same way a group-crop clip can.
  layoutTimeline = assignFrameAspects(layoutTimeline, tracks, sourceWidth, sourceHeight, asd?.activeTrack, asd?.sampleStep);
  const cameraPath = buildFramedPath(layoutTimeline, tracks, sourceWidth, sourceHeight, preset);
  const splitPath =
    mode === "split-screen" && splitTargets
      ? buildSplitPath(layoutTimeline, tracks, splitTargets, cropWidth, preset)
      : undefined;

  return {
    schemaVersion: 5,
    heldSegments,
    suppressedSwitches,
    clipId,
    compositionType: type,
    allowedModes: routed.modes,
    routedReason: routed.reason,
    mode,
    fallbackReason,
    preset: presetName,
    canvas: CANVAS,
    cropWidth,
    layoutTimeline,
    cameraPath,
    ...(splitPath ? { splitPath } : {}),
    // Carried through unconditionally (not just for split-screen) so it costs
    // one branch in render.py, not a shape that differs by mode.
    ...(asd ? { speakers: asd.speakers, activeTrack: asd.activeTrack, sampleStep: asd.sampleStep } : {}),
  };
}
