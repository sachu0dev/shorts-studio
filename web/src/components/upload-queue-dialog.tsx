import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Loader2, CircleCheck, CircleX, Clock, CalendarClock, ChevronDown, Pencil } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
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

type GapUnit = "minutes" | "hours" | "days";
const GAP_UNIT_MS: Record<GapUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

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
        "flex min-w-0 items-center gap-3 rounded-lg border bg-background px-3 py-2.5 transition-colors hover:border-foreground/20",
        isDragging && "opacity-60 shadow-lg"
      )}
    >
      <button {...attributes} {...listeners} className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing">
        <GripVertical className="size-4" />
      </button>
      <span className="w-5 shrink-0 text-center text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <img src={clip.thumbnail} alt="" className="h-16 w-11 shrink-0 rounded object-cover bg-black" />
      <p className="min-w-0 flex-1 truncate text-sm">{clip.title}</p>
    </div>
  );
}

/** Editable title (inline) + a collapsible description override — only while the item hasn't started uploading. */
function ReviewRow({
  item, clip, onTimeEdit, onTitleEdit, onDescriptionEdit,
}: {
  item: QueueItem;
  clip: QueueClip | undefined;
  onTimeEdit: (clipId: string, localValue: string) => void;
  onTitleEdit: (clipId: string, value: string) => void;
  onDescriptionEdit: (clipId: string, value: string) => void;
}) {
  const [descOpen, setDescOpen] = useState(false);
  const st = STATUS_LABEL[item.status];
  const editable = item.status === "pending";
  // Scheduled items already have a videoId on YouTube — the server pushes a
  // time change there via videos.update instead of just rewriting the local
  // record, so it's safe to let these stay editable too.
  const timeEditable = editable || item.status === "failed" || item.status === "scheduled";

  return (
    <Collapsible
      open={descOpen}
      onOpenChange={setDescOpen}
      className="flex min-w-0 flex-col gap-2.5 rounded-lg border px-3 py-3 transition-colors hover:border-foreground/20"
    >
      <div className="flex min-w-0 items-center gap-3">
        {clip && <img src={clip.thumbnail} alt="" className="h-16 w-11 shrink-0 rounded object-cover bg-black" />}
        {editable ? (
          <Input
            defaultValue={item.titleOverride || clip?.title || ""}
            onBlur={(e) => onTitleEdit(item.clipId, e.target.value)}
            className="min-w-0 flex-1 text-sm"
          />
        ) : (
          <p className="min-w-0 flex-1 text-sm break-words">{item.titleOverride || clip?.title}</p>
        )}
        {editable && (
          <CollapsibleTrigger asChild>
            <button className="shrink-0 text-muted-foreground hover:text-foreground" title="Edit description">
              {descOpen ? <ChevronDown className="size-4" /> : <Pencil className="size-3.5" />}
            </button>
          </CollapsibleTrigger>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3 pl-14">
        {item.publishAt && timeEditable ? (
          <Input
            key={item.publishAt}
            type="datetime-local"
            defaultValue={toLocalInputValue(item.publishAt)}
            onBlur={(e) => e.target.value && onTimeEdit(item.clipId, e.target.value)}
            className="w-52 shrink-0 text-xs"
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
      <CollapsibleContent>
        <Textarea
          defaultValue={item.descriptionOverride || ""}
          placeholder="Leave blank to use the AI-generated description (the promo footer is always appended)."
          onBlur={(e) => onDescriptionEdit(item.clipId, e.target.value)}
          className="min-h-24 text-xs"
        />
      </CollapsibleContent>
    </Collapsible>
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
  const [gapValue, setGapValue] = useState(24);
  const [gapUnit, setGapUnit] = useState<GapUnit>("hours");
  const gapMs = Math.max(0, gapValue) * GAP_UNIT_MS[gapUnit];
  const [step, setStep] = useState<"configure" | "review">("configure");
  const [queue, setQueue] = useState<UploadQueue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const byId = useMemo(() => new Map(clips.map((c) => [c.clipId, c])), [clips]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // `clips` gets a brand-new array/object reference every time the job page
  // re-renders (SSE updates, polling) even when its contents are unchanged —
  // depending on it here reset the drag order out from under the user mid-use.
  // A ref sidesteps that: always current, but never itself a reactive trigger.
  const clipsRef = useRef(clips);
  clipsRef.current = clips;

  useEffect(() => {
    if (!open) return;
    setError(null);
    listChannels().then((cs) => {
      setChannels(cs);
      setChannelId((prev) => prev || cs[0]?.id || "");
    }).catch((e) => setError(e.message));

    // Resume an existing queue for this job instead of always rebuilding one
    // (POSTing a fresh queue resets every item back to "pending", which would
    // lose track of what already uploaded and risk re-uploading duplicates).
    getUploadQueue(jobId)
      .then((q) => {
        setQueue(q);
        setOrder(q.items.slice().sort((a, b) => a.order - b.order).map((i) => i.clipId));
        setChannelId(q.items[0]?.channelId || "");
        setStep("review");
      })
      .catch(() => {
        setOrder(clipsRef.current.map((c) => c.clipId));
        setStep("configure");
        setQueue(null);
      });
  }, [open, jobId]);

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
    if (!Number.isFinite(first)) return null;
    return order.map((_, i) => new Date(first + i * gapMs));
  }, [mode, firstAt, gapMs, order]);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      const q = await createUploadQueue(jobId, {
        clipIds: order,
        channelId,
        mode,
        schedule: mode === "release" ? { firstAt: new Date(firstAt).toISOString(), gapMs } : undefined,
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
    try {
      // Trust the server's response rather than assuming success — a
      // reschedule on an already-live video can be rejected by YouTube, in
      // which case the item's real (unchanged) time comes back instead.
      const q = await patchUploadQueue(jobId, [{ clipId, publishAt: iso }]);
      setQueue(q);
      if (q.errors?.length) setError(q.errors.join("; "));
    } catch (e: any) {
      setError(e?.message || "Failed to save the edited time");
    }
  }

  async function handleTitleEdit(clipId: string, value: string) {
    const titleOverride = value.trim() || undefined;
    setQueue((q) => q && { ...q, items: q.items.map((i) => (i.clipId === clipId ? { ...i, titleOverride } : i)) });
    try {
      await patchUploadQueue(jobId, [{ clipId, titleOverride: titleOverride ?? "" }]);
    } catch (e: any) {
      setError(e?.message || "Failed to save the edited title");
    }
  }

  async function handleDescriptionEdit(clipId: string, value: string) {
    const descriptionOverride = value.trim() || undefined;
    setQueue((q) => q && { ...q, items: q.items.map((i) => (i.clipId === clipId ? { ...i, descriptionOverride } : i)) });
    try {
      await patchUploadQueue(jobId, [{ clipId, descriptionOverride: descriptionOverride ?? "" }]);
    } catch (e: any) {
      setError(e?.message || "Failed to save the edited description");
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
    } finally {
      // The server call only confirms the run started — actual per-item
      // progress comes from polling (isUploading), not this flag.
      setBusy(false);
    }
  }

  const noChannels = channels !== null && channels.length === 0;
  const isUploading = !!queue && queue.items.some((i) => i.status === "uploading");
  // Items already "uploaded"/"scheduled" are skipped server-side on every
  // start call, so it's always safe to re-trigger while anything failed or
  // never got attempted — that's exactly a retry, not a re-upload.
  const retryCount = queue?.items.filter((i) => i.status === "failed" || i.status === "pending").length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[95vw] max-w-4xl flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <DialogTitle>Upload queue — {clips.length} clip{clips.length === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            {step === "configure" ? "Order, channel, and release strategy." : "Review the schedule, then upload."}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">
        {error && <div className="mb-4 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

        {step === "configure" && (
          <div className="flex min-w-0 flex-col gap-6">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={order} strategy={verticalListSortingStrategy}>
                <div className="flex min-w-0 flex-col gap-2">
                  {order.map((id, i) => byId.get(id) && <SortableRow key={id} clip={byId.get(id)!} index={i} />)}
                </div>
              </SortableContext>
            </DndContext>

            <div className="grid min-w-0 gap-6 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
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

              <div className="flex min-w-0 flex-col gap-2">
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
            </div>

            {mode === "release" && (
              <div className="flex min-w-0 flex-col gap-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-end gap-4">
                  <div className="min-w-48 flex-1 space-y-1.5">
                    <Label className="text-xs">First release</Label>
                    <Input type="datetime-local" value={firstAt} onChange={(e) => setFirstAt(e.target.value)} />
                  </div>
                  <div className="w-44 shrink-0 space-y-1.5">
                    <Label className="text-xs">Gap</Label>
                    <div className="flex gap-1.5">
                      <Input
                        type="number"
                        min={0}
                        value={gapValue}
                        onChange={(e) => setGapValue(Number(e.target.value))}
                        className="w-16"
                      />
                      <Select value={gapUnit} onValueChange={(v) => setGapUnit(v as GapUnit)}>
                        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="minutes">minutes</SelectItem>
                          <SelectItem value="hours">hours</SelectItem>
                          <SelectItem value="days">days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
                {previewTimes && (
                  <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
                    {order.map((id, i) => (
                      <div key={id} className="flex min-w-0 justify-between gap-3">
                        <span className="min-w-0 truncate">{byId.get(id)?.title}</span>
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
          <div className="flex min-w-0 flex-col gap-2">
            {[...queue.items].sort((a, b) => a.order - b.order).map((item) => (
              <ReviewRow
                key={item.clipId}
                item={item}
                clip={byId.get(item.clipId)}
                onTimeEdit={handleTimeEdit}
                onTitleEdit={handleTitleEdit}
                onDescriptionEdit={handleDescriptionEdit}
              />
            ))}
          </div>
        )}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4 sm:justify-between">
          {step === "configure" ? (
            <Button onClick={handleCreate} disabled={busy || noChannels || !channelId} className="bg-brand text-brand-foreground hover:bg-brand/90">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Review schedule"}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => {
                  const hasProgress = queue!.items.some((i) => i.status !== "pending");
                  if (hasProgress && !confirm("Some clips already uploaded or failed under this queue. Starting over won't undo YouTube uploads, just the tracking here — already-uploaded clips could get uploaded again. Continue?")) return;
                  setStep("configure");
                }}
              >
                Start over
              </Button>
              <Button onClick={handleStart} disabled={busy || isUploading || retryCount === 0} className="bg-brand text-brand-foreground hover:bg-brand/90">
                {busy || isUploading ? <Loader2 className="size-4 animate-spin" /> : null}
                {isUploading ? "Uploading…" : retryCount > 0 ? `Upload ${retryCount} clip${retryCount === 1 ? "" : "s"}` : "Done — all uploaded"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
