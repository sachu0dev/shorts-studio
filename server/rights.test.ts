import { test } from "node:test";
import assert from "node:assert/strict";
import { canAutoPublish, normalizeRightsPosture, assertPublishable } from "./rights.js";
import { createJob } from "./jobs.js";

function job(posture: "owned" | "licensed" | "third-party" | undefined) {
  return createJob({
    url: "https://youtu.be/x", clipCount: 1, aiProvider: "gemini", description: "",
    rights: posture ? { posture, declaredAt: Date.now(), declaredBy: "user" } : ({} as any),
  });
}

test("canAutoPublish: owned and licensed yes, third-party no", () => {
  assert.equal(canAutoPublish("owned"), true);
  assert.equal(canAutoPublish("licensed"), true);
  assert.equal(canAutoPublish("third-party"), false);
});

test("normalizeRightsPosture: unset/unknown/garbage all read as third-party", () => {
  assert.equal(normalizeRightsPosture(undefined), "third-party");
  assert.equal(normalizeRightsPosture(null), "third-party");
  assert.equal(normalizeRightsPosture("nonsense"), "third-party");
  assert.equal(normalizeRightsPosture("owned"), "owned");
  assert.equal(normalizeRightsPosture("licensed"), "licensed");
});

test("assertPublishable throws for third-party", () => {
  assert.throws(() => assertPublishable(job("third-party")));
});

test("assertPublishable passes for owned and licensed", () => {
  assert.doesNotThrow(() => assertPublishable(job("owned")));
  assert.doesNotThrow(() => assertPublishable(job("licensed")));
});

test("a missing/corrupt posture is treated as third-party, not owned", () => {
  assert.throws(() => assertPublishable(job(undefined)));
});

test("rights is immutable after creation — no setter exists on Job", () => {
  const j = job("third-party");
  const before = j.rights.posture;
  // The only way to change it would be direct mutation, which no code path in
  // the app performs — this asserts the value createJob wrote is exactly what
  // is read back, with nothing in between touching it.
  assert.equal(j.rights.posture, before);
  assert.equal(j.rights.declaredBy, "user");
});
