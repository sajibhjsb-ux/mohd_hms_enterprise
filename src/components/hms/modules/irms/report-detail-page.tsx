"use client";

// MOHD.HMS ENTERPRISE — dedicated Inspection Report detail page (irms view).
// Routing: /irms/{id} (list row click / post-create) or /irms/reports/{id}.
// Replaces the former detail dialog: same data (GET /api/v1/irms/reports/{id}),
// same workflow (POST …/{id}/transition submit|approve), same print-only
// document + scoping CSS (moved to page level), and Delete Draft now uses an
// AlertDialog instead of window.confirm. After submit/approve the detail is
// refreshed with the authoritative server record. No new APIs.

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCheck, Printer, Send, Trash2 } from "lucide-react";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";

// ── Types ──

type Finding = {
  id: string;
  finding: string;
  severity: string;
  recommendation: string;
};

type ReportDetail = {
  id: string;
  code: string;
  title: string;
  type: string;
  status: string;
  inspectionDate: string;
  summary: string;
  overallCondition: string;
  recommendations: string;
  project: { id: string; code: string; name: string; customer?: { companyName?: string | null } | null } | null;
  equipment: { id: string; name: string; assetTag: string } | null;
  inspector: { id: string; user?: { name?: string | null } | null } | null;
  findings: Finding[];
};

// ── Page ──

export function IrmsReportDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);

  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<ReportDetail>(`/api/v1/irms/reports/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this inspection report.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function transition(action: "submit" | "approve") {
    if (!detail) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/irms/reports/${detail.id}/transition`, { action });
      toast({
        title: action === "submit" ? "Report submitted" : "Report approved",
        description: `${detail.code} is now ${action === "submit" ? "SUBMITTED (awaiting approval)" : "APPROVED"}.`,
      });
      // Stay on the detail page — refresh with the authoritative server record.
      await load();
    } catch (e) {
      toast({
        title: action === "submit" ? "Submit failed" : "Approval failed",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function deleteDraft() {
    if (!detail) return;
    setBusy(true);
    try {
      await api.del(`/api/v1/irms/reports/${detail.id}`);
      toast({ title: "Draft deleted", description: `${detail.code} removed.` });
      navigateTo("irms");
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  // ── Load states ──
  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="/irms" title="Inspection report">
        <LoadingState label="Loading report…" rows={4} />
      </PageShell>
    );
  }
  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="/irms" title="Inspection report">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!detail) {
    return (
      <PageShell backLabel="Back to IRMS" backHref="/irms" title="Inspection report">
        <EmptyState title="Report not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const crumbTitle = detail.title || detail.code;

  return (
    <div>
      {printCss}
      {/* Print-only document (moved from the dialog to page level, unchanged) */}
      <div className="hidden print:block" id="irms-print-doc">
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1 }}>MOHD.HMS ENTERPRISE</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>Inspection Report</div>
        </div>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 16 }}>
          <tbody>
            <tr><td style={printTd}>Report Code</td><td style={printTd}>{detail.code}</td><td style={printTd}>Date</td><td style={printTd}>{fmtDate(detail.inspectionDate)}</td></tr>
            <tr><td style={printTd}>Project</td><td style={printTd}>{detail.project ? `${detail.project.code} — ${detail.project.name}` : "—"}</td><td style={printTd}>Customer</td><td style={printTd}>{detail.project?.customer?.companyName ?? "—"}</td></tr>
            <tr><td style={printTd}>Equipment</td><td style={printTd}>{detail.equipment ? `${detail.equipment.name} (${detail.equipment.assetTag})` : "—"}</td><td style={printTd}>Type</td><td style={printTd}>{humanize(detail.type)}</td></tr>
            <tr><td style={printTd}>Inspector</td><td style={printTd}>{detail.inspector?.user?.name ?? "—"}</td><td style={printTd}>Overall Condition</td><td style={printTd}>{humanize(detail.overallCondition)}</td></tr>
          </tbody>
        </table>
        <div style={{ fontSize: 13, fontWeight: 700, margin: "8px 0 4px" }}>Findings</div>
        {detail.findings.length === 0 ? (
          <div style={{ fontSize: 12 }}>No findings recorded.</div>
        ) : (
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={printTh}>#</th>
                <th style={printThLeft}>Finding</th>
                <th style={printTh}>Severity</th>
                <th style={printThLeft}>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {detail.findings.map((f, i) => (
                <tr key={f.id}>
                  <td style={printTd}>{i + 1}</td>
                  <td style={printTdLeft}>{f.finding}</td>
                  <td style={printTd}>{humanize(f.severity)}</td>
                  <td style={printTdLeft}>{f.recommendation || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 4px" }}>Summary</div>
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{detail.summary || "—"}</div>
        <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 4px" }}>Recommendations</div>
        <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{detail.recommendations || "—"}</div>
        <div style={{ marginTop: 32, fontSize: 12, display: "flex", justifyContent: "space-between" }}>
          <span>Inspector: ______________________</span>
          <span>Approved by: ______________________</span>
        </div>
      </div>

      <PageShell
        backLabel="Back to IRMS" backHref="/irms"
        crumbs={[{ label: "IRMS", href: "/irms" }, { label: crumbTitle }]}
        title={`${detail.code} — ${detail.title}`}
        description={`${detail.project ? `${detail.project.code} · ${detail.project.name}` : "Unlinked"} · ${humanize(detail.type)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.status} />
            {detail.status === "DRAFT" && canManage ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-4 w-4 mr-1.5 text-red-600" /> Delete Draft
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-1.5" /> Print
            </Button>
            <PdfButtons type="inspection-report" id={detail.id} label={`Inspection report ${detail.code}`} />
            {detail.status === "DRAFT" ? (
              <Button size="sm" disabled={busy} onClick={() => void transition("submit")}>
                <Send className="h-4 w-4 mr-1.5" /> {busy ? "Submitting…" : "Submit for Approval"}
              </Button>
            ) : null}
            {detail.status === "SUBMITTED" && canManage ? (
              <Button size="sm" disabled={busy} onClick={() => void transition("approve")}>
                <CheckCheck className="h-4 w-4 mr-1.5" /> {busy ? "Approving…" : "Approve"}
              </Button>
            ) : null}
          </div>
        }
      >
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Main column */}
          <div className="lg:col-span-2 space-y-4">
            <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                <Meta label="Inspection Date" value={fmtDate(detail.inspectionDate)} />
                <Meta label="Inspector" value={detail.inspector?.user?.name ?? "—"} />
                <Meta label="Overall Condition" value={<StatusBadge status={detail.overallCondition} />} />
                <Meta label="Project" value={detail.project ? `${detail.project.code} — ${detail.project.name}` : "—"} />
                <Meta label="Equipment" value={detail.equipment ? `${detail.equipment.name} (${detail.equipment.assetTag})` : "—"} />
                <Meta label="Findings" value={String(detail.findings.length)} />
              </div>
            </div>

            <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
              <div className="text-sm font-medium mb-1.5">Findings</div>
              {detail.findings.length === 0 ? (
                <p className="text-sm text-muted-foreground">No findings recorded.</p>
              ) : (
                <div className="rounded-lg border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left font-medium p-2.5">Finding</th>
                        <th className="text-left font-medium p-2.5 w-24">Severity</th>
                        <th className="text-left font-medium p-2.5">Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.findings.map((f) => (
                        <tr key={f.id} className="border-t">
                          <td className="p-2.5">{f.finding}</td>
                          <td className="p-2.5"><StatusBadge status={f.severity} /></td>
                          <td className="p-2.5 text-muted-foreground">{f.recommendation || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
              <div>
                <div className="text-sm font-medium mb-1">Summary</div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.summary || "—"}</p>
              </div>
              <Separator />
              <div>
                <div className="text-sm font-medium mb-1">Recommendations</div>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.recommendations || "—"}</p>
              </div>
            </div>
          </div>

          {/* Action column — contextual to role and status (mirrors old footer) */}
          <div className="space-y-3">
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2 no-print">
              <p className="text-sm font-medium">Workflow</p>
              <p className="text-xs text-muted-foreground">DRAFT → SUBMITTED → APPROVED. Submitted and approved reports are immutable records.</p>
              {detail.status === "DRAFT" ? (
                <Button disabled={busy} onClick={() => void transition("submit")} className="w-full">
                  <Send className="h-4 w-4 mr-1.5" /> {busy ? "Submitting…" : "Submit for Approval"}
                </Button>
              ) : null}
              {detail.status === "SUBMITTED" && canManage ? (
                <Button disabled={busy} onClick={() => void transition("approve")} className="w-full">
                  <CheckCheck className="h-4 w-4 mr-1.5" /> {busy ? "Approving…" : "Approve"}
                </Button>
              ) : null}
              {detail.status === "APPROVED" ? (
                <p className="text-xs text-muted-foreground">This report is approved — no further actions are available.</p>
              ) : null}
              {detail.status === "DRAFT" && canManage ? (
                <>
                  <Separator />
                  <p className="text-xs text-muted-foreground">Deleting removes this draft permanently.</p>
                  <Button variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)} className="w-full">
                    <Trash2 className="h-4 w-4 mr-1.5" /> Delete Draft
                  </Button>
                </>
              ) : null}
            </div>
            <div className="rounded-xl border bg-card shadow-sm p-4 no-print">
              <p className="text-sm font-medium mb-1">Print</p>
              <p className="text-xs text-muted-foreground mb-2">Generates the standard MOHD.HMS inspection document with findings and sign-off lines.</p>
              <Button variant="outline" onClick={() => window.print()} className="w-full">
                <Printer className="h-4 w-4 mr-1.5" /> Print Report
              </Button>
            </div>
          </div>
        </div>
        <WorkflowTimeline resourceType="InspectionReport" resourceId={detail.id} className="mt-6 no-print" />
      </PageShell>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft {detail.code} — {detail.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. The draft report and its findings will be removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep draft</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void deleteDraft()}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium mt-0.5">{value}</div>
    </div>
  );
}

// Print scoping: when printing, show only the print document (page-local,
// no changes to shared globals.css required).
const printCss = (
  <style>{`
    @media print {
      body * { visibility: hidden !important; }
      #irms-print-doc, #irms-print-doc * { visibility: visible !important; }
      #irms-print-doc {
        position: absolute !important;
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        padding: 24px !important;
        background: #fff !important;
        color: #000 !important;
      }
    }
  `}</style>
);

const printTd: CSSProperties = { border: "1px solid #999", padding: "6px 8px", fontWeight: 600, fontSize: 11 };
const printTdLeft: CSSProperties = { border: "1px solid #999", padding: "6px 8px", fontSize: 12 };
const printTh: CSSProperties = { border: "1px solid #999", padding: "6px 8px", background: "#eee", textAlign: "center", fontSize: 11 };
const printThLeft: CSSProperties = { border: "1px solid #999", padding: "6px 8px", background: "#eee", textAlign: "left", fontSize: 11 };
