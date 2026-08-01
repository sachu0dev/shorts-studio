import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlanPrompt } from "./analyze.js";

const base = {
  transcript: "[0.0-5.0] hello",
  trendBrief: "brief",
  descriptionSection: "",
  clipCount: 2,
  videoDuration: 600,
  controversialMode: false,
};

test("a fully English video is never pushed into Hinglish", () => {
  // the real case: a Raj Shamani episode transcribed as 7228 English words
  const p = buildPlanPrompt({ ...base, language: "en", romanized: false });
  assert.match(p, /This video is in EN/);
  assert.match(p, /Do NOT sprinkle in Hindi or Hinglish/);
  assert.doesNotMatch(p, /mix of English \+ Hindi/);
});

test("a romanized Hindi video gets the Hinglish register", () => {
  const p = buildPlanPrompt({ ...base, language: "hi", romanized: true });
  assert.match(p, /This video is HINGLISH/);
  assert.match(p, /Never output Devanagari/);
});

test("language hi alone is enough — romanized may be false if the speaker used Latin already", () => {
  const p = buildPlanPrompt({ ...base, language: "hi", romanized: false });
  assert.match(p, /HINGLISH/);
});

test("hashtags follow the language rule rather than being hardcoded Hinglish", () => {
  const en = buildPlanPrompt({ ...base, language: "en" });
  assert.match(en, /hashtags: 5-8, in the LANGUAGE register defined above/);
});

test("defaults to English when the transcript language is unknown", () => {
  const p = buildPlanPrompt(base);
  assert.match(p, /This video is in EN/);
});

test("other languages are honoured, not forced to English or Hindi", () => {
  const p = buildPlanPrompt({ ...base, language: "ta" });
  assert.match(p, /This video is in TA/);
  assert.doesNotMatch(p, /HINGLISH/);
});

test("scene cuts are offered to the planner so it can pick aligned windows", () => {
  const p = buildPlanPrompt({ ...base, sceneCuts: [12.4, 30.1, 47.8] });
  assert.match(p, /SCENE CUTS/);
  assert.match(p, /12\.4, 30\.1, 47\.8/);
});

test("no scene cuts means no empty section in the prompt", () => {
  assert.doesNotMatch(buildPlanPrompt({ ...base, sceneCuts: [] }), /SCENE CUTS/);
  assert.doesNotMatch(buildPlanPrompt(base), /SCENE CUTS/);
});
