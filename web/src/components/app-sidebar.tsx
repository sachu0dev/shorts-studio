import { Clapperboard, Plus, Activity, Loader2, CheckCircle2, XCircle, Clock } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import type { Job } from "@/types";
import type { View } from "@/App";
import { cn } from "@/lib/utils";

function jobLabel(job: Job): string {
  if (!job.url) return job.id;
  try {
    const u = new URL(job.url);
    return u.searchParams.get("v") || u.pathname.split("/").filter(Boolean).pop() || job.id;
  } catch {
    return job.id;
  }
}

const STATUS_ICON: Record<Job["status"], React.ReactNode> = {
  queued: <Clock className="size-3.5 text-muted-foreground" />,
  running: <Loader2 className="size-3.5 animate-spin text-brand" />,
  done: <CheckCircle2 className="size-3.5 text-emerald-500" />,
  error: <XCircle className="size-3.5 text-destructive" />,
};

export function AppSidebar({
  jobs,
  view,
  onSelect,
}: {
  jobs: Job[];
  view: View;
  onSelect: (v: View) => void;
}) {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="gap-2 cursor-default hover:bg-transparent">
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground">
                <Clapperboard className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-semibold">Shorts Studio</span>
                <span className="truncate text-xs text-muted-foreground">AI clip pipeline</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.kind === "new"} onClick={() => onSelect({ kind: "new" })}>
                  <Plus />
                  <span>New job</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={view.kind === "system"} onClick={() => onSelect({ kind: "system" })}>
                  <Activity />
                  <span>System check</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Jobs</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {jobs.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  No jobs yet
                </div>
              )}
              {jobs.map((job) => (
                <SidebarMenuItem key={job.id}>
                  <SidebarMenuButton
                    isActive={view.kind === "job" && view.id === job.id}
                    onClick={() => onSelect({ kind: "job", id: job.id })}
                    tooltip={job.url || job.id}
                  >
                    {STATUS_ICON[job.status]}
                    <span className={cn("truncate", job.status === "error" && "text-destructive")}>
                      {jobLabel(job)}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter />
    </Sidebar>
  );
}
