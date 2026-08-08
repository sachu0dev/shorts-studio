import { useEffect, useState } from "react";
import { Loader2, PinOff } from "lucide-react";
import { YoutubeIcon } from "@/components/youtube-icon";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDashRuns, getDashLibrary, getDashChannels } from "@/lib/api";
import type { DashStageStat, DashSourceRow, Channel } from "@/types";

function bytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function ago(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** No number on this page is computed here — every field is read straight off phase 24's catalog rows or phase 32's channel metadata (phase 28 rule: read-only over the pipeline). */
export function DashboardPage() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div>
        <h2 className="text-lg font-semibold">Operations dashboard</h2>
        <p className="text-sm text-muted-foreground">What this system did, read straight off the catalog — nothing here is recomputed.</p>
      </div>
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="review" disabled>Review queue</TabsTrigger>
          <TabsTrigger value="published" disabled>Published</TabsTrigger>
          <TabsTrigger value="archive" disabled>Archive</TabsTrigger>
        </TabsList>
        <TabsContent value="runs"><RunsPanel /></TabsContent>
        <TabsContent value="library"><LibraryPanel /></TabsContent>
        <TabsContent value="channels"><ChannelsPanel /></TabsContent>
        <TabsContent value="review"><NotBuiltYet feature="Review queue" phase={25} /></TabsContent>
        <TabsContent value="published"><NotBuiltYet feature="Published (predicted vs. realized)" phase={27} /></TabsContent>
        <TabsContent value="archive"><NotBuiltYet feature="Archive" phase={25} /></TabsContent>
      </Tabs>
    </div>
  );
}

/** Gate 9: an unbuilt panel must never look like an empty table. */
function NotBuiltYet({ feature, phase }: { feature: string; phase: number }) {
  return (
    <Card className="mt-4">
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {feature} lands with phase {phase}, not built this pass.
      </CardContent>
    </Card>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Loading…
    </div>
  );
}

function RunsPanel() {
  const [stages, setStages] = useState<DashStageStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashRuns().then((r) => setStages(r.stages)).catch((e) => setError(String(e)));
  }, []);

  if (error) return <Card className="mt-4"><CardContent className="py-6 text-sm text-destructive">{error}</CardContent></Card>;
  if (!stages) return <Loading />;
  if (stages.length === 0) {
    return <Card className="mt-4"><CardContent className="py-8 text-center text-sm text-muted-foreground">No stage runs recorded yet — run a job.</CardContent></Card>;
  }

  return (
    <Card className="mt-4 py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Stage</TableHead>
            <TableHead className="text-right">Runs</TableHead>
            <TableHead className="text-right">Mean time</TableHead>
            <TableHead className="text-right">Cache hit rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stages
            .slice()
            .sort((a, b) => b.meanMs - a.meanMs)
            .map((s) => (
              <TableRow key={s.name}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="text-right">{s.runs}</TableCell>
                <TableCell className="text-right">{(s.meanMs / 1000).toFixed(1)}s</TableCell>
                <TableCell className="text-right">{Math.round(s.cacheHitRate * 100)}%</TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function LibraryPanel() {
  const [sources, setSources] = useState<DashSourceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashLibrary().then((r) => setSources(r.sources)).catch((e) => setError(String(e)));
  }, []);

  if (error) return <Card className="mt-4"><CardContent className="py-6 text-sm text-destructive">{error}</CardContent></Card>;
  if (!sources) return <Loading />;
  if (sources.length === 0) {
    return <Card className="mt-4"><CardContent className="py-8 text-center text-sm text-muted-foreground">No sources ingested yet.</CardContent></Card>;
  }

  return (
    <Card className="mt-4 py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead>Rights</TableHead>
            <TableHead className="text-right">Clips</TableHead>
            <TableHead className="text-right">Published</TableHead>
            <TableHead className="text-right">Disk</TableHead>
            <TableHead className="text-right">Last used</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="max-w-64 truncate font-medium" title={s.title ?? s.id}>
                {s.title ?? s.id}
                {s.pinned === 0 && s.mediaPath === null && (
                  <PinOff className="ml-1.5 inline size-3 text-muted-foreground" aria-label="evicted" />
                )}
              </TableCell>
              <TableCell><Badge variant={s.rights === "third-party" ? "destructive" : "secondary"}>{s.rights ?? "unknown"}</Badge></TableCell>
              <TableCell className="text-right">{s.clipCount}</TableCell>
              <TableCell className="text-right">{s.publishedCount}</TableCell>
              <TableCell className="text-right">{bytes(s.bytes)}</TableCell>
              <TableCell className="text-right text-muted-foreground">{ago(s.lastUsedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function ChannelsPanel() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDashChannels().then((r) => setChannels(r.channels)).catch((e) => setError(String(e)));
  }, []);

  if (error) return <Card className="mt-4"><CardContent className="py-6 text-sm text-destructive">{error}</CardContent></Card>;
  if (!channels) return <Loading />;
  if (channels.length === 0) {
    return <Card className="mt-4"><CardContent className="py-8 text-center text-sm text-muted-foreground">No channels linked yet — add one from Channels.</CardContent></Card>;
  }

  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {channels.map((c) => (
        <Card key={c.id}>
          <CardContent className="flex items-center gap-3 py-3">
            <YoutubeIcon className="size-5 shrink-0 text-red-600" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{c.title}</div>
              <div className="truncate text-xs text-muted-foreground">{c.customUrl ?? c.ytChannelId}</div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
