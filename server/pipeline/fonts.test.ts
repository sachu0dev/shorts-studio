import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveFont } from "./fonts.js";

test("resolveFont returns the cached file without fetching on cache hit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fake-font-bytes");
  let fetchCalled = false;
  const fakeFetch = (async () => {
    fetchCalled = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;

  const result = await resolveFont("Anton", { fontsDir: dir, fetchFn: fakeFetch });
  assert.equal(result, path.join(dir, "Anton.ttf"));
  assert.equal(fetchCalled, false);
});

test("resolveFont fetches and caches on cache miss", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes"); // bundled fallback present

  const fakeFetch = (async (url: string) => {
    if (url.includes("googleapis.com/webfonts")) {
      return new Response(JSON.stringify({
        items: [{ family: "Bebas Neue", files: { regular: "https://fonts.example/bebas.ttf" } }],
      }));
    }
    if (url === "https://fonts.example/bebas.ttf") {
      return new Response(new Uint8Array([1, 2, 3]));
    }
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const result = await resolveFont("Bebas Neue", { fontsDir: dir, fetchFn: fakeFetch, apiKey: "fake-key" });
  assert.equal(result, path.join(dir, "Bebas Neue.ttf"));
  assert.ok(existsSync(result));
});

test("resolveFont falls back to Anton when fetch fails and no cache", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes");

  const fakeFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const result = await resolveFont("SomeObscureFont", { fontsDir: dir, fetchFn: fakeFetch, apiKey: "fake-key" });
  assert.equal(result, path.join(dir, "Anton.ttf"));
});

test("resolveFont falls back to Anton when no API key configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fonts-test-"));
  writeFileSync(path.join(dir, "Anton.ttf"), "fallback-bytes");

  const result = await resolveFont("SomeFont", { fontsDir: dir, apiKey: undefined });
  assert.equal(result, path.join(dir, "Anton.ttf"));
});
