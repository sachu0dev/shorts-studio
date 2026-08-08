import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Per-channel identity + token storage (phase 32, pulled forward from phase
 * 26's "one client, N refresh tokens" design). Two files, split so a leak of
 * one never leaks the other:
 *
 *   storage/channels.json                        metadata only, no secrets
 *   storage/.credentials/<ytChannelId>.json       chmod 600 — the refresh token
 *
 * Token path is always derived from the channel id passed in — there is no
 * global accessor, which is what makes "channel A's code can't read channel
 * B's token" true by construction rather than by convention.
 */

export interface ChannelMeta {
  id: string; // == ytChannelId; kept as its own field to match phase 26's row shape
  ytChannelId: string;
  title: string;
  thumbnailUrl: string;
  customUrl?: string;
  addedAt: number;
}

interface ChannelTokens {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

let storageRoot = path.resolve(process.env.STORAGE_DIR || "./storage");

/** Tests point this at a scratch directory instead of the real storage root. */
export function _setStorageRootForTests(root: string): void {
  storageRoot = root;
}

function channelsFile(): string {
  return path.join(storageRoot, "channels.json");
}

function credentialsDir(): string {
  return path.join(storageRoot, ".credentials");
}

function tokenFile(ytChannelId: string): string {
  // channel ids are Google-issued opaque strings (UC…); no path traversal
  // risk in practice, but the same defensive check LocalStore uses costs nothing.
  if (!/^[A-Za-z0-9_-]+$/.test(ytChannelId)) throw new Error(`invalid channel id: ${JSON.stringify(ytChannelId)}`);
  return path.join(credentialsDir(), `${ytChannelId}.json`);
}

function atomicWrite(file: string, contents: string, mode?: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, contents, mode !== undefined ? { mode } : undefined);
  renameSync(tmp, file);
  if (mode !== undefined) chmodSync(file, mode);
}

export function listChannels(): ChannelMeta[] {
  if (!existsSync(channelsFile())) return [];
  try {
    return JSON.parse(readFileSync(channelsFile(), "utf8"));
  } catch {
    return []; // a corrupt list reads as empty, same rule the artifact store uses
  }
}

export function getChannel(id: string): ChannelMeta | null {
  return listChannels().find((c) => c.id === id) ?? null;
}

export function saveChannel(meta: ChannelMeta, refreshToken: string): void {
  const rest = listChannels().filter((c) => c.id !== meta.id);
  atomicWrite(channelsFile(), JSON.stringify([...rest, meta], null, 2));

  const tokens: ChannelTokens = { refreshToken };
  atomicWrite(tokenFile(meta.ytChannelId), JSON.stringify(tokens, null, 2), 0o600);
}

export function removeChannel(id: string): void {
  const remaining = listChannels().filter((c) => c.id !== id);
  atomicWrite(channelsFile(), JSON.stringify(remaining, null, 2));
  const f = tokenFile(id);
  if (existsSync(f)) rmSync(f, { force: true });
}

function readTokens(ytChannelId: string): ChannelTokens | null {
  const f = tokenFile(ytChannelId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/**
 * A cached access token if it's still fresh, refreshing (and re-persisting)
 * against Google's token endpoint otherwise. Reuses the exact refresh call
 * `server/youtube/uploader.ts` already makes for the single-channel path.
 */
export async function getAccessToken(ytChannelId: string): Promise<string> {
  const tokens = readTokens(ytChannelId);
  if (!tokens) throw new Error(`no linked channel with id ${ytChannelId}`);

  const fresh = tokens.accessToken && tokens.accessTokenExpiresAt && tokens.accessTokenExpiresAt > Date.now() + 30_000;
  if (fresh) return tokens.accessToken!;

  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET missing in .env");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`failed to refresh token for channel ${ytChannelId}: ${err.error_description || res.statusText}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  atomicWrite(
    tokenFile(ytChannelId),
    JSON.stringify({ ...tokens, accessToken: data.access_token, accessTokenExpiresAt: Date.now() + data.expires_in * 1000 }, null, 2),
    0o600
  );
  return data.access_token;
}
