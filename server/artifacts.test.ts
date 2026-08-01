import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStore } from "./artifacts.js";

function store() {
  return new LocalStore(mkdtempSync(path.join(tmpdir(), "artifacts-")));
}

test("path containment: a clipId of ../../etc must not escape the job dir", () => {
  const s = store();
  assert.throws(() => s.path("job1", "../../etc/passwd"), /escapes job dir/);
  assert.throws(() => s.path("job1", "analysis/../../../oops.json"), /escapes job dir/);
  assert.throws(() => s.path("job1", "/etc/passwd"), /escapes job dir/);
});

test("path containment: a malicious jobId is rejected outright", () => {
  const s = store();
  assert.throws(() => s.path("../../etc", "a.json"), /invalid jobId/);
  assert.throws(() => s.path("a/b", "a.json"), /invalid jobId/);
});

test("nested artifact paths are allowed", () => {
  const s = store();
  const p = s.path("job1", "analysis/clip1.json");
  assert.ok(p.endsWith(path.join("job1", "analysis", "clip1.json")));
});

test("round trip: write then read", async () => {
  const s = store();
  await s.writeJson("job1", "analysis/clip1.json", { schemaVersion: 1, hello: "world" } as any);
  const back = await s.readJson<any>("job1", "analysis/clip1.json");
  assert.equal(back.hello, "world");
});

test("missing artifact reads as null, not a throw", async () => {
  const s = store();
  assert.equal(await s.readJson("job1", "nope.json"), null);
  assert.equal(await s.exists("job1", "nope.json"), false);
});

test("a corrupt artifact reads as null so the stage re-runs", async () => {
  const s = store();
  await s.writeJson("job1", "a.json", { schemaVersion: 1 });
  writeFileSync(s.path("job1", "a.json"), "{ this is not json");
  assert.equal(await s.readJson("job1", "a.json"), null);
});

test("writeJson leaves no temp files behind", async () => {
  const s = store();
  await s.writeJson("job1", "a.json", { schemaVersion: 1 });
  const files = readdirSync(s.jobDir("job1"));
  assert.deepEqual(files, ["a.json"]);
});
