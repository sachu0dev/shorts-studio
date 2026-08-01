import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Download, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { watchJob } from "@/lib/api";
import type { Job } from "@/types";

const STAGES = ["Download", "Transcribe", "Trend research", "Clip planning", "Editing", "Done"];

function stageIndex(stage: string): number {
  const s = stage.toLowerCase();
  if (s.includes("download") || s.includes("upload") || s.includes("queue")) return 0;
  if (s.includes("transcrib") || s.includes("video ready")) return 1;
  if (s.includes("trend")) return 2;
  if (s.includes("select") || s.includes("script")) return 3;
  if (s.includes("edit") || s.includes("clip") || s.includes("rout")) return 4;
  if (s.includes("all clips") || s.includes("done")) return 5;
  return 0;
}

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: "text-purple-500 border-purple-500/30 bg-purple-500/10",
  openai: "text-emerald-500 border-emerald-500/30 bg-emerald-500/10",
  gemini: "text-sky-500 border-sky-500/30 bg-sky-500/10",
};

export function JobPage({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setJob(null);
    const unsubscribe = watchJob(jobId, setJob);
    return unsubscribe;
  }, [jobId]);

  // Radix ScrollArea scrolls an inner viewport element, not the root or the
  // content div — scrolling either of those silently does nothing.
  useEffect(() => {
    const viewport = logRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport],[data-slot=scroll-area-viewport]"
    );
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [job?.log.length]);

  const failed = job?.status === "error";
  const current = job ? stageIndex(job.stage) : 0;

  const providerClass = useMemo(
    () => PROVIDER_COLOR[job?.aiProvider ?? "anthropic"],
    [job?.aiProvider]
  );

  if (!job) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h2 className="truncate text-lg font-semibold">{job.url || job.id}</h2>
        <p className="text-sm text-muted-foreground">Job {job.id}</p>
      </div>

      {/* stage rail */}
      <div className="overflow-hidden rounded-lg border">
        <div className="flex">
          {STAGES.map((s, i) => {
            const done = i < current;
            const now = i === current && !failed;
            return (
              <div
                key={s}
                className={cn(
                  "flex-1 border-r px-2 py-2.5 text-center text-xs last:border-r-0",
                  done && "text-emerald-500",
                  now && "bg-accent text-brand font-medium",
                  !done && !now && "text-muted-foreground"
                )}
              >
                {done ? "✓ " : now ? "▸ " : ""}
                {s}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        {failed ? (
          <span className="flex items-center gap-1.5 text-destructive">
            <AlertTriangle className="size-4" /> {job.error || job.stage}
          </span>
        ) : (
          <>
            <span>{job.stage}</span>
            <Badge variant="outline" className={providerClass}>
              {job.aiProvider}
            </Badge>
          </>
        )}
      </div>

      {job.trendBrief && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium text-brand [&[data-state=open]>svg]:rotate-180">
            Trend brief used for this run
            <ChevronDown className="size-4 transition-transform" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground whitespace-pre-wrap">
            {job.trendBrief}
          </CollapsibleContent>
        </Collapsible>
      )}

      {job.log.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="size-3.5" />
            <span>Pipeline log</span>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {job.log.length}
            </Badge>
          </div>
          <ScrollArea ref={logRef} className="h-[28rem] rounded-md border bg-muted/30">
            <div className="p-3 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {job.log.slice(-400).join("\n")}
            </div>
          </ScrollArea>
        </div>
      )}

      {job.outputs && job.outputs.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold">Clips</h3>
            <Badge variant="secondary">{job.outputs.length}</Badge>
          </div>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {job.outputs.map((o, i) => (
              <ClipCard key={i} output={o} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClipCard({ output }: { output: NonNullable<Job["outputs"]>[number] }) {
  const { plan, edit } = output;
  return (
    <Card className="gap-3 overflow-hidden py-0 pb-4">
      <div className="relative aspect-[9/16] bg-black">
        <video src={output.clip} controls playsInline className="h-full w-full object-cover" />
        <Badge className="absolute top-2 left-2 z-10 bg-background/85 text-brand backdrop-blur">
          {plan.contentMode} · {plan.layoutTemplate}
        </Badge>
        {edit && (
          <Badge
            variant="outline"
            className="absolute bottom-2 left-2 right-2 z-10 justify-center bg-background/85 text-sky-500 backdrop-blur"
            title={edit.routedReason}
          >
            {edit.compositionType ?? "?"} → {edit.mode}
          </Badge>
        )}
        {plan.monetizationFlag?.risky && (
          <Badge
            variant="destructive"
            className="absolute top-9 left-2 right-2 z-10 justify-center bg-destructive/15 text-destructive backdrop-blur"
            title={plan.monetizationFlag.reasons.join(", ")}
          >
            ⚠ monetization risk
          </Badge>
        )}
      </div>

      <CardContent className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold leading-snug">{plan.title}</h4>
        <p className="rounded-md border border-brand/20 bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand">
          Hook → <span className="font-normal text-muted-foreground">{plan.hook}</span>
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          <strong className="text-foreground">Why picked:</strong> {plan.reason}
        </p>

        {edit && (
          <div className="border-l-2 border-sky-500/35 pl-2.5 text-xs leading-relaxed text-muted-foreground">
            <strong className="text-foreground">Why this framing:</strong> {edit.routedReason}
            {edit.fallbackReason && (
              <div className="mt-1 text-destructive">⚠ {edit.fallbackReason}</div>
            )}
            {edit.retention && edit.retention["9:16"] < 0.9 && (
              <div className="mt-1 text-destructive">
                ⚠ this 9:16 crop keeps only {Math.round(edit.retention["9:16"] * 100)}% of the faces on
                screen — {edit.narrowestSafe} would keep more (phase 30 widens this)
              </div>
            )}
            <div className="mt-1 opacity-60">
              allowed [{edit.allowedModes.join(", ")}] · {edit.preset} preset · {edit.cameraKeyframes}{" "}
              keyframe{edit.cameraKeyframes === 1 ? "" : "s"} · {edit.encoder ?? "?"} · {edit.frames ?? "?"} frames
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1">
          {(plan.hashtags || []).map((h) => (
            <Badge key={h} variant="secondary" className="text-brand">
              {h.startsWith("#") ? h : `#${h}`}
            </Badge>
          ))}
        </div>

        <img src={output.thumbnail} alt={`thumbnail for ${plan.title}`} loading="lazy" className="rounded-md border" />

        <div className="flex gap-2">
          <a
            href={output.clip}
            download
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-brand py-2 text-xs font-medium text-brand-foreground hover:bg-brand/90"
          >
            <Download className="size-3.5" /> Clip
          </a>
          <a
            href={output.thumbnail}
            download
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Download className="size-3.5" /> Thumbnail
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
