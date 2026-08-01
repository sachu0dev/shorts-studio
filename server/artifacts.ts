import { createWriteStream, mkdirSync, promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Every artifact carries a schemaVersion — CLAUDE.md rule 2. */
export interface Artifact {
  schemaVersion: number;
}

export interface Store {
  path(jobId: string, rel: string): string;
  exists(jobId: string, rel: string): Promise<boolean>;
  readJson<T extends Artifact>(jobId: string, rel: string): Promise<T | null>;
  writeJson<T extends Artifact>(jobId: string, rel: string, value: T): Promise<void>;
  writeStream(jobId: string, rel: string): NodeJS.WritableStream;
}

const JOB_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The only thing that touches `fs` under STORAGE_DIR. Stages must never join
 * paths themselves — that rule is what makes an S3Store a config change in
 * phase 23 rather than a refactor.
 */
export class LocalStore implements Store {
  constructor(private readonly root: string) {}

  jobDir(jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new Error(`invalid jobId: ${JSON.stringify(jobId)}`);
    return path.join(this.root, jobId);
  }

  path(jobId: string, rel: string): string {
    const dir = this.jobDir(jobId);
    const p = path.resolve(dir, rel);
    // a clipId of "../../etc" must not escape the job dir
    if (p !== dir && !p.startsWith(dir + path.sep)) {
      throw new Error(`artifact path escapes job dir: ${JSON.stringify(rel)}`);
    }
    return p;
  }

  async exists(jobId: string, rel: string): Promise<boolean> {
    try {
      await fsp.access(this.path(jobId, rel));
      return true;
    } catch {
      return false;
    }
  }

  async readJson<T extends Artifact>(jobId: string, rel: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.path(jobId, rel), "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupt artifact reads as missing so the stage re-runs. Silently
      // trusting half-parsed JSON is the failure mode worth avoiding.
      return null;
    }
  }

  async writeJson<T extends Artifact>(jobId: string, rel: string, value: T): Promise<void> {
    const p = this.path(jobId, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    // temp + rename: a crash mid-write must never leave a half-artifact that
    // the skip check would then trust (phase 1 gate).
    const tmp = `${p}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
    await fsp.rename(tmp, p);
  }

  writeStream(jobId: string, rel: string): NodeJS.WritableStream {
    const p = this.path(jobId, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    return createWriteStream(p);
  }
}
