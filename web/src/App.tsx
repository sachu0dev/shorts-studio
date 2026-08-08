import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { NewJobPage } from "@/pages/new-job-page";
import { JobPage } from "@/pages/job-page";
import { SystemCheckPage } from "@/pages/system-check-page";
import { ChannelsPage } from "@/pages/channels-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { listJobs } from "@/lib/api";
import type { Job } from "@/types";

function Layout() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    const refresh = () => listJobs().then((j) => !cancelled && setJobs(j)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const getTitle = () => {
    if (location.pathname === "/") return "New job";
    if (location.pathname === "/system") return "System check";
    if (location.pathname === "/channels") return "Channels";
    if (location.pathname === "/dashboard") return "Dashboard";
    if (location.pathname.startsWith("/jobs/")) {
      const id = location.pathname.replace("/jobs/", "");
      const job = jobs.find((j) => j.id === id);
      return job?.url || id || "Job";
    }
    return "Shorts Studio";
  };

  return (
    <TooltipProvider delayDuration={200}>
      <SidebarProvider>
        <AppSidebar jobs={jobs} />
        <SidebarInset>
          <SiteHeader title={getTitle()} />
          <div className="flex-1 overflow-auto">
            <Routes>
              <Route path="/" element={<NewJobPage onCreated={(id) => navigate(`/jobs/${id}`)} />} />
              <Route path="/system" element={<SystemCheckPage />} />
              <Route path="/channels" element={<ChannelsPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/jobs/:id" element={<JobPageRoute />} />
            </Routes>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function JobPageRoute() {
  const params = useParams<{ id: string }>();
  return <JobPage jobId={params.id ?? ""} />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<Layout />} />
      </Routes>
    </BrowserRouter>
  );
}
