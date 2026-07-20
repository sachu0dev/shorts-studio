import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

interface FetchMemeOpts {
  destDir?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Search Tenor for `query`, download the top result's mp4 into destDir.
 * Returns null on any failure (missing key, no results, network error) —
 * caller skips that meme slot, job keeps rendering.
 */
export async function fetchMemeAsset(query: string, opts: FetchMemeOpts = {}): Promise<string | null> {
  const apiKey = opts.apiKey ?? process.env.TENOR_API_KEY;
  if (!apiKey) return null;

  const destDir = opts.destDir ?? path.resolve("storage", "memes-cache");
  const fetchFn = opts.fetchFn ?? fetch;

  try {
    mkdirSync(destDir, { recursive: true });
    const searchRes = await fetchFn(
      `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${apiKey}&limit=1&media_filter=mp4`
    );
    if (!searchRes.ok) return null;
    const data = await searchRes.json() as { results?: { media_formats?: { mp4?: { url: string } } }[] };
    const mp4Url = data.results?.[0]?.media_formats?.mp4?.url;
    if (!mp4Url) return null;

    const fileRes = await fetchFn(mp4Url);
    if (!fileRes.ok) return null;
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const outPath = path.join(destDir, `${nanoid(8)}.mp4`);
    writeFileSync(outPath, bytes);
    return outPath;
  } catch {
    return null;
  }
}
