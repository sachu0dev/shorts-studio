import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASD_THRESHOLDS, activeTrackIn, asdSpeakerCount, bindSpeakersToTracks, stabilizeActiveTrack,
} from "./binding.js";
import type { TranscriptWord } from "./transcribe.js";

const STEP = 0.25;

/** Words for `speaker` covering each [t0, t1) second range, in source time. */
function say(speaker: string, ranges: [number, number][], offset = 0): TranscriptWord[] {
  return ranges.map(([a, b]) => ({ w: "x", wNative: "x", start: a + offset, end: b + offset, speaker }));
}

/** A score array of `n` samples that is `hi` inside `ranges` (seconds) and `lo` outside. */
function scoreOver(n: number, ranges: [number, number][], hi = 0.9, lo = 0.05): number[] {
  return Array.from({ length: n }, (_, k) => {
    const t = k * STEP;
    return ranges.some(([a, b]) => t >= a && t < b) ? hi : lo;
  });
}

test("a clean two-speaker clip binds each speaker to the face that talks with them", () => {
  // 20 s, strict turn-taking: A holds 0-10, B holds 10-20.
  const n = 80;
  const scores = {
    "1": scoreOver(n, [[0, 10]]),
    "2": scoreOver(n, [[10, 20]]),
  };
  const words = [...say("SPEAKER_00", [[0, 10]]), ...say("SPEAKER_01", [[10, 20]])];

  const b = bindSpeakersToTracks(scores, STEP, words, 0);
  assert.equal(b.SPEAKER_00.trackId, 1);
  assert.equal(b.SPEAKER_01.trackId, 2);
  assert.ok(b.SPEAKER_00.confidence > 0.5 && b.SPEAKER_01.confidence > 0.5);
});

test("words are shifted onto the clip grid, so a clip that starts late still binds", () => {
  const n = 80;
  const scores = { "1": scoreOver(n, [[0, 10]]), "2": scoreOver(n, [[10, 20]]) };
  // Same clip, but the source timestamps start at 600 s.
  const words = [...say("SPEAKER_00", [[0, 10]], 600), ...say("SPEAKER_01", [[10, 20]], 600)];

  const b = bindSpeakersToTracks(scores, STEP, words, 600);
  assert.equal(b.SPEAKER_00.trackId, 1);
  assert.equal(b.SPEAKER_01.trackId, 2);
});

test("a speaker with no correlating track binds to null, not the nearest face", () => {
  const n = 80;
  // Track 1 talks in the first half only. SPEAKER_01 talks in the second half
  // while no face on screen is speaking — they are off camera.
  const scores = { "1": scoreOver(n, [[0, 10]]) };
  const words = [...say("SPEAKER_00", [[0, 10]]), ...say("SPEAKER_01", [[10, 20]])];

  const b = bindSpeakersToTracks(scores, STEP, words, 0);
  assert.equal(b.SPEAKER_00.trackId, 1);
  assert.equal(b.SPEAKER_01.trackId, null);
  assert.equal(b.SPEAKER_01.reason, "off-camera");
});

test("two speakers matching one track keeps the stronger and flags the split", () => {
  const n = 80;
  // One face, one voice — but diarization split it into two labels over the
  // same stretch. SPEAKER_00 covers more of it, so it wins.
  const scores = { "1": scoreOver(n, [[0, 15]]) };
  const words = [...say("SPEAKER_00", [[0, 10]]), ...say("SPEAKER_01", [[10, 15]])];

  const logged: string[] = [];
  const b = bindSpeakersToTracks(scores, STEP, words, 0, (l) => logged.push(l));
  const bound = Object.values(b).filter((v) => v.trackId === 1);
  assert.equal(bound.length, 1, "both speakers were bound to the same track");
  const loser = Object.values(b).find((v) => v.trackId === null)!;
  assert.match(loser.reason!, /already bound/);
  assert.ok(loser.confidence <= bound[0].confidence);
  assert.equal(logged.length, 1);
});

test("binding is time-ranged — it records when the track was actually on screen", () => {
  const n = 40;
  const scores = { "1": [...Array(20).fill(null), ...scoreOver(20, [[0, 5]])] as (number | null)[] };
  const b = bindSpeakersToTracks(scores, STEP, say("SPEAKER_00", [[5, 10]]), 0);
  assert.equal(b.SPEAKER_00.trackId, 1);
  assert.equal(b.SPEAKER_00.from, 5);
  assert.equal(b.SPEAKER_00.to, 10);
});

test("empty scores return an empty binding rather than throwing", () => {
  assert.deepEqual(bindSpeakersToTracks({}, STEP, say("SPEAKER_00", [[0, 5]]), 0), {});
  assert.deepEqual(bindSpeakersToTracks({ "1": [] }, STEP, [], 0), {});
});

test("hysteresis: a one-sample spike never changes the active track", () => {
  const n = 20;
  const a = Array(n).fill(0.9);
  const b = Array(n).fill(0.1);
  b[10] = 0.99; // one loud sample for track 2 mid-run
  a[10] = 0.1;

  const active = stabilizeActiveTrack({ "1": a, "2": b });
  assert.equal(active[10], 1, "a single spike flipped the active speaker");
  assert.ok(active.slice(ASD_THRESHOLDS.hysteresis).every((x) => x === 1));
});

test("hysteresis: a run at the window length does change the active track", () => {
  const N = ASD_THRESHOLDS.hysteresis;
  const n = 20;
  const a = Array(n).fill(0.9);
  const b = Array(n).fill(0.1);
  for (let k = 10; k < 10 + N; k++) {
    a[k] = 0.1;
    b[k] = 0.99;
  }

  const active = stabilizeActiveTrack({ "1": a, "2": b });
  assert.equal(active[10 + N - 2], 1, "switched before the window elapsed");
  assert.equal(active[10 + N - 1], 2, "did not switch after a full window");
});

test("nobody speaking holds the last active track rather than flapping to null", () => {
  const active = stabilizeActiveTrack({ "1": [0.9, 0.9, 0.9, 0.9, 0.1, 0.1] });
  assert.equal(active[3], 1);
  assert.equal(active[5], 1, "a pause dropped the active speaker");
});

test("asdSpeakerCount counts talkers without diarization, ignoring brief blips", () => {
  const n = 80;
  // Track 3 speaks for 0.5s — under minSpeakingSeconds, so it is not a speaker.
  const scores = {
    "1": scoreOver(n, [[0, 10]]),
    "2": scoreOver(n, [[10, 20]]),
    "3": scoreOver(n, [[4, 4.5]]),
  };
  assert.equal(asdSpeakerCount(scores, STEP), 2);
  assert.equal(asdSpeakerCount({}, STEP), 0);
});

test("activeTrackIn returns the majority speaker of a segment", () => {
  const active = [1, 1, 1, 2, 2, null, 2, 2];
  assert.equal(activeTrackIn(active, STEP, 0, 0.75), 1);
  assert.equal(activeTrackIn(active, STEP, 0.75, 2), 2);
  assert.equal(activeTrackIn([null, null], STEP, 0, 0.5), null);
});
