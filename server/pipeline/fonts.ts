import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_FONTS_DIR = path.resolve("fonts");
const FALLBACK_FAMILY = "Anton";

interface ResolveFontOpts {
  fontsDir?: string;
  fetchFn?: typeof fetch;
  apiKey?: string;
}

/**
 * Resolve a Google Fonts family name to a local .ttf path.
 * Cache hit -> return immediately. Cache miss -> fetch from the Google
 * Fonts Developer API and cache. Any failure (missing key, network error,
 * unknown family) -> fall back to the bundled "Anton" font so rendering
 * never blocks on network.
 */
export async function resolveFont(family: string, opts: ResolveFontOpts = {}): Promise<string> {
  const fontsDir = opts.fontsDir ?? DEFAULT_FONTS_DIR;
  const fallbackPath = path.join(fontsDir, `${FALLBACK_FAMILY}.ttf`);
  // ponytail: strip anything but letters/digits/space/hyphen so `family` can't escape fontsDir
  const safeFamily = family.replace(/[^a-zA-Z0-9 -]/g, "");
  const cachedPath = path.join(fontsDir, `${safeFamily}.ttf`);

  try {
    mkdirSync(fontsDir, { recursive: true });
  } catch {
    return fallbackPath;
  }

  if (existsSync(cachedPath)) return cachedPath;

  const apiKey = opts.apiKey ?? process.env.GOOGLE_FONTS_API_KEY;
  if (!apiKey) return fallbackPath;

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const metaRes = await fetchFn(
      `https://www.googleapis.com/webfonts/v1/webfonts?key=${apiKey}&family=${encodeURIComponent(family)}`
    );
    const meta = await metaRes.json() as { items?: { family: string; files: Record<string, string> }[] };
    const item = meta.items?.[0];
    if (!item) return fallbackPath;
    const fileUrl = item.files["700"] ?? item.files["regular"];
    if (!fileUrl) return fallbackPath;

    const fontRes = await fetchFn(fileUrl);
    const bytes = new Uint8Array(await fontRes.arrayBuffer());
    writeFileSync(cachedPath, bytes);
    return cachedPath;
  } catch {
    return fallbackPath;
  }
}
