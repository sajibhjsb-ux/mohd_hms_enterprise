"use client";

// IRMS module — enterprise Inspection Report Management System.
//
// NAVIGATION ARCHITECTURE: every business form/detail is a DEDICATED PAGE
// routed by the hash router (ui-store pages["irms"]) — no popup CRUD:
//   []                         → IRMS Dashboard (KPIs, recent, quick actions)
//   ["reports"]                → Inspection Reports list (server-paginated)
//   ["reports", "new"]         → Report Builder (5 tabs, draft-backed)
//   ["reports", id]            → Report detail (5 tabs)
//   ["reports", id, "edit"]    → Report Builder in edit mode
//   ["projects"]               → Inspection Projects section
//   ["projects", "new"]        → New Inspection Project page (draft-backed)
//   ["projects", id, "edit"]   → Edit Project page
//   ["calendar"]               → Inspection scheduling calendar
//   ["analytics"]              → IRMS analytics
//   CUSTOMER role              → Customer portal view (shared/approved reports
//                                only — no internal IRMS administration, §5/§41)

import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { pageFromSeg } from "@/lib/hms/router";
import { IrmsDashboardPage, IrmsProjectsSection, IrmsSectionNav } from "./irms-dashboard";
import { IrmsReportsList } from "./irms-reports-list";
import { IrmsReportBuilder } from "./irms-report-builder";
import { IrmsReportDetailPage } from "./irms-report-detail";
import { IrmsCalendarPage } from "./irms-calendar";
import { IrmsAnalyticsPage } from "./irms-analytics";
import { IrmsPortalPage } from "./irms-portal";
import { IrmsProjectNewPage, IrmsProjectEditPage } from "./project-page";

export function IrmsModule() {
  const { user } = useSession();
  const seg = useUi((s) => s.pages["irms"]) ?? [];
  const page = pageFromSeg(seg);

  // ── Customer portal: customers see ONLY shared/approved reports (§41).
  //    No internal IRMS administration is reachable for the CUSTOMER role.
  if (user?.role === "CUSTOMER") return <IrmsPortalPage />;

  // pageFromSeg quirk: single segment ["reports"] parses as {view:"detail",
  // id:"reports"} — resolve section slugs first, then fall back to detail-by-id.
  if (page.view === "detail" && page.id) {
    if (page.id === "reports") return <IrmsReportsList />;
    if (page.id === "projects") return <IrmsProjectsSection />;
    if (page.id === "calendar") return <IrmsCalendarPage />;
    if (page.id === "analytics") return <IrmsAnalyticsPage />;
    return <IrmsReportDetailPage id={page.id} />; // /irms/{reportId} deep link
  }

  // Reports
  if (page.view === "reports" && page.id === "new") return <IrmsReportBuilder />;
  if (page.view === "reports-edit" && page.id) return <IrmsReportBuilder reportId={page.id} />;
  if (page.view === "reports" && page.id) return <IrmsReportDetailPage id={page.id} />;

  // Projects (existing dedicated pages preserved)
  if (page.view === "projects" && page.id === "new") return <IrmsProjectNewPage />;
  if ((page.view === "edit" || page.view === "projects-edit") && page.id) return <IrmsProjectEditPage id={page.id} />;
  if (page.view === "projects" && page.id) return <IrmsProjectsSection />;

  return <IrmsDashboardPage />;
}

export { IrmsSectionNav };
