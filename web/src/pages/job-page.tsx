import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Clock, Download, Terminal, Copy, Check, FileText, Sparkles, ShieldAlert, ExternalLink, Loader2, AlertCircle, UploadCloud } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { watchJob, resumeJob, retryFromStage, stopJob } from "@/lib/api";
import { YoutubeIcon } from "@/components/youtube-icon";
import { UploadQueueDialog } from "@/components/upload-queue-dialog";
import type { Job, AiProvider } from "@/types";

const STAGES: { label: string; apiName: string }[] = [
  { label: "Download",      apiName: "ingest" },
  { label: "Transcribe",    apiName: "transcribe" },
  { label: "Scenes",        apiName: "scenes" },
  { label: "Trends",        apiName: "trends" },
  { label: "Plan",          apiName: "plan" },
  { label: "Render",        apiName: "render" },
];

function stageIndex(stage: string): number {
  const s = stage.toLowerCase();
  if (s.includes("download") || s.includes("upload") || s.includes("queue") || s.includes("preparing")) return 0;
  if (s.includes("transcrib") || s.includes("video ready")) return 1;
  if (s.includes("scene") || s.includes("detect")) return 2;
  if (s.includes("trend")) return 3;
  if (s.includes("select") || s.includes("script") || s.includes("planning")) return 4;
  if (s.includes("edit") || s.includes("clip") || s.includes("rout") || s.includes("analys") || s.includes("compos")) return 5;
  if (s.includes("all clips") || s.includes("done")) return 6;
  return 0;
}

export function JobPage({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [selectedStage, setSelectedStage] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setJob(null);
    setActing(null);
    setSelectedStage(null);
    const unsubscribe = watchJob(jobId, setJob);
    return unsubscribe;
  }, [jobId]);

  useEffect(() => {
    if (job?.status !== "running" && job?.status !== "queued") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [job?.status]);

  useEffect(() => {
    if (job?.status === "running") { setActing(null); setSelectedStage(null); }
  }, [job?.status]);

  const elapsedTimeStr = useMemo(() => {
    if (!job?.createdAt) return "00:00";
    const totalMs = Math.max(0, now - job.createdAt);
    const m = Math.floor(totalMs / 60000);
    const s = Math.floor((totalMs % 60000) / 1000);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [job?.createdAt, now]);

  useEffect(() => {
    const viewport = logRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport],[data-slot=scroll-area-viewport]"
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [job?.log.length]);

  const failed  = job?.status === "error";
  const isDone  = job?.status === "done";
  const isIdle  = !acting && (failed || isDone);

  const [selectedProvider, setSelectedProvider] = useState<AiProvider | null>(null);

  useEffect(() => {
    if (job?.aiProvider && !selectedProvider) {
      setSelectedProvider(job.aiProvider);
    }
  }, [job?.aiProvider]);

  const activeProvider = selectedProvider || job?.aiProvider || "gemini";

  const [selectedClips, setSelectedClips] = useState<Set<number>>(new Set());
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const toggleClipSelected = (index: number) =>
    setSelectedClips((cur) => {
      const next = new Set(cur);
      next.has(index) ? next.delete(index) : next.add(index);
      return next;
    });

  async function handleStop() {
    setActing("stop");
    try { await stopJob(jobId); }
    catch (e: any) { alert(e?.message || "Failed to stop"); setActing(null); }
  }

  async function handleRetryFrom(apiName: string) {
    setActing(`retry:${apiName}`);
    try { await retryFromStage(jobId, apiName, activeProvider); }
    catch (e: any) { alert(e?.message || "Failed to retry"); setActing(null); }
  }

  async function handleResume() {
    setActing("resume");
    try { await resumeJob(jobId, activeProvider); }
    catch (e: any) { alert(e?.message || "Failed to resume"); setActing(null); }
  }

  // Helper: check if a stage is marked done in job.timings
  const completedStages = useMemo(() => {
    const set = new Set<string>();
    for (const t of job?.timings || []) {
      if (t.status === "done") set.add(t.name);
    }
    return set;
  }, [job?.timings]);

  // Active running stage index: first stage not done, or matched by string
  const activeStageIdx = useMemo(() => {
    if (!job) return 0;
    const firstNotDone = STAGES.findIndex((s) => !completedStages.has(s.apiName));
    if (firstNotDone !== -1) return firstNotDone;
    return stageIndex(job.stage);
  }, [completedStages, job]);

  if (!job) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  const current = activeStageIdx;

  const sel = selectedStage !== null ? STAGES[selectedStage] : null;
  const selCanRetry = selectedStage !== null && isIdle && (selectedStage < current || completedStages.has(STAGES[selectedStage]?.apiName));

  return (
    <div className="flex flex-col gap-5 p-6">

      {/* title */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="truncate text-sm font-medium">{job.url || job.id}</p>
          <p className="text-xs text-muted-foreground">Job {job.id}</p>
        </div>
        {job.rights?.posture === "third-party" && (
          <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-500">
            Draft — third-party, cannot auto-publish
          </span>
        )}
      </div>

      {/* ── stage tabs ── */}
      <div className="flex flex-col gap-0">
        <div className="flex border-b">
          {STAGES.map((s, i) => {
            const done    = completedStages.has(s.apiName);
            const active  = !done && (i === current || job.status === "running") && i === current && !failed;
            const errored = !done && i === current && failed;
            const clickable = isIdle && (done || errored);
            const isSelected = selectedStage === i;

            return (
              <button
                key={s.apiName}
                disabled={!clickable}
                onClick={() => setSelectedStage(isSelected ? null : i)}
                className={cn(
                  "flex-1 px-1 py-2 text-center text-xs transition-colors",
                  "border-b-2 -mb-px",
                  // selected tab
                  isSelected
                    ? "border-foreground text-foreground font-medium"
                    : "border-transparent",
                  // state colours
                  !isSelected && done    && "text-emerald-600 dark:text-emerald-400",
                  !isSelected && active  && "text-brand font-medium",
                  !isSelected && errored && "text-destructive font-medium",
                  !isSelected && !done && !active && !errored && "text-muted-foreground",
                  clickable && "cursor-pointer hover:text-foreground",
                  !clickable && "cursor-default"
                )}
              >
                {done ? "✓ " : active ? "▶ " : errored ? "✕ " : ""}{s.label}
              </button>
            );
          })}
        </div>

        {/* action row — only visible when a tab is selected */}
        {sel && (
          <div className="flex flex-wrap items-center gap-3 border-b px-1 py-2 text-xs">
            <span className="text-muted-foreground">{sel.label}</span>
            {selCanRetry ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">Model:</span>
                  <select
                    value={activeProvider}
                    onChange={(e) => setSelectedProvider(e.target.value as AiProvider)}
                    className="rounded border bg-background px-2 py-0.5 text-xs text-foreground focus:outline-none"
                  >
                    <option value="gemini">Gemini 2.0 Flash</option>
                    <option value="groq">Groq (Llama 3.3 70B)</option>
                    <option value="openrouter">OpenRouter (Gemma 4 26B Free)</option>
                    <option value="cerebras">Cerebras (70B Fast)</option>
                    <option value="anthropic">Claude Sonnet 4.6</option>
                    <option value="openai">GPT-4o</option>
                    <option value="ollama">Ollama (Qwen 3B Local)</option>
                  </select>
                </div>
                <button
                  disabled={!!acting}
                  onClick={() => handleRetryFrom(sel.apiName)}
                  className="rounded bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand/90 disabled:opacity-40"
                >
                  {acting === `retry:${sel.apiName}` ? "Starting…" : `Retry from here with ${activeProvider}`}
                </button>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground/60 text-[10px]">
                  clears this stage + everything after
                </span>
              </>
            ) : (
              <span className="text-muted-foreground/50">not yet completed</span>
            )}
          </div>
        )}
      </div>

      {/* ── status row ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className={cn(failed && "text-destructive")}>
          {failed ? `✕ ${job.error || job.stage}` : job.stage}
        </span>

        <div className="flex items-center gap-3">
          {/* elapsed */}
          {(job.status === "running" || job.status === "queued") && (
            <span className="flex items-center gap-1 font-mono">
              <Clock className="size-3" />{elapsedTimeStr}
            </span>
          )}

          {/* provider selector on status bar when stopped/failed */}
          {isIdle ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] opacity-70">Model:</span>
              <select
                value={activeProvider}
                onChange={(e) => setSelectedProvider(e.target.value as AiProvider)}
                className="rounded border bg-background px-2 py-0.5 text-xs text-foreground focus:outline-none"
              >
                <option value="gemini">Gemini 2.0 Flash</option>
                <option value="groq">Groq (Llama 3.3 70B)</option>
                <option value="openrouter">OpenRouter (Gemma 4 26B Free)</option>
                <option value="cerebras">Cerebras (70B Fast)</option>
                <option value="anthropic">Claude Sonnet 4.6</option>
                <option value="openai">GPT-4o</option>
                <option value="ollama">Ollama (Qwen 3B Local)</option>
              </select>
            </div>
          ) : (
            <span className="opacity-50 font-mono text-[11px]">{job.aiProvider}</span>
          )}

          {/* stop */}
          {job.status === "running" && (
            <button
              disabled={acting === "stop"}
              onClick={handleStop}
              className="text-destructive hover:underline underline-offset-2 disabled:opacity-40"
            >
              {acting === "stop" ? "Stopping…" : "Stop"}
            </button>
          )}

          {/* resume on error */}
          {failed && (
            <button
              disabled={!!acting}
              onClick={handleResume}
              className="rounded bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand/90 disabled:opacity-40"
            >
              {acting === "resume" ? "Resuming…" : `Resume with ${activeProvider}`}
            </button>
          )}
        </div>
      </div>

      {/* trend brief */}
      {job.trendBrief && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
            Trend brief <ChevronDown className="size-3 transition-transform" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1.5 rounded border bg-muted/30 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
            {job.trendBrief}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* pipeline log */}
      {job.log.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="size-3" />
            <span>Log</span>
            <span className="opacity-40">({job.log.length})</span>
          </div>
          <ScrollArea ref={logRef} className="h-72 rounded border bg-muted/20">
            <div className="p-3 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {job.log.slice(-400).join("\n")}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* clips */}
      {job.outputs && job.outputs.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Clips</span>
              <span className="text-muted-foreground">({job.outputs.length})</span>
            </div>
            {selectedClips.size > 0 && !job.rights?.posture?.includes("third-party") && (
              <button
                onClick={() => setQueueDialogOpen(true)}
                className="flex items-center gap-1.5 rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground hover:bg-brand/90"
              >
                <UploadCloud className="size-3.5" /> Add {selectedClips.size} to upload queue
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {job.outputs.map((o, i) => (
              <ClipCard
                key={i}
                output={o}
                jobId={job.id}
                thirdParty={job.rights?.posture === "third-party"}
                selected={selectedClips.has(o.plan.index)}
                onToggleSelected={() => toggleClipSelected(o.plan.index)}
              />
            ))}
          </div>
        </div>
      )}

      {/* compilations — themed reels stitched from short moments across the whole video */}
      {job.compilationOutputs && job.compilationOutputs.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Compilations</span>
            <span className="text-muted-foreground">({job.compilationOutputs.length})</span>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {job.compilationOutputs.map((o, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
                <video src={o.clip} poster={o.thumbnail} controls className="aspect-[9/16] w-full rounded bg-black" />
                <div className="text-sm font-medium">{o.plan.title}</div>
                <div className="text-xs text-muted-foreground">{o.plan.theme} · {o.plan.segments.length} moments</div>
                <a href={o.clip} download className="text-xs text-primary underline underline-offset-2">Download</a>
              </div>
            ))}
          </div>
        </div>
      )}

      {job.outputs && (
        <UploadQueueDialog
          jobId={job.id}
          clips={job.outputs
            .filter((o) => selectedClips.has(o.plan.index))
            .map((o) => ({ clipId: `clip${o.plan.index}`, title: o.plan.title, thumbnail: o.thumbnail }))}
          open={queueDialogOpen}
          onOpenChange={setQueueDialogOpen}
        />
      )}
    </div>
  );
}

function ClipCard({
  output, jobId, thirdParty, selected, onToggleSelected,
}: {
  output: NonNullable<Job["outputs"]>[number]; jobId: string; thirdParty: boolean;
  selected: boolean; onToggleSelected: () => void;
}) {
  const { plan, edit } = output;
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [ytStatus, setYtStatus] = useState<{
    youtubeUrl?: string;
    error?: string;
    instructions?: string[];
  } | null>(output.youtubeUrl ? { youtubeUrl: output.youtubeUrl } : null);

  const handleYouTubeUpload = async () => {
    setUploading(true);
    setYtStatus(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/clips/${plan.index}/upload-youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privacyStatus: "public" }),
      });
      const data = await res.json();
      if (data.success && data.videoUrl) {
        setYtStatus({ youtubeUrl: data.videoUrl });
      } else {
        setYtStatus({
          error: data.error || "Failed to upload clip to YouTube",
          instructions: data.instructions,
        });
      }
    } catch (err: any) {
      setYtStatus({ error: String(err?.message || err) });
    } finally {
      setUploading(false);
    }
  };

  const fullTextToCopy = useMemo(() => {
    const tags = (plan.hashtags || []).map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
    return `${plan.title}\n\nHook: ${plan.hook}\n\n${plan.script || ""}\n\n${tags}`;
  }, [plan]);

  const handleCopy = () => {
    navigator.clipboard.writeText(fullTextToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="overflow-hidden rounded-lg border py-0 flex flex-col justify-between shadow-sm">
      <div className="flex flex-col gap-0">
        <div className="relative aspect-[9/16] bg-black group">
          <video src={output.clip} controls playsInline className="h-full w-full object-contain" />
          {!thirdParty && (
            <label className="absolute top-2 left-2 z-10 flex size-6 items-center justify-center rounded bg-black/70 backdrop-blur">
              <Checkbox checked={selected} onCheckedChange={onToggleSelected} className="border-white/60 data-[state=checked]:bg-brand data-[state=checked]:border-brand" />
            </label>
          )}
          <div className="absolute top-2 left-9 right-2 flex items-center justify-between gap-1">
            <span className="rounded bg-black/70 backdrop-blur px-2 py-0.5 text-[10px] font-medium text-white">
              {plan.contentMode} · {plan.layoutTemplate}
            </span>
            <span className="rounded bg-black/70 backdrop-blur px-1.5 py-0.5 text-[10px] font-mono text-white/80">
              {plan.start.toFixed(1)}s–{plan.end.toFixed(1)}s
            </span>
          </div>

          {plan.monetizationFlag?.risky && (
            <span className="absolute top-8 left-2 flex items-center gap-1 rounded bg-destructive/90 backdrop-blur px-2 py-0.5 text-[10px] font-medium text-white shadow">
              <ShieldAlert className="size-3" /> Monetization Risk
            </span>
          )}

          {edit && (
            <span className="absolute bottom-2 left-2 right-2 rounded bg-black/70 backdrop-blur px-2 py-1 text-center text-[10px] text-white/90">
              <span className="font-semibold text-brand-foreground">{edit.compositionType ?? "?"}</span> → {edit.mode}
            </span>
          )}
        </div>

        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold leading-snug">{plan.title}</p>
            <button
              onClick={handleCopy}
              title="Copy Title, Hook, Script & Hashtags"
              className="flex items-center gap-1 shrink-0 rounded border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          {/* Hook */}
          <div className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Hook:</span> {plan.hook}
          </div>

          {/* Reasoning */}
          <p className="text-xs text-muted-foreground/90 italic leading-relaxed">{plan.reason}</p>

          {/* Hashtags */}
          <div className="flex flex-wrap gap-1">
            {(plan.hashtags || []).map((h) => (
              <span key={h} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {h.startsWith("#") ? h : `#${h}`}
              </span>
            ))}
          </div>

          {/* Style & Captions Metadata */}
          <div className="flex flex-wrap gap-1.5 text-[10px]">
            {plan.captionFont && (
              <span className="rounded border bg-background px-2 py-0.5 font-mono text-muted-foreground">
                Font: {plan.captionFont}
              </span>
            )}
            {plan.captionAnimation && (
              <span className="rounded border bg-background px-2 py-0.5 font-mono text-muted-foreground">
                Anim: {plan.captionAnimation}
              </span>
            )}
            {plan.captionPalette && (
              <span className="rounded border bg-background px-2 py-0.5 font-mono text-muted-foreground">
                Style: {plan.captionPalette}
              </span>
            )}
          </div>

          {/* Expandable Script & Memes */}
          <Collapsible className="w-full">
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180 transition-colors">
              <FileText className="size-3" /> Full Script & Details <ChevronDown className="size-3 transition-transform" />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 flex flex-col gap-2 rounded border bg-muted/20 p-2.5 text-xs text-muted-foreground">
              {plan.script && (
                <div>
                  <span className="font-semibold text-foreground">Narrative Script:</span>
                  <p className="mt-1 leading-relaxed whitespace-pre-wrap text-foreground/90">{plan.script}</p>
                </div>
              )}

              {plan.memes && plan.memes.length > 0 && (
                <div className="border-t pt-1.5 mt-1">
                  <span className="font-semibold text-foreground flex items-center gap-1">
                    <Sparkles className="size-3 text-amber-500" /> Meme Overlays ({plan.memes.length})
                  </span>
                  <ul className="mt-1 flex flex-col gap-1 text-[11px]">
                    {plan.memes.map((m, idx) => (
                      <li key={idx} className="flex items-center gap-1 font-mono">
                        · "{m.query}" ({m.start}s–{m.end}s, {m.display})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.monetizationFlag?.risky && plan.monetizationFlag.reasons?.length > 0 && (
                <div className="border-t border-destructive/30 pt-1.5 mt-1 text-destructive text-[11px]">
                  <span className="font-semibold">Monetization Warning:</span>
                  <p>{plan.monetizationFlag.reasons.join(", ")}</p>
                </div>
              )}

              {edit && (
                <div className="border-t pt-1.5 mt-1 text-[10px] font-mono text-muted-foreground">
                  <p>Routing: {edit.routedReason}</p>
                  {edit.fallbackReason && <p className="text-destructive">Fallback: {edit.fallbackReason}</p>}
                  {edit.encoder && <p>Encoder: {edit.encoder} ({edit.frames ?? "?"} frames)</p>}
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </div>

      {/* Action Footer */}
      <div className="p-3 pt-0 flex flex-col gap-2 border-t mt-2">
        <div className="flex gap-2 text-xs pt-2">
          <a
            href={output.clip}
            download
            className="flex flex-1 items-center justify-center gap-1.5 rounded border bg-brand/10 text-brand font-medium py-1.5 hover:bg-brand/20 transition-colors"
          >
            <Download className="size-3.5" /> Download HD Clip
          </a>
          <a
            href={output.thumbnail}
            download
            className="flex items-center justify-center gap-1.5 rounded border px-3 py-1.5 hover:bg-muted text-muted-foreground transition-colors"
          >
            <Download className="size-3.5" /> Thumb
          </a>
        </div>

        {/* Temporary Direct YouTube Upload */}
        {ytStatus?.youtubeUrl || output.youtubeUrl ? (
          <a
            href={ytStatus?.youtubeUrl || output.youtubeUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-2 rounded border border-red-500/40 bg-red-500/10 text-red-500 font-semibold py-1.5 text-xs hover:bg-red-500/20 transition-colors"
          >
            <YoutubeIcon className="size-4" /> View on YouTube <ExternalLink className="size-3" />
          </a>
        ) : thirdParty ? (
          <div
            title="Third-party content cannot auto-publish (CLAUDE.md rule 6) — download and publish manually instead."
            className="flex items-center justify-center gap-2 rounded border border-dashed py-1.5 text-xs text-muted-foreground"
          >
            Draft only — third-party
          </div>
        ) : (
          <button
            onClick={handleYouTubeUpload}
            disabled={uploading}
            className="flex items-center justify-center gap-2 rounded border border-red-600/40 bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white font-semibold py-1.5 text-xs transition-colors disabled:opacity-50"
          >
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <YoutubeIcon className="size-3.5 text-red-500" />}
            {uploading ? "Uploading to YouTube..." : "Upload to YouTube"}
          </button>
        )}

        {/* Error / Missing API Key Guidance */}
        {ytStatus?.error && (
          <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive flex flex-col gap-1 mt-1">
            <div className="flex items-center gap-1 font-semibold">
              <AlertCircle className="size-3.5 shrink-0 text-destructive" />
              <span>{ytStatus.error}</span>
            </div>
            {ytStatus.instructions && ytStatus.instructions.length > 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground border-t border-destructive/20 pt-1">
                <span className="font-semibold text-foreground">How to setup .env credentials:</span>
                <ol className="list-decimal list-inside mt-1 space-y-0.5">
                  {ytStatus.instructions.map((step, idx) => (
                    <li key={idx}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
