import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchMemeAsset } from "./memes.js";

test("fetchMemeAsset returns null when no API key configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: undefined });
  assert.equal(result, null);
});

test("fetchMemeAsset downloads the top result on success", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async (url: string) => {
    if (url.includes("tenor.googleapis.com")) {
      return new Response(JSON.stringify({
        results: [{ media_formats: { mp4: { url: "https://tenor.example/clip.mp4" } } }],
      }));
    }
    if (url === "https://tenor.example/clip.mp4") {
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.ok(result);
  assert.ok(existsSync(result!));
});

test("fetchMemeAsset returns null when Tenor returns no results", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async () => new Response(JSON.stringify({ results: [] }))) as unknown as typeof fetch;
  const result = await fetchMemeAsset("obscure query", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});

test("fetchMemeAsset returns null on network failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});

test("fetchMemeAsset returns null when search endpoint returns non-ok status", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});

test("fetchMemeAsset returns null when mp4 download returns non-ok status", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memes-test-"));
  const fakeFetch = (async (url: string) => {
    if (url.includes("tenor.googleapis.com")) {
      return new Response(JSON.stringify({
        results: [{ media_formats: { mp4: { url: "https://tenor.example/clip.mp4" } } }],
      }));
    }
    if (url === "https://tenor.example/clip.mp4") {
      return new Response("not found", { status: 404 });
    }
    throw new Error("unexpected url " + url);
  }) as unknown as typeof fetch;

  const result = await fetchMemeAsset("shocked cat", { destDir: dir, apiKey: "fake-key", fetchFn: fakeFetch });
  assert.equal(result, null);
});
