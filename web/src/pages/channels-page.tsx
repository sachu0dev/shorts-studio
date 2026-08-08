import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { YoutubeIcon } from "@/components/youtube-icon";
import { listChannels, removeChannel } from "@/lib/api";
import type { Channel } from "@/types";

export function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => listChannels().then(setChannels).catch((e) => setError(e.message));

  useEffect(() => {
    refresh();
  }, []);

  async function handleRemove(id: string) {
    setRemoving(id);
    try {
      await removeChannel(id);
      await refresh();
    } catch (e: any) {
      setError(e?.message || "Failed to remove channel");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Channels</h2>
          <p className="text-sm text-muted-foreground">
            YouTube channels this app can publish to. One Google account, several brand
            accounts, or several separate accounts — link each one you upload to.
          </p>
        </div>
        <a
          href="/api/channels/connect"
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-foreground hover:bg-brand/90"
        >
          <Plus className="size-4" /> Add channel
        </a>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked</CardTitle>
          <CardDescription>
            If Google asks which account to continue as, pick the one that owns the channel
            you want to link — not necessarily your default one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {channels === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No channels linked yet. Add one to enable uploads.
            </p>
          ) : (
            <div className="flex flex-col divide-y">
              {channels.map((c) => (
                <div key={c.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  {c.thumbnailUrl ? (
                    <img src={c.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                      <YoutubeIcon className="size-5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.customUrl || c.ytChannelId} · linked {new Date(c.addedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemove(c.id)}
                    disabled={removing === c.id}
                    title="Unlink this channel"
                    className="flex shrink-0 items-center justify-center rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    {removing === c.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  </button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
