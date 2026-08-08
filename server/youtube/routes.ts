import { Router } from "express";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { listChannels, saveChannel, removeChannel } from "./channels.js";
import { getOAuthConfig, buildAuthUrl, exchangeCode, fetchOwnChannel } from "./oauth.js";

/**
 * Where `/channels` is actually served. In production Express serves the
 * built SPA itself (`web/dist`), so a relative link works. In dev the SPA
 * only exists on Vite's port (CLAUDE.md: :5173) — Google's redirect always
 * lands back on this server's own port (the registered redirect URI is
 * static), so a relative link here would 404 against a dist build that was
 * never made. This is why the callback below renders real HTML directly
 * instead of a client-side route: it must not depend on the SPA at all.
 */
function channelsPageUrl(): string {
  const builtSpaExists = existsSync(path.resolve("web", "dist", "index.html"));
  return builtSpaExists ? "/channels" : "http://localhost:5173/channels";
}

function landingPage(ok: boolean, message: string): string {
  const href = channelsPageUrl();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? "Channel linked" : "Link failed"}</title>
<style>body{font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
main{text-align:center;max-width:28rem;padding:1.5rem}a{color:#e5e5e5}</style></head>
<body><main><p>${ok ? "✓" : "✕"} ${message}</p><p><a href="${href}">Back to Channels</a></p></main></body></html>`;
}

const SETUP_INSTRUCTIONS = [
  "Create a Project in Google Cloud Console with YouTube Data API v3 enabled.",
  "Generate OAuth 2.0 Client Credentials (Client ID & Client Secret) of type 'Web application'.",
  "Add the redirect URI shown below to that client's Authorized redirect URIs.",
  "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in your .env file.",
];

/** state -> expiry ms. Short-lived CSRF guard — proportionate for a single-operator localhost tool, not a token vault. */
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 5 * 60_000;

function issueState(): string {
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  // Sweep expired entries opportunistically — this map never holds more than
  // a handful of in-flight consent screens at once.
  for (const [s, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(s);
  return state;
}

function consumeState(state: string | undefined): boolean {
  if (!state) return false;
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  return exp !== undefined && exp >= Date.now();
}

export const channelsRouter = Router();

channelsRouter.get("/", (_req, res) => {
  res.json(listChannels());
});

channelsRouter.get("/connect", (_req, res) => {
  const config = getOAuthConfig();
  if (!config) {
    return res.status(400).json({ error: "YouTube API credentials missing in .env file.", instructions: SETUP_INSTRUCTIONS });
  }
  const state = issueState();
  res.redirect(buildAuthUrl(config, state));
});

channelsRouter.get("/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>;
  const fail = (message: string) => res.status(400).send(landingPage(false, message));

  if (error) return fail(`Google returned an error: ${error}`);
  if (!consumeState(state)) return fail("state mismatch — possible CSRF, please try linking again");
  if (!code) return fail("no authorization code returned");

  const config = getOAuthConfig();
  if (!config) return fail("YouTube credentials missing in .env");

  try {
    const tokens = await exchangeCode(config, code);
    const channel = await fetchOwnChannel(tokens.accessToken);
    saveChannel(
      {
        id: channel.ytChannelId,
        ytChannelId: channel.ytChannelId,
        title: channel.title,
        thumbnailUrl: channel.thumbnailUrl,
        customUrl: channel.customUrl,
        addedAt: Date.now(),
      },
      tokens.refreshToken
    );
    res.send(landingPage(true, `Linked "${channel.title}".`));
  } catch (e: any) {
    fail(e?.message || String(e));
  }
});

channelsRouter.delete("/:id", (req, res) => {
  removeChannel(req.params.id);
  res.json({ removed: req.params.id });
});
