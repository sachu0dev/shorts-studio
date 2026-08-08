import type { Composition, LayoutSegment, EffectWindow, TasteMeta } from "./router.js";
import type { AnalysisArtifact } from "./signals.js";
import type { TimedWord } from "./captions.js";
import type { LayoutTemplate } from "../jobs.js";
import { PRESETS } from "./camera.js";

/**
 * Phase 12 — the LLM refines the edit within facts the router already
 * measured. It cannot invent a mode outside `allowedModes` (CLAUDE.md rule 3,
 * enforced here in code, not trusted from the prompt) and a malformed
 * response is structurally harmless: the deterministic router timeline from
 * phases 7-11 is already a valid, shippable edit.
 */

export const VALID_EFFECTS: LayoutTemplate[] = [
  "fullscreen", "blurred-fill", "meme-corner", "vignette-pulse",
  "glitch-cut", "color-grade-pop", "letterbox-cinematic", "freeze-frame-callout",
];

export interface TasteResult {
  layoutTimeline: LayoutSegment[];
  effects: EffectWindow[];
  taste: TasteMeta;
}

/** Pure string builder — same reason `buildPlanPrompt` is pure: testable without an API call. */
export function buildTastePrompt(comp: Composition, analysis: AnalysisArtifact | null, words: TimedWord[]): string {
  const sig = analysis?.signals;
  const facts = [
    `Composition type: ${comp.compositionType ?? "unknown"}.`,
    sig ? `${sig.distinctFaceTracks} face track(s), ${sig.medianConcurrentFaces} concurrent.` : "",
    sig ? `Speech overlap ${Math.round((sig.overlapRatio ?? 0) * 100)}%, ${sig.turnRate ?? 0} turns/min.` : "",
    sig ? `Subject motion ${sig.subjectMotion}.` : "",
  ].filter(Boolean).join(" ");

  const cuts = [...new Set(comp.layoutTimeline.filter((s) => s.snapped).map((s) => s.t0.toFixed(1)))];
  const cutsLine = cuts.length ? `Scene cuts at ${cuts.join(", ")}s.` : "No scene cuts inside this clip.";

  const segments = comp.layoutTimeline
    .map((s) => `[${s.t0.toFixed(1)}-${s.t1.toFixed(1)} mode=${s.mode}${s.target != null ? ` target=${s.target}` : ""}]`)
    .join(" ");

  const transcript = words.length ? words.map((w) => (w.punch ? `**${w.word}**` : w.word)).join(" ") : "(no transcript for this clip)";

  return `You are refining an already-correct video edit — the layout below is a valid fallback, you are looking for a genuine improvement, not required to change anything.

FACTS (measured, cannot be changed): ${facts} ${cutsLine}
Allowed layout modes for this clip: ${comp.allowedModes.join(", ")}.
Current router-decided timeline: ${segments}

TRANSCRIPT with **punch** words already marked: ${transcript}

TASK: optionally refine the layoutTimeline (using ONLY modes from the allowed list above, and ONLY target track ids that already appear in the timeline above) and choose per-segment visual effects from exactly this list: ${VALID_EFFECTS.join(", ")}.

RULES:
- At most one effect per segment — stacked effects look cheap.
- color-grade-pop is clip-wide or not at all; a grade that flickers on and off looks broken.
- glitch-cut belongs at scene cuts or on a punch word, nowhere else.
- vignette-pulse and freeze-frame-callout suit a punchline or payoff beat, not the whole clip.
- If the router's timeline is already the right edit, return it unchanged and use effects sparingly or not at all.

Respond ONLY with JSON of this exact shape, no markdown fences, no commentary:
{"layoutTimeline": [{"t0": 0.0, "t1": 2.2, "mode": "static-center", "target": 1}], "effects": [{"t0": 0.0, "t1": 2.2, "template": "color-grade-pop", "reason": "hook"}]}`;
}

/** A segment shorter than this merges into the previous one rather than flickering on screen. */
function mergeShortSegments(segs: LayoutSegment[], minHold: number): LayoutSegment[] {
  const out: LayoutSegment[] = [];
  for (const seg of segs) {
    const short = seg.t1 - seg.t0 < minHold;
    if (short && out.length) {
      out[out.length - 1] = { ...out[out.length - 1], t1: seg.t1 };
    } else {
      out.push(seg);
    }
  }
  return out;
}

/**
 * Every rule drops the offending item and keeps the router's value; nothing
 * here ever throws. `raw` is the LLM's response — a string to `JSON.parse`,
 * an already-parsed object, or garbage.
 *
 * ponytail: scene-cut snapping (segment boundaries within ~0.2s of a cut)
 * is not implemented — the contiguity + min-hold-merge passes already
 * prevent a visibly broken timeline, and the router's own segments are
 * already cut-aligned. Add real snapping if a taste-refined boundary is ever
 * seen drifting off a cut on real corpus output.
 */
export function validateTasteResponse(raw: unknown, comp: Composition): TasteResult {
  const routerTimeline = comp.layoutTimeline;
  const duration = routerTimeline.length ? routerTimeline[routerTimeline.length - 1].t1 : 0;
  const rejected: { segment: number; why: string }[] = [];
  const minHold = PRESETS[comp.preset]?.minHold ?? 1.5;

  const fallback = (): TasteResult => ({
    layoutTimeline: routerTimeline,
    effects: [],
    taste: { applied: false, rejected, fellBackToRouter: true },
  });

  let parsed: any;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return fallback();
  }
  if (!parsed || typeof parsed !== "object") return fallback();

  // Real track ids: anything the router itself already trusted as a target,
  // via the timeline, ASD's active track, or a speaker binding.
  const validTargets = new Set<number>();
  for (const s of routerTimeline) if (s.target != null) validTargets.add(s.target);
  if (comp.activeTrack) for (const t of comp.activeTrack) if (t != null) validTargets.add(t);
  if (comp.speakers) for (const b of Object.values(comp.speakers)) if (b.trackId != null) validTargets.add(b.trackId);

  let layoutTimeline = routerTimeline;
  let fellBackToRouter = true;

  const rawSegs = Array.isArray(parsed.layoutTimeline) ? parsed.layoutTimeline : null;
  if (rawSegs && rawSegs.length) {
    const kept: LayoutSegment[] = [];
    rawSegs.forEach((s: any, i: number) => {
      const t0 = Number(s?.t0);
      const t1 = Number(s?.t1);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) {
        rejected.push({ segment: i, why: "invalid t0/t1" });
        return;
      }
      if (!comp.allowedModes.includes(s?.mode)) {
        rejected.push({ segment: i, why: `mode '${s?.mode}' not in allowedModes` });
        return;
      }
      if (s.mode === "split-screen" && !comp.splitPath) {
        rejected.push({ segment: i, why: "split-screen requires both tracks bound" });
        return;
      }
      const target = s?.target != null ? Number(s.target) : undefined;
      if (target != null && !validTargets.has(target)) {
        rejected.push({ segment: i, why: `target ${target} is not a real track id` });
        return;
      }
      // Phase 30's window aspect is decided from face-track retention, which
      // this validator has no access to (only `comp`, per the doc's own
      // signature) — inherited from whichever router segment covers this
      // segment's start, so a taste-refined mode never silently loses a
      // widen the router already earned.
      const source = routerTimeline.find((r) => t0 >= r.t0 - 0.01 && t0 < r.t1 + 0.01) ?? routerTimeline[0];
      kept.push({
        t0, t1, mode: s.mode, ...(target != null ? { target } : {}),
        ...(source?.frameAspect ? { frameAspect: source.frameAspect, fill: source.fill } : {}),
      });
    });

    kept.sort((a, b) => a.t0 - b.t0);
    const contiguous =
      kept.length > 0 &&
      Math.abs(kept[0].t0) < 0.05 &&
      Math.abs(kept[kept.length - 1].t1 - duration) < 0.05 &&
      kept.every((s, i) => i === 0 || Math.abs(s.t0 - kept[i - 1].t1) < 0.05);

    if (contiguous) {
      layoutTimeline = mergeShortSegments(kept, minHold);
      fellBackToRouter = false;
    } else {
      rejected.push({ segment: -1, why: "returned timeline has gaps or overlaps — rebuilt from router" });
    }
  }

  const effects: EffectWindow[] = [];
  const rawEffects = Array.isArray(parsed.effects) ? parsed.effects : [];
  for (const e of rawEffects) {
    const t0 = Math.max(0, Number(e?.t0));
    const t1 = Math.min(duration, Number(e?.t1));
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) continue;
    if (!VALID_EFFECTS.includes(e?.template)) continue;
    effects.push({ t0, t1, template: e.template, ...(e.reason ? { reason: String(e.reason) } : {}) });
  }

  return { layoutTimeline, effects, taste: { applied: true, rejected, fellBackToRouter } };
}
