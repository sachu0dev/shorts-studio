/**
 * Google OAuth 2.0 authorization-code web flow (phase 32). Pure functions —
 * no route handling, no storage — so `channels.ts` and `routes.ts` each own
 * one concern.
 *
 * Scopes are `youtube.upload` (already used by the temporary single-channel
 * uploader) plus `youtube.readonly`, added only to read the linked channel's
 * own snippet/thumbnail at link time — still account-scoped, not a wider grant.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const port = process.env.PORT || "5177";
  const redirectUri = process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${port}/api/channels/callback`;
  return { clientId, clientSecret, redirectUri };
}

/**
 * `access_type=offline` + `prompt=consent` on every visit: Google only issues
 * a refresh token on a user's first consent unless `prompt=consent` forces
 * the screen again, which would otherwise silently break re-linking an
 * account that has authorized this app before.
 */
export function buildAuthUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function exchangeCode(config: OAuthConfig, code: string): Promise<ExchangedTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`code exchange failed: ${err.error_description || err.error || res.statusText}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  if (!data.refresh_token) {
    // Google omits this when the account already granted consent and Google
    // decided not to re-issue one despite prompt=consent — rare, but a link
    // attempt that can't be refreshed later is worse than a clear error now.
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at " +
      "https://myaccount.google.com/permissions and try linking again."
    );
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

export interface OwnChannel {
  ytChannelId: string;
  title: string;
  thumbnailUrl: string;
  customUrl?: string;
}

/** The identity of the channel that just authorized this app. */
export async function fetchOwnChannel(accessToken: string): Promise<OwnChannel> {
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`failed to read channel identity: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails: Record<string, { url: string }> } }[] };
  const item = data.items?.[0];
  if (!item) throw new Error("no YouTube channel found on this Google account");
  const thumb = item.snippet.thumbnails.default?.url || Object.values(item.snippet.thumbnails)[0]?.url || "";
  return { ytChannelId: item.id, title: item.snippet.title, thumbnailUrl: thumb, customUrl: item.snippet.customUrl };
}
