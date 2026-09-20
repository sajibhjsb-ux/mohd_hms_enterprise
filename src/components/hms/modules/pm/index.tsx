"use client";

// MOHD.HMS ENTERPRISE — Preventive Maintenance module shell.
//
// NAVIGATION ARCHITECTURE (path router, ui-store pages["pm"]):
//   []                     → tabbed workspace (?tab=dashboard|plans|schedule|calendar|templates|reports)
//   ["new"]                → PmNewPage (dedicated create-plan page; ?templateId= prefills checklist)
//   ["plans", planId]      → PmPlanDetailPage
//   ["tasks", taskId]      → PmTaskDetailPage (full execution cockpit)
//
// Tab state lives in the module URL query (?tab=schedule&due=today…) so KPI
// drill-downs, browser Back/Forward and deep links all work through the
// central router — the same pattern every other module uses for filters.

import { useUi } from "@/lib/hms/ui-store";
import { pageFromSeg } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PmNewPage } from "./new-page";
import { PmPlanDetailPage } from "./plan-detail";
import { PmTaskDetailPage } from "./task-detail";
import { PmDashboard } from "./dashboard-tab";
import { PmPlansTab } from "./plans-tab";
import { PmScheduleTab } from "./schedule-tab";
import { PmCalendarTab } from "./calendar-tab";
import { PmTemplatesTab } from "./templates-tab";
import { PmReportsTab } from "./reports-tab";

export const PM_TABS = [
  { value: "dashboard", label: "Dashboard" },
  { value: "plans", label: "Plans" },
  { value: "schedule", label: "Schedule" },
  { value: "calendar", label: "Calendar" },
  { value: "templates", label: "Templates" },
  { value: "reports", label: "Reports" },
] as const;

export type PmTabValue = (typeof PM_TABS)[number]["value"];

export function PmModule() {
  const seg = useUi((s) => s.pages["pm"]) ?? [];
  const query = useUi((s) => s.queries["pm"] ?? "");
  const page = pageFromSeg(seg);

  if (page.view === "new") return <PmNewPage />;
  if (page.view === "plans" && page.id) return <PmPlanDetailPage id={page.id} />;
  if (page.view === "tasks" && page.id) return <PmTaskDetailPage id={page.id} />;
  // Fallbacks for deep links that predate the sub-path scheme.
  if (page.view === "detail" && page.id) return <PmPlanDetailPage id={page.id} />;
  if (page.view === "complete" && page.id) return <PmTaskDetailPage id={page.id} />;

  // key={query}: a new drill-down URL (KPI click / Back / direct link) remounts
  // the workspace with the query params applied.
  return <PmWorkspace key={query} />;
}

function PmWorkspace() {
  const { user } = useSession();
  const dq = useModuleQuery("pm");
  const canReport = hasPerm(user, PERMISSIONS.pm_report);

  const tabParam = (dq.params.tab ?? "dashboard").toLowerCase();
  const tab: PmTabValue = (PM_TABS.find((t) => t.value === tabParam)?.value ?? "dashboard") as PmTabValue;

  const setTab = (next: PmTabValue) => {
    // Schedule-specific drill params belong to the schedule tab only — clear
    // them when switching away so returning to Schedule is unfiltered.
    const isSchedule = next === "schedule";
    dq.apply({
      tab: next === "dashboard" ? undefined : next,
      ...(isSchedule ? {} : { due: undefined, status: undefined, overdue: undefined, mine: undefined, priority: undefined }),
    });
  };

  return (
    <div>
      <div className="mb-4 flex gap-1 overflow-x-auto pb-1 -mx-1 px-1 hms-scroll" role="tablist" aria-label="Preventive maintenance sections">
        {PM_TABS.filter((t) => t.value !== "reports" || canReport).map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
            className={`whitespace-nowrap rounded-full px-3.5 py-2 min-h-[44px] text-sm font-medium border transition-colors ${
              tab === t.value
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted text-muted-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "dashboard" ? <PmDashboard />
      : tab === "plans" ? <PmPlansTab />
      : tab === "schedule" ? <PmScheduleTab />
      : tab === "calendar" ? <PmCalendarTab />
      : tab === "templates" ? <PmTemplatesTab />
      : tab === "reports" ? <PmReportsTab />
      : null}
    </div>
  );
}
