import { useEffect, useState } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { NewJobPage } from "@/pages/new-job-page";
import { JobPage } from "@/pages/job-page";
import { SystemCheckPage } from "@/pages/system-check-page";
import { listJobs } from "@/lib/api";
import type { Job } from "@/types";

export type View = { kind: "new" } | { kind: "system" } | { kind: "job"; id: string };

const TITLES: Record<View["kind"], string> = {
  new: "New job",
  system: "System check",
  job: "Job",
};

export default function App() {
  const [view, setView] = useState<View>({ kind: "new" });
  const [jobs, setJobs] = useState<Job[]>([]);

  // The sidebar's job list is a light poll, not SSE — SSE is per-job and only
  // the open JobPage subscribes to it. Refreshing while a job is selected also
  // catches its status flipping to done/error for the sidebar icon.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => listJobs().then((j) => !cancelled && setJobs(j)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const title = view.kind === "job" ? jobLabel(jobs, view.id) : TITLES[view.kind];

  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <AppSidebar jobs={jobs} view={view} onSelect={setView} />
        <SidebarInset>
          <SiteHeader title={title} />
          <div className="flex-1 overflow-auto">
            {view.kind === "new" && <NewJobPage onCreated={(id) => setView({ kind: "job", id })} />}
            {view.kind === "system" && <SystemCheckPage />}
            {view.kind === "job" && <JobPage jobId={view.id} />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function jobLabel(jobs: Job[], id: string): string {
  const job = jobs.find((j) => j.id === id);
  return job?.url || id;
}
