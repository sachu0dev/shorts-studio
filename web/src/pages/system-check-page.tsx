import { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, XCircle, RotateCw, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getSystemCheck } from "@/lib/api";
import type { CheckStatus, SystemCheckReport } from "@/types";

const STATUS_ICON: Record<CheckStatus, React.ReactNode> = {
  ok: <CheckCircle2 className="size-4 text-emerald-500" />,
  warn: <AlertTriangle className="size-4 text-amber-500" />,
  error: <XCircle className="size-4 text-destructive" />,
};

const OVERALL_LABEL: Record<CheckStatus, string> = {
  ok: "All good",
  warn: "Warnings",
  error: "Issues found",
};

const OVERALL_VARIANT: Record<CheckStatus, "default" | "destructive" | "secondary"> = {
  ok: "default",
  warn: "secondary",
  error: "destructive",
};

export function SystemCheckPage() {
  const [report, setReport] = useState<SystemCheckReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setReport(await getSystemCheck());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run();
  }, []);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">System check</h2>
          <p className="text-sm text-muted-foreground">Binaries, GPU, and API keys the pipeline depends on.</p>
        </div>
        <Button variant="outline" size="sm" onClick={run} disabled={loading} className="gap-1.5">
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
          Re-check
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="text-sm text-destructive">Check failed: {error}</CardContent>
        </Card>
      )}

      {loading && !report && (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {report && (
        <Card className="py-0">
          <CardContent className="divide-y p-0">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="text-sm font-medium">Overall</span>
              <Badge variant={OVERALL_VARIANT[report.overall]}>{OVERALL_LABEL[report.overall]}</Badge>
            </div>
            {report.results.map((r) => (
              <div key={r.name} className="flex items-start gap-3 px-4 py-3">
                {STATUS_ICON[r.status]}
                <div className="min-w-36 shrink-0 text-sm font-medium">{r.name}</div>
                <div className="break-all text-xs text-muted-foreground">{r.detail}</div>
              </div>
            ))}
            <div className="px-4 py-2 text-right text-xs text-muted-foreground">
              Checked at {new Date(report.checkedAt).toLocaleTimeString()}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
