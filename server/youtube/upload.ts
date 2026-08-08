import fs from "node:fs";

/**
 * The actual `videos.insert` / `thumbnails.set` mechanics — token-agnostic, so
 * both the temporary single-channel path (`uploader.ts`, env refresh token)
 * and the multi-channel queue (`publish.ts`, phase 32 per-channel token) call
 * the same primitive instead of each reimplementing resumable upload.
 */

export interface VideoMetadataInput {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  privacyStatus: "public" | "unlisted" | "private";
  /** ISO 8601. Only meaningful (and only accepted by the API) when `privacyStatus === "private"`. */
  publishAt?: string;
}

/** Resumable `videos.insert`: initiate a session, then PUT the whole file. Returns the new video id. */
export async function insertVideo(accessToken: string, videoPath: string, meta: VideoMetadataInput): Promise<string> {
  const body: any = {
    snippet: {
      title: meta.title.slice(0, 100), // YouTube's hard limit
      description: meta.description.slice(0, 5000),
      tags: meta.tags.slice(0, 30),
      categoryId: meta.categoryId,
    },
    status: {
      privacyStatus: meta.privacyStatus,
      selfDeclaredMadeForKids: false,
      ...(meta.publishAt ? { publishAt: meta.publishAt } : {}),
    },
  };

  const fileSize = fs.statSync(videoPath).size;
  const initRes = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(fileSize),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify(body),
  });
  if (!initRes.ok) throw new Error(`failed to initiate upload session: ${initRes.status} ${await initRes.text()}`);

  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube API did not return a resumable upload location URL");

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Length": String(fileSize), "Content-Type": "video/mp4" },
    body: fs.readFileSync(videoPath),
  });
  if (!uploadRes.ok) throw new Error(`upload failed: ${uploadRes.status} ${await uploadRes.text()}`);

  const result = (await uploadRes.json()) as { id: string };
  return result.id;
}

export async function setThumbnail(accessToken: string, videoId: string, thumbnailPath: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
    body: fs.readFileSync(thumbnailPath),
  });
  // Thumbnail failure must never fail the whole publish — the video itself
  // already uploaded successfully (CLAUDE.md rule 5, optional-service fail-soft).
  if (!res.ok) throw new Error(`thumbnail upload failed: ${res.status} ${await res.text()}`);
}
