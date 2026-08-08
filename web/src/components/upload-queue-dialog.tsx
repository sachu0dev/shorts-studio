import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2, CircleCheck, CircleX, Clock, CalendarClock } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  listChannels, createUploadQueue, patchUploadQueue, startUploadQueue, getUploadQueue,
} from "@/lib/api";
import type { Channel, QueueMode, QueueItem, UploadQueue } from "@/types";
import { cn } from "@/lib/utils";

export interface QueueClip {
  clipId: string;
  title: string;
  thumbnail: string;
}

const GAP_PRESETS: { label: string; hours: number }[] = [
  { label: "Every 6 hours", hours: 6 },
  { label: "Every 12 hours", hours: 12 },
  { label: "Every 24 hours", hours: 24 },
  { label: "Every 48 hours", hours: 48 },
];

/** `datetime-local`'s value has no timezone; treat it as the browser's local time, same as the input itself does. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultFirstAt(): string {
  const d = new Date(Date.now() + 60 * 60_000); // +1h
  return toLocalInputValue(d.toISOString());
}

function SortableRow({ clip, index }: { clip: QueueClip; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip.clipId });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 rounded-md border bg-background px-2 py-2",
        isDragging && "opacity-60"
      )}
    >
      <button {...attributes} {...listeners} className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">{index + 1}</span>
      <img src={clip.thumbnail} alt="" className="h-12 w-8 shrink-0 rounded object-cover bg-black" />
      <p className="min-w-0 flex-1 truncate text-sm">{clip.title}</p>
    </div>
  );
}

const STATUS_LABEL: Record<QueueItem["status"], { label: string; icon: React.ReactNode }> = {
  pending: { label: "Waiting", icon: <Clock className="size-3.5 text-muted-foreground" /> },
  uploading: { label: "Uploading…", icon: <Loader2 className="size-3.5 animate-spin text-brand" /> },
  uploaded: { label: "Live", icon: <CircleCheck className="size-3.5 text-emerald-500" /> },
  scheduled: { label: "Scheduled", icon: <CalendarClock className="size-3.5 text-brand" /> },
  failed: { label: "Failed", icon: <CircleX className="size-3.5 text-destructive" /> },
};

export function UploadQueueDialog({
  jobId, clips, open, onOpenChange,
}: { jobId: string; clips: QueueClip[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [order, setOrder] = useState<string[]>(() => clips.map((c) => c.clipId));
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelId, setChannelId] = useState<string>("");
  const [mode, setMode] = useState<QueueMode>("unlisted");
  const [firstAt, setFirstAt] = useState(defaultFirstAt);
  const [gapHours, setGapHours] = useState(24);
  const [step, setStep] = useState<"configure" | "review">("configure");
  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const byId = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    if (!open) return;
    setOrder(clips.map((c) => c.clipId));
    setStep("configure");
    setQueue(null);
    setError(null);
    listChannels().then((cs) => {
      setChannels(cs);
      setChannelId((prev) => prev || cs[0]?.id || "");
    }).catch((e) => setError(e.message));
  }, [open, clips]);

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setOrder((cur) => {
      const from = cur.indexOf(String(active.id));
      const to = cur.indexOf(String(over.id));
      return arrayMove(cur, from, to);
    });
  }

  const previewTimes = useMemo(() => {
    if (mode !== "release") return null;
    const first = new Date(firstAt).getTime();
    const gapMs = gapHours * 3_600_000;
    if (!Number.isFinite(first)) return null;
    return order.map((_, i) => new Date(first + i * gapMs));
  }, [mode, firstAt, gapHours, order]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const q = await createUploadQueue(jobId, {
        clipIds: order,
        channelId,
        mode,
        schedule: mode === "release" ? { firstAt: new Date(firstAt).toISOString(), gapMs: gapHours * 3_600_000 } : undefined,
      });
      setQueue(q);
      setStep("review");
    } catch (e: any) {
      setError(e?.message || "Failed to create the upload queue");
    } finally {
      setBusy(false);
    }
  }

  async function handleTimeEdit(clipId: string, localValue: string) {
    const iso = new Date(localValue).toISOString();
    setQueue((q) => q && { ...q, items: q.items.map((i) => (i.clipId === clipId ? { ...i, publishAt: iso } : i)) });
    try {
      await patchUploadQueue(jobId, [{ clipId, publishAt: iso }]);
    } catch (e: any) {
      setError(e?.message || "Failed to save the edited time");
    }
  }

  function pollUntilDone() {
    pollRef.current = window.setInterval(async () => {
      try {
        const q = await getUploadQueue(jobId);
        setQueue(q);
        if (q.items.every((i) => i.status === "uploaded" || i.status === "scheduled" || i.status === "failed")) {
          if (pollRef.current) window.clearInterval(pollRef.current);
        }
      } catch {
        // transient — next tick retries
      }
    }, 2000);
  }

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      await startUploadQueue(jobId);
      pollUntilDone();
    } catch (e: any) {
      setError(e?.message || "Failed to start uploading");
      setBusy(false);
    }
  }

  const noChannels = channels !== null && channels.length === 0;
  const allTerminal = !!queue && queue.items.every((i) => i.status === "uploaded" || i.status === "scheduled" || i.status === "failed");
  const uploadStarted = !!queue && queue.items.some((i) => i.status !== "pending");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload queue — {clips.length} clip{clips.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            {step === "configure" ? "Order, channel, and release strategy." : "Review the schedule, then upload."}
          </DialogDescription>
        </DialogHeader>

        {error && <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

        {step === "configure" && (
          <div className="flex flex-col gap-5">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-1.5">
                  {order.map((id, i) => byId.get(id) && <SortableRow key={id} clip={byId.get(id)!} index={i} />)}
                </div>
              </SortableContext>
            </DndContext>

            <div className="flex flex-col gap-2">
              <Label className="text-sm">Channel</Label>
              {noChannels ? (
                <p className="text-xs text-muted-foreground">
                  No channels linked yet. Link one from the Channels page first.
                </p>
              ) : (
                <Select value={channelId} onValueChange={setChannelId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose a channel" /></SelectTrigger>
                  <SelectContent>
                    {(channels || []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-sm">Release</Label>
              <RadioGroup value={mode} onValueChange={(v) => setMode(v as QueueMode)} className="gap-2">
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="public" id="mode-public" className="mt-1" />
                  <Label htmlFor="mode-public" className="text-sm font-normal leading-snug">Public now</Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="unlisted" id="mode-unlisted" className="mt-1" />
                  <Label htmlFor="mode-unlisted" className="text-sm font-normal leading-snug">Unlisted now — reachable by link only</Label>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="release" id="mode-release" className="mt-1" />
                  <Label htmlFor="mode-release" className="text-sm font-normal leading-snug">
                    Release strategy — staggered
                    <span className="block text-muted-foreground">
                      Uploads now as private; YouTube publishes each one automatically at its own time below.
                    </span>
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {mode === "release" && (
              <div className="flex flex-col gap-3 rounded-md border p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 space-y-1.5">
                    <Label className="text-xs">First release</Label>
                    <Input type="datetime-local" value={firstAt} onChange={(e) => setFirstAt(e.target.value)} />
                  </div>
                  <div className="w-40 space-y-1.5">
                    <Label className="text-xs">Gap</Label>
                    <Select value={String(gapHours)} onValueChange={(v) => setGapHours(Number(v))}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {GAP_PRESETS.map((g) => (
                          <SelectItem key={g.hours} value={String(g.hours)}>{g.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {previewTimes && (
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {order.map((id, i) => (
                      <div key={id} className="flex justify-between gap-2">
                        <span className="truncate">{byId.get(id)?.title}</span>
                        <span className="shrink-0 font-mono">{previewTimes[i].toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === "review" && queue && (
          <div className="flex flex-col gap-1.5">
            {[...queue.items].sort((a, b) => a.order - b.order).map((item) => {
              const clip = byId.get(item.clipId);
              const st = STATUS_LABEL[item.status];
              return (
                <div key={item.clipId} className="flex items-center gap-3 rounded-md border px-2 py-2">
                  {clip && <img src={clip.thumbnail} alt="" className="h-12 w-8 shrink-0 rounded object-cover bg-black" />}
                  <p className="min-w-0 flex-1 truncate text-sm">{clip?.title}</p>
                  {item.publishAt && item.status === "pending" ? (
                    <Input
                      type="datetime-local"
                      defaultValue={toLocalInputValue(item.publishAt)}
                      onBlur={(e) => e.target.value && handleTimeEdit(item.clipId, e.target.value)}
                      className="w-48 shrink-0 text-xs"
                    />
                  ) : item.publishAt ? (
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {new Date(item.publishAt).toLocaleString()}
                    </span>
                  ) : null}
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" title={item.error}>
                    {st.icon} {st.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          {step === "configure" ? (
            <Button onClick={handleCreate} disabled={busy || noChannels || !channelId} className="bg-brand text-brand-foreground hover:bg-brand/90">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Review schedule"}
            </Button>
          ) : (
            <Button onClick={handleStart} disabled={busy || uploadStarted} className="bg-brand text-brand-foreground hover:bg-brand/90">
              {busy || (uploadStarted && !allTerminal) ? <Loader2 className="size-4 animate-spin" /> : null}
              {uploadStarted ? (allTerminal ? "Done" : "Uploading…") : `Upload ${queue?.items.length ?? 0} clip${queue?.items.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
