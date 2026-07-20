import busboy from "busboy";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Request, Response, NextFunction } from "express";

/**
 * Handles both multipart/form-data (file upload) and JSON bodies for POST /api/jobs.
 * On multipart: streams the "video" field to storage/tmp and sets req.uploadedFile,
 * text fields land on req.body.
 */
export function uploadMiddleware(storageDir: string) {
  return (req: Request & { uploadedFile?: string }, res: Response, next: NextFunction) => {
    const ct = req.headers["content-type"] || "";
    if (!ct.includes("multipart/form-data")) return next();

    const tmpDir = path.join(storageDir, "tmp");
    mkdirSync(tmpDir, { recursive: true });

    const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });
    req.body = {};

    bb.on("field", (name, val) => ((req.body as any)[name] = val));
    bb.on("file", (name, stream, info) => {
      if (name !== "video") return stream.resume();
      const ext = path.extname(info.filename || ".mp4") || ".mp4";
      const dest = path.join(tmpDir, `${nanoid(8)}${ext}`);
      req.uploadedFile = dest;
      stream.pipe(createWriteStream(dest));
    });
    bb.on("close", () => next());
    bb.on("error", (err) => next(err as Error));
    req.pipe(bb as unknown as NodeJS.WritableStream);
  };
}
