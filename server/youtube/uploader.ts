import fs from "node:fs";
import { insertVideo } from "./upload.js";

export interface YouTubeUploadInput {
  videoPath: string;
  title: string;
  script?: string;
  hashtags?: string[];
  privacyStatus?: "unlisted" | "private" | "public";
}

export interface YouTubeUploadResult {
  success: boolean;
  configured: boolean;
  videoId?: string;
  videoUrl?: string;
  error?: string;
  instructions?: string[];
}

/**
 * Temporary YouTube Direct Uploader using YouTube Data API v3 resumable upload protocol.
 * Refreshes OAuth2 access token using YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.
 *
 * NOTE: This is a temporary solution for single-channel publishing.
 * It will be completely replaced in Phase 15 with the full multi-tenant YouTube OAuth architecture.
 */
export async function uploadClipToYouTube(input: YouTubeUploadInput): Promise<YouTubeUploadResult> {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      success: false,
      configured: false,
      error: "YouTube API credentials missing in .env file.",
      instructions: [
        "Create a Project in Google Cloud Console with YouTube Data API v3 enabled.",
        "Generate OAuth 2.0 Client Credentials (Client ID & Client Secret).",
        "Obtain a Refresh Token with scope: https://www.googleapis.com/auth/youtube.upload",
        "Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN in your .env file.",
      ],
    };
  }

  if (!fs.existsSync(input.videoPath)) {
    return {
      success: false,
      configured: true,
      error: `Video file not found at path: ${input.videoPath}`,
    };
  }

  try {
    // 1. Refresh OAuth Access Token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenRes.ok) {
      const errJson = await tokenRes.json().catch(() => ({}));
      throw new Error(`Failed to refresh Google OAuth token: ${errJson.error_description || tokenRes.statusText}`);
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };
    const accessToken = tokenData.access_token;

    // 2. Prepare Metadata
    const formattedHashtags = (input.hashtags ?? []).map((h) => (h.startsWith("#") ? h : `#${h}`));
    const tagList = (input.hashtags ?? []).map((h) => h.replace(/^#/, ""));
    const description = [
      input.script?.trim(),
      formattedHashtags.length > 0 ? formattedHashtags.join(" ") : "",
      "\nGenerated with Shorts Studio AI",
    ]
      .filter(Boolean)
      .join("\n\n");

    // 3. Resumable insert (shared primitive — server/youtube/upload.ts)
    const videoId = await insertVideo(accessToken, input.videoPath, {
      title: input.title,
      description,
      tags: tagList,
      categoryId: "22", // People & Blogs
      privacyStatus: input.privacyStatus ?? "public",
    });
    const videoUrl = `https://youtu.be/${videoId}`;

    return {
      success: true,
      configured: true,
      videoId,
      videoUrl,
    };
  } catch (err: any) {
    return {
      success: false,
      configured: true,
      error: String(err?.message || err),
    };
  }
}
