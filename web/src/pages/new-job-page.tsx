import { useState, useEffect } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createJob, getSystemCheck } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AiProvider } from "@/types";

const PROVIDERS: { value: AiProvider; label: string; sub?: string }[] = [
  { value: "gemini", label: "Gemini", sub: "Flash 2.0 (Fast)" },
  { value: "groq", label: "Groq", sub: "Llama 3.3 70B (Free)" },
  { value: "openrouter", label: "OpenRouter", sub: "Gemma 4 26B (Free)" },
  { value: "cerebras", label: "Cerebras", sub: "70B Ultra Fast" },
  { value: "anthropic", label: "Claude", sub: "Sonnet 4.6" },
  { value: "openai", label: "GPT-4o", sub: "OpenAI" },
  { value: "ollama", label: "Ollama", sub: "Qwen 3B (Local)" },
];

export function NewJobPage({ onCreated }: { onCreated: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [clipCount, setClipCount] = useState("auto");
  const [provider, setProvider] = useState<AiProvider>("gemini");
  const [description, setDescription] = useState("");
  const [controversialMode, setControversialMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ollamaCheck, setOllamaCheck] = useState<{ available: boolean; detail: string } | null>(null);

  useEffect(() => {
    getSystemCheck()
      .then((report) => {
        const res = report.results.find((r) => r.name.toLowerCase().includes("ollama"));
        if (res) {
          setOllamaCheck({
            available: res.status === "ok",
            detail: res.detail,
          });
        }
      })
      .catch(() => {
        setOllamaCheck({
          available: false,
          detail: "Could not run system check",
        });
      });
  }, []);

  async function submit() {
    if (!url.trim() && !file) {
      setError("Paste a URL or choose a file first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await createJob({
        url: url.trim() || undefined,
        file: file ?? undefined,
        clipCount,
        aiProvider: provider,
        description: description.trim(),
        controversialMode,
      });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">New job</h2>
        <p className="text-sm text-muted-foreground">
          Paste a video URL, or upload a file, and the pipeline picks clips, writes scripts, and renders them.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Source</CardTitle>
          <CardDescription>YouTube or any yt-dlp-supported platform, or a local file.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-3">
            <div className="flex-1 space-y-2">
              <Label htmlFor="url">Video URL</Label>
              <Input
                id="url"
                type="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!!file}
              />
            </div>
            <div className="w-28 space-y-2">
              <Label htmlFor="count">Clips</Label>
              <Select value={clipCount} onValueChange={setClipCount}>
                <SelectTrigger id="count" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto</SelectItem>
                  {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            or upload a file
            <div className="h-px flex-1 bg-border" />
          </div>
          <Input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI provider</CardTitle>
          <CardDescription>Select cloud or local models for clip selection and scripting.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PROVIDERS.map((p) => {
              const isOllama = p.value === "ollama";
              const isOllamaDisabled = isOllama && ollamaCheck !== null && !ollamaCheck.available;
              return (
                <button
                  key={p.value}
                  type="button"
                  disabled={isOllamaDisabled}
                  onClick={() => setProvider(p.value)}
                  className={cn(
                    "flex flex-col items-center justify-center rounded-md border p-2.5 text-center transition-colors",
                    provider === p.value
                      ? "border-brand bg-brand/10 text-brand font-medium"
                      : "border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    isOllamaDisabled && "opacity-40 cursor-not-allowed bg-muted/10"
                  )}
                >
                  <div className="flex items-center justify-center gap-1.5 text-sm font-medium">
                    <span>{p.label}</span>
                    {isOllama && (
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          ollamaCheck?.available ? "bg-emerald-500" : "bg-muted-foreground/40"
                        )}
                      />
                    )}
                  </div>
                  {p.sub && <span className="text-[10px] text-muted-foreground/80 mt-0.5">{p.sub}</span>}
                </button>
              );
            })}
          </div>

          {ollamaCheck && !ollamaCheck.available && (
            <p className="text-[11px] text-muted-foreground/70">
              Ollama offline · Run <code className="font-mono text-muted-foreground">ollama serve && ollama pull qwen2.5:3b</code> to enable local AI.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Creator instructions</CardTitle>
          <CardDescription>Optional. Trend context, tone, what to avoid, target audience.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Textarea
            rows={6}
            placeholder="e.g. Focus on moments where the speaker is emotional or drops a punchline. Avoid religious or political clips. Target: college students 18-24."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="controversial"
              checked={controversialMode}
              onCheckedChange={(v) => setControversialMode(v === true)}
            />
            <Label htmlFor="controversial" className="text-sm font-normal">
              Allow controversial/edgy content (disables the safe-content selection bias)
            </Label>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Button size="lg" onClick={submit} disabled={submitting} className="gap-2 bg-brand text-brand-foreground hover:bg-brand/90">
        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
        Make Shorts
      </Button>
    </div>
  );
}
