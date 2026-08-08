import type { Job, RightsPosture } from "./jobs.js";

/**
 * Rights posture (phase 14). CLAUDE.md rule 6: structural, not a policy
 * someone can forget — `assertPublishable` is the publish adapter's first
 * line, before any network call, not a check in the route handler or the UI.
 */
export type { RightsPosture };

const AUTO_PUBLISHABLE = new Set<RightsPosture>(["owned", "licensed"]);

export function canAutoPublish(posture: RightsPosture): boolean {
  return AUTO_PUBLISHABLE.has(posture);
}

/**
 * An unset, corrupt, or unrecognized posture reads as `third-party` — the
 * posture that blocks. A bug or a forgotten field must fail closed, never
 * fail open into an auto-publish.
 */
export function normalizeRightsPosture(value: unknown): RightsPosture {
  return value === "owned" || value === "licensed" ? value : "third-party";
}

/** Throws for `third-party`. Called first, before any network request. */
export function assertPublishable(job: Job): void {
  const posture = normalizeRightsPosture(job.rights?.posture);
  if (!canAutoPublish(posture)) {
    throw new Error(
      `job ${job.id} is marked '${posture}' — third-party content cannot auto-publish (CLAUDE.md rule 6)`
    );
  }
}
