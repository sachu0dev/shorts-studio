import type { Job, SystemCheckReport, AiProvider } from "@/types";

export async function listJobs(): Promise<Job[]> {
  const res = await fetch("/api/jobs");
  if (!res.ok) throw new Error(`GET /api/jobs failed: ${res.status}`);
  return res.json();
}

export async function getSystemCheck(): Promise<SystemCheckReport> {
  const res = await fetch("/api/system-check");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `system check failed: ${res.status}`);
  return data;
}

export interface CreateJobInput {
  url?: string;
  file?: File;
  clipCount: string;
  aiProvider: AiProvider;
  description: string;
  controversialMode: boolean;
}

export async function createJob(input: CreateJobInput): Promise<{ id: string }> {
  let res: Response;
  if (input.file) {
    const fd = new FormData();
    fd.append("clipCount", input.clipCount);
    fd.append("aiProvider", input.aiProvider);
    fd.append("description", input.description);
    fd.append("controversialMode", String(input.controversialMode));
    fd.append("video", input.file);
    res = await fetch("/api/jobs", { method: "POST", body: fd });
  } else {
    res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: input.url,
        clipCount: input.clipCount,
        aiProvider: input.aiProvider,
        description: input.description,
        controversialMode: input.controversialMode,
      }),
    });
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `create job failed: ${res.status}`);
  return data;
}

export async function resumeJob(id: string, aiProvider?: AiProvider): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aiProvider }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `resume failed: ${res.status}`);
  }
}

export async function retryFromStage(id: string, stageName: string, aiProvider?: AiProvider): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/retry-from/${stageName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aiProvider }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `retry-from failed: ${res.status}`);
  }
}

export async function updateJobProvider(id: string, aiProvider: AiProvider): Promise<void> {
  const res = await fetch(`/api/jobs/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aiProvider }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `update provider failed: ${res.status}`);
  }
}

export async function stopJob(id: string): Promise<void> {
  const res = await fetch(`/api/jobs/${id}/stop`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `stop failed: ${res.status}`);
  }
}

/** Subscribes to a job's SSE stream. Returns an unsubscribe function. */
export function watchJob(id: string, onUpdate: (job: Job) => void): () => void {
  const es = new EventSource(`/api/jobs/${id}/events`);
  es.onmessage = (e) => onUpdate(JSON.parse(e.data));
  return () => es.close();
}
