import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

interface FetchMemeOpts {
  destDir?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

/**
 * Search Giphy for `query`, download the top result's mp4 into destDir.
 * Returns null on any failure (missing key, no results, network error) —
 * caller skips that meme slot, job keeps rendering.
 */
export async function fetchMemeAsset(query: string, opts: FetchMemeOpts = {}): Promise<string | null> {
  const apiKey = opts.apiKey ?? process.env.GIPHY_API_KEY;
  if (!apiKey) return null;

  const destDir = opts.destDir ?? path.resolve("storage", "memes-cache");
  const fetchFn = opts.fetchFn ?? fetch;

  try {
    mkdirSync(destDir, { recursive: true });
    const searchRes = await fetchFn(
      `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(query)}&api_key=${apiKey}&limit=1&rating=pg-13`
    );
    if (!searchRes.ok) return null;
    const data = await searchRes.json() as { data?: { images?: { original?: { mp4?: string } } }[] };
    const mp4Url = data.data?.[0]?.images?.original?.mp4;
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
