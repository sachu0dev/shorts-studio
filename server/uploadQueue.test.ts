import { test } from "node:test";
import assert from "node:assert/strict";
import { computePublishAt, buildQueue, regenerateStaleSchedule } from "./uploadQueue.js";

test("computePublishAt: first item at firstAt, each after by index*gapMs", () => {
  const schedule = { firstAt: "2026-01-01T10:00:00.000Z", gapMs: 3_600_000 }; // 1h gap
  assert.equal(computePublishAt(schedule, 0), "2026-01-01T10:00:00.000Z");
  assert.equal(computePublishAt(schedule, 1), "2026-01-01T11:00:00.000Z");
  assert.equal(computePublishAt(schedule, 3), "2026-01-01T13:00:00.000Z");
});

test("buildQueue: release mode uploads private with a computed publishAt per item, in list order", () => {
  const schedule = { firstAt: "2026-01-01T10:00:00.000Z", gapMs: 3_600_000 };
  const q = buildQueue("job1", ["clip1", "clip3", "clip2"], "UC_x", "release", schedule);
  assert.equal(q.items.length, 3);
  assert.deepEqual(q.items.map((i) => i.clipId), ["clip1", "clip3", "clip2"]);
  assert.deepEqual(q.items.map((i) => i.order), [0, 1, 2]);
  assert.ok(q.items.every((i) => i.privacyStatus === "private"));
  assert.equal(q.items[0].publishAt, "2026-01-01T10:00:00.000Z");
  assert.equal(q.items[1].publishAt, "2026-01-01T11:00:00.000Z");
  assert.equal(q.items[2].publishAt, "2026-01-01T12:00:00.000Z");
  assert.ok(q.items.every((i) => i.status === "pending"));
});

test("buildQueue: public/unlisted modes carry no publishAt", () => {
  const pub = buildQueue("job1", ["clip1"], "UC_x", "public");
  assert.equal(pub.items[0].privacyStatus, "public");
  assert.equal(pub.items[0].publishAt, undefined);

  const unl = buildQueue("job1", ["clip1"], "UC_x", "unlisted");
  assert.equal(unl.items[0].privacyStatus, "unlisted");
  assert.equal(unl.items[0].publishAt, undefined);
});

test("buildQueue: release mode without a schedule throws rather than guessing", () => {
  assert.throws(() => buildQueue("job1", ["clip1"], "UC_x", "release"));
});

test("regenerateStaleSchedule: a past-due first item pushes the whole not-yet-uploaded tail forward, same gap, from now", () => {
  const schedule = { firstAt: "2020-01-01T10:00:00.000Z", gapMs: 1_800_000 }; // 30min gap, long in the past
  const q = buildQueue("job1", ["clip1", "clip2", "clip3"], "UC_x", "release", schedule);
  const now = new Date("2026-08-09T12:00:00.000Z");

  const gapUsed = regenerateStaleSchedule(q, now);
  assert.equal(gapUsed, 1_800_000);
  assert.ok(new Date(q.items[0].publishAt!).getTime() > now.getTime(), "regenerated time must be in the future");
  assert.equal(new Date(q.items[1].publishAt!).getTime() - new Date(q.items[0].publishAt!).getTime(), 1_800_000);
  assert.equal(new Date(q.items[2].publishAt!).getTime() - new Date(q.items[1].publishAt!).getTime(), 1_800_000);
});

test("regenerateStaleSchedule: does nothing when the next item's time is still in the future", () => {
  const schedule = { firstAt: "2030-01-01T10:00:00.000Z", gapMs: 1_800_000 };
  const q = buildQueue("job1", ["clip1", "clip2"], "UC_x", "release", schedule);
  const before = q.items.map((i) => i.publishAt);

  const gapUsed = regenerateStaleSchedule(q, new Date("2026-08-09T12:00:00.000Z"));
  assert.equal(gapUsed, null);
  assert.deepEqual(q.items.map((i) => i.publishAt), before);
});

test("regenerateStaleSchedule: never touches already-uploaded/scheduled items", () => {
  const schedule = { firstAt: "2020-01-01T10:00:00.000Z", gapMs: 1_800_000 };
  const q = buildQueue("job1", ["clip1", "clip2"], "UC_x", "release", schedule);
  q.items[0].status = "scheduled";
  q.items[0].videoId = "abc123";
  const liveTime = q.items[0].publishAt;

  regenerateStaleSchedule(q, new Date("2026-08-09T12:00:00.000Z"));
  assert.equal(q.items[0].publishAt, liveTime, "an already-scheduled item's real YouTube time must not drift locally");
});

test("regenerateStaleSchedule: falls back to inferring the gap when an older queue has no persisted schedule", () => {
  const schedule = { firstAt: "2020-01-01T10:00:00.000Z", gapMs: 1_800_000 };
  const q = buildQueue("job1", ["clip1", "clip2"], "UC_x", "release", schedule);
  delete q.schedule; // simulates a queue built before `schedule` was persisted

  const gapUsed = regenerateStaleSchedule(q, new Date("2026-08-09T12:00:00.000Z"));
  assert.equal(gapUsed, 1_800_000, "inferred from the items' own spacing");
});

test("editing one item's computed time does not move any other item's time — a plain field write", () => {
  const schedule = { firstAt: "2026-01-01T10:00:00.000Z", gapMs: 3_600_000 };
  const q = buildQueue("job1", ["clip1", "clip2"], "UC_x", "release", schedule);
  const before = q.items[1].publishAt;
  q.items[0].publishAt = "2026-06-01T00:00:00.000Z"; // simulates a dialog edit to item 0 only
  assert.equal(q.items[1].publishAt, before, "editing item 0's time moved item 1's time");
});
