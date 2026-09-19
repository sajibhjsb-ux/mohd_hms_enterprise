"use client";

// MOHD.HMS ENTERPRISE — dedicated Inspection Report detail page (rewrite).
// Routing: /irms/reports/{id} (canonical) and legacy /irms/{id} deep links.
//
// PageShell with back-to-Reports; header shows code + StatusBadge +
// PriorityBadge + "Rev N" + customer-visibility badge; header actions: Edit
// (editable + permitted), PdfButtons type="inspection-report" (Download +
// Preview), QR image (GET …/qr → object URL, tooltip "Scan to open report
// (authorized users only)"). 5 tabs: DETAILS (read-only kv), WORK DETAILS
// (read-only blocks incl. findings table + completion progress), PHOTOS
// (IrmsPhotoManager — editable only when status/permission allow), SIGNATURES
// (history + pad), APPROVAL (workflow panel per role/status + customerVisible
// switch + approval history timeline + revisions w/ restore). Realtime
// refresh on MODULE_EVENTS.irms (pageDirty-safe). No fake success (§67).

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/hms/api-client";
import { customerLabel, fmtDate, fmtDateTime } from "@/lib/hms/format";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, PriorityBadge, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";
import { humanize, PERMISSIONS, STATUS_TONE } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BadgeCheck, Building2, ClipboardList, Eye, History, Images, Loader2, Pencil, PenTool, Undo2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IrmsPhotoManager, type IrmsPhoto } from "./irms-photo-manager";
import { IrmsSignaturePanel } from "./irms-signature-pad";

// ── Types ──

type Finding = { id: string; finding: string; severity: string; recommendation?: string | null };

type ReportDetail = {
  id: string;
  code: string;
  title: string;
  type: string;
  priority?: string | null;
  status: string;
  revision?: number;
  inspectionDate: string | null;
  summary?: string | null;
  overallCondition?: string | null;
  recommendations?: string | null;
  customerVisible?: boolean;
  jobOrderNo?: string | null;
  building?: string | null;
  floor?: string | null;
  room?: string | null;
  taskDescription?: string | null;
  scope?: string | null;
  notes?: string | null;
  correctiveActions?: string | null;
  rootCause?: string | null;
  safetyNotes?: string | null;
  materials?: string | null;
  labourHours?: number | null;
  completionPercent?: number | null;
  project: { id: string; code: string; name: string; customer?: { id: string; companyName?: string | null; contactPerson?: string | null } | null } | null;
  equipment: { id: string; name: string; assetTag: string } | null;
  workOrder: { id: string; code: string; title?: string | null } | null;
  inspector: { id: string; employeeNo?: string; user?: { id?: string; name?: string | null } | null } | null;
  findings: Finding[];
  photos: IrmsPhoto[];
  signatures: { id: string; role: string; name: string; signedAt: string; revision?: number | null; url: string }[];
  approvals: { id: string; step: string; fromStatus: string; toStatus: string; comment?: string | null; userName?: string | null; createdAt: string }[];
  revisions: { id: string; version: number; note?: string | null; createdByName?: string | null; createdAt: string }[];
};

const EDITABLE_STATUSES = ["DRAFT", "REJECTED"];

// ── Page ──

export function IrmsReportDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.irms_manage);
  const canCreate = hasPerm(user, PERMISSIONS.irms_create);

  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState("details");
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ReportDetail>(`/api/v1/irms/reports/${id}`);
      setDetail(res.data);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this inspection report.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Realtime refresh (pageDirty-safe inside the hook).
  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  // QR image (endpoint 16) → object URL; revoked on unmount.
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    fetch(`/api/v1/irms/reports/${id}/qr`, { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`QR unavailable (${r.status})`);
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("image/png")) throw new Error("QR unavailable");
        return r.blob();
      })
      .then((b) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(b);
        setQrUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Reports" backHref="/irms/reports" title="Inspection report">
        <LoadingState label="Loading report…" rows={4} />
      </PageShell>
    );
  }
  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Reports" backHref="/irms/reports" title="Inspection report">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!detail) {
    return (
      <PageShell backLabel="Back to Reports" backHref="/irms/reports" title="Inspection report">
        <EmptyState title="Report not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const isEditable = EDITABLE_STATUSES.includes(detail.status);
  const canEdit = isEditable && canCreate;
  const canEditPhotos = isEditable && canCreate;

  const crumbTitle = detail.title || detail.code;

  return (
    <div>
      <PageShell
        backLabel="Back to Reports"
        backHref="/irms/reports"
        crumbs={[
          { label: "IRMS", href: "/irms" },
          { label: "Reports", href: "/irms/reports" },
          { label: crumbTitle },
        ]}
        title={`${detail.code} — ${detail.title}`}
        description={`${detail.project ? `${detail.project.code} · ${detail.project.name}` : "Unlinked"} · ${humanize(detail.type)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.status} />
            <PriorityBadge priority={detail.priority} />
            {typeof detail.revision === "number" ? <Badge variant="outline" className="bg-muted/40">Rev {detail.revision}</Badge> : null}
            {detail.customerVisible ? (
              <Badge variant="outline" className="border-primary/40 bg-primary/5 text-primary">Shared to customer</Badge>
            ) : null}
            {canEdit ? (
              <Button variant="outline" size="sm" onClick={() => navigateTo("irms", ["reports-edit", detail.id])}>
                <Pencil className="h-4 w-4 mr-1.5" /> Edit
              </Button>
            ) : null}
            <PdfButtons type="inspection-report" id={detail.id} label={`Inspection report ${detail.code}`} showPreview />
            {qrUrl ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    { }
                    <img
                      src={qrUrl}
                      alt={`QR code for report ${detail.code}`}
                      className="h-10 w-10 rounded border bg-white p-0.5"
                    />
                  </TooltipTrigger>
                  <TooltipContent>Scan to open report (authorized users only)</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
          </div>
        }
      >
        <Tabs value={tab} onValueChange={setTab}>
          <div className="-mx-1 mb-4 overflow-x-auto px-1">
            <TabsList className="h-auto w-max min-w-full justify-start">
              <TabsTrigger value="details" className="min-h-[40px] gap-1.5"><Eye className="h-4 w-4" /> DETAILS</TabsTrigger>
              <TabsTrigger value="work" className="min-h-[40px] gap-1.5"><ClipboardList className="h-4 w-4" /> WORK DETAILS</TabsTrigger>
              <TabsTrigger value="photos" className="min-h-[40px] gap-1.5"><Images className="h-4 w-4" /> PHOTOS</TabsTrigger>
              <TabsTrigger value="signatures" className="min-h-[40px] gap-1.5"><PenTool className="h-4 w-4" /> SIGNATURES</TabsTrigger>
              <TabsTrigger value="approval" className="min-h-[40px] gap-1.5"><BadgeCheck className="h-4 w-4" /> APPROVAL</TabsTrigger>
            </TabsList>
          </div>

          {/* ── DETAILS ── */}
          <TabsContent value="details" className="space-y-4">
            <Card className="shadow-sm">
              <CardContent className="grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-3 sm:p-5">
                <Kv label="Inspection date" value={fmtDate(detail.inspectionDate)} />
                <Kv label="Inspector" value={detail.inspector?.user?.name ?? "—"} />
                <Kv label="Overall condition" value={detail.overallCondition ? <StatusBadge status={detail.overallCondition} /> : "—"} />
                <Kv
                  label="Project"
                  value={detail.project ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      {detail.project.code} — {detail.project.name}
                    </span>
                  ) : "—"}
                />
                <Kv label="Customer" value={detail.project?.customer ? customerLabel(detail.project.customer) : "—"} />
                <Kv label="Equipment" value={detail.equipment ? `${detail.equipment.name} (${detail.equipment.assetTag})` : "—"} />
                <Kv label="Work order" value={detail.workOrder?.code ?? "—"} />
                <Kv label="Type" value={humanize(detail.type)} />
                <Kv label="Priority" value={<PriorityBadge priority={detail.priority} />} />
                <Kv label="Findings" value={String(detail.findings.length)} />
                <Kv label="Photos" value={String(detail.photos.length)} />
                <Kv label="Signatures" value={String(detail.signatures.length)} />
              </CardContent>
            </Card>
            <Card className="shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-base">Summary</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-wrap text-sm text-muted-foreground">{detail.summary || "—"}</p></CardContent>
            </Card>
          </TabsContent>

          {/* ── WORK DETAILS ── */}
          <TabsContent value="work" className="space-y-4">
            <Card className="shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap items-center justify-between gap-2">
                  Completion
                  <span className="text-sm font-semibold tabular-nums text-primary">{detail.completionPercent ?? 0}%</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={detail.completionPercent ?? 0} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, detail.completionPercent ?? 0))}%` }} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                  <Kv label="Labour hours" value={detail.labourHours != null ? String(detail.labourHours) : "—"} />
                  <Kv label="Job order no." value={detail.jobOrderNo || "—"} />
                  <Kv label="Location" value={[detail.building, detail.floor, detail.room].filter(Boolean).join(" · ") || "—"} />
                </div>
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-base">Work description</CardTitle></CardHeader>
              <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
                <Block label="Task description" value={detail.taskDescription} />
                <Block label="Scope" value={detail.scope} />
                <Block label="Corrective actions" value={detail.correctiveActions} />
                <Block label="Root cause" value={detail.rootCause} />
                <Block label="Recommendations" value={detail.recommendations} />
                <Block label="Safety notes" value={detail.safetyNotes} />
                <Block label="Materials" value={detail.materials} />
                <Block label="Notes" value={detail.notes} />
              </CardContent>
            </Card>

            <Card className="shadow-sm">
              <CardHeader className="pb-2"><CardTitle className="text-base">Findings ({detail.findings.length})</CardTitle></CardHeader>
              <CardContent>
                {detail.findings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No findings recorded.</p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="w-10 p-2.5 font-medium">#</th>
                          <th className="p-2.5 font-medium">Finding</th>
                          <th className="w-28 p-2.5 font-medium">Severity</th>
                          <th className="p-2.5 font-medium">Recommendation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.findings.map((f, i) => (
                          <tr key={f.id} className="border-t">
                            <td className="p-2.5 tabular-nums text-muted-foreground">{i + 1}</td>
                            <td className="p-2.5">{f.finding}</td>
                            <td className="p-2.5"><StatusBadge status={f.severity} /></td>
                            <td className="p-2.5 text-muted-foreground">{f.recommendation || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── PHOTOS ── */}
          <TabsContent value="photos">
            <IrmsPhotoManager reportId={detail.id} editable={canEditPhotos} canManage={canManage} />
          </TabsContent>

          {/* ── SIGNATURES ── */}
          <TabsContent value="signatures">
            <IrmsSignaturePanel reportId={detail.id} canManage={canManage} isOwner={canCreate} />
          </TabsContent>

          {/* ── APPROVAL ── */}
          <TabsContent value="approval">
            <ApprovalPanel detail={detail} canManage={canManage} canCreate={canCreate} onRefresh={() => void load()} userId={user?.id} />
          </TabsContent>
        </Tabs>
      </PageShell>
    </div>
  );
}

// ── APPROVAL tab ──

function ApprovalPanel({
  detail, canManage, canCreate, onRefresh, userId,
}: {
  detail: ReportDetail;
  canManage: boolean;
  canCreate: boolean;
  userId?: string;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [customerVisible, setCustomerVisible] = useState(!!detail.customerVisible);
  const [cvBusy, setCvBusy] = useState(false);
  const isEditable = EDITABLE_STATUSES.includes(detail.status);

  async function transition(action: string, opts?: { withComment?: boolean }) {
    if (opts?.withComment && !comment.trim()) {
      toast({ title: "A comment is required to reject", variant: "destructive" });
      return;
    }
    setBusy(action);
    try {
      await api.post(`/api/v1/irms/reports/${detail.id}/transition`, { action, comment: comment.trim() || undefined });
      toast({ title: `${humanize(action)} completed`, description: `${detail.code} updated by the server.` });
      setComment("");
      onRefresh();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function saveCustomerVisible(next: boolean) {
    setCvBusy(true);
    try {
      await api.patch(`/api/v1/irms/reports/${detail.id}`, { customerVisible: next });
      setCustomerVisible(next);
      toast({ title: next ? "Report shared with the customer" : "Customer visibility disabled" });
      onRefresh();
    } catch (e) {
      toast({ title: "Could not update visibility", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setCvBusy(false);
    }
  }

  async function restoreRevision(revisionId: string) {
    setBusy(revisionId);
    try {
      await api.post(`/api/v1/irms/reports/${detail.id}/revisions/${revisionId}/restore`);
      toast({ title: "Revision restored", description: "Report fields were rolled back to the snapshot." });
      onRefresh();
    } catch (e) {
      toast({ title: "Restore failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const status = detail.status;
  // Backend contract: submit/reopen = report owner (irms.create) OR irms.manage.
  const isOwner = canCreate && !!detail.inspector?.user?.id && detail.inspector.user.id === userId;
  const isOwnerLike = isOwner || canManage;
  const actions: { key: string; label: string; show: boolean }[] = [
    { key: "submit", label: "Submit for Approval", show: status === "DRAFT" && isOwnerLike },
    { key: "review", label: "Start Review", show: status === "SUBMITTED" && canManage },
    { key: "manager_approve", label: "Approve to Manager", show: status === "IN_REVIEW" && canManage },
    { key: "client_request", label: "Request Client Review", show: status === "MANAGER_APPROVAL" && canManage },
    { key: "approve", label: "Approve", show: (status === "MANAGER_APPROVAL" || status === "CLIENT_REVIEW") && canManage },
    { key: "reopen", label: "Reopen as Draft", show: status === "REJECTED" && isOwnerLike },
    { key: "archive", label: "Archive", show: status === "APPROVED" && canManage },
  ];
  const canReject = ["SUBMITTED", "IN_REVIEW", "MANAGER_APPROVAL", "CLIENT_REVIEW"].includes(status) && canManage;

  return (
    <div className="space-y-4">
      {/* Workflow actions */}
      <Card className="shadow-sm no-print">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex flex-wrap items-center gap-2">
            Workflow <StatusBadge status={status} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {status === "DRAFT" && "Draft — submit it for supervisor review when ready."}
            {status === "SUBMITTED" && "Submitted — waiting for a reviewer to start the review."}
            {status === "IN_REVIEW" && "In review — a reviewer can advance this to manager approval."}
            {status === "MANAGER_APPROVAL" && "Manager approval — approve directly or request a client review."}
            {status === "CLIENT_REVIEW" && "Client review — waiting for the customer to confirm (or staff can approve)."}
            {status === "APPROVED" && "Approved — an immutable record. It can be archived by a manager."}
            {status === "REJECTED" && "Rejected — the owner can reopen it as a draft to revise."}
            {status === "ARCHIVED" && "Archived — the final state of this report."}
          </p>

          {canManage && isEditable ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label htmlFor="ird-cv" className="text-sm">Shared to customer</Label>
                <p className="text-xs text-muted-foreground">Portal users of this customer can open the report while shared.</p>
              </div>
              <Switch id="ird-cv" checked={customerVisible} disabled={cvBusy} onCheckedChange={(next) => void saveCustomerVisible(next)} />
            </div>
          ) : null}

          {canReject ? (
            <div className="space-y-1.5">
              <Label htmlFor="ird-comment">Comment (required for reject)</Label>
              <Textarea id="ird-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Visible in the approval history." />
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {actions.filter((a) => a.show).map((a) => (
              <Button key={a.key} size="sm" disabled={busy !== null} onClick={() => void transition(a.key)} className="min-h-[44px] sm:min-h-0">
                {busy === a.key ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                {busy === a.key ? "Working…" : a.label}
              </Button>
            ))}
            {canReject ? (
              <Button
                size="sm" variant="outline" disabled={busy !== null}
                onClick={() => void transition("reject", { withComment: true })}
                className="min-h-[44px] text-red-700 hover:bg-red-50 sm:min-h-0"
              >
                {busy === "reject" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <X className="h-4 w-4 mr-1.5" />} Reject
              </Button>
            ) : null}
            {actions.every((a) => !a.show) && !canReject ? (
              <p className="text-sm text-muted-foreground">No workflow action is available for your role at this status.</p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Approval history timeline */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><History className="h-4 w-4 text-primary" aria-hidden /> Approval history</CardTitle>
        </CardHeader>
        <CardContent>
          {!detail.approvals || detail.approvals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approval activity yet.</p>
          ) : (
            <ol className="space-y-3">
              {detail.approvals.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className={cn("mt-1 h-2.5 w-2.5 shrink-0 rounded-full", (STATUS_TONE[a.toStatus] ?? "bg-stone-300").split(" ")[0])} aria-hidden />
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {humanize(a.step)} · {humanize(a.fromStatus)} → {humanize(a.toStatus)}
                    </p>
                    <p className="text-xs text-muted-foreground">{a.userName ?? "System"} · {fmtDateTime(a.createdAt)}</p>
                    {a.comment ? <p className="mt-0.5 rounded bg-muted/40 px-2 py-1 text-xs">“{a.comment}”</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Revisions */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Revisions {typeof detail.revision === "number" ? <Badge variant="outline" className="ml-1 bg-muted/40">Rev {detail.revision}</Badge> : null}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            A snapshot is taken when the report is submitted and approved. Restore is available to managers while the report is editable
            ({isEditable ? "available" : "locked — status is " + humanize(status)}); photos, signatures and approvals are never touched.
          </p>
          {!detail.revisions || detail.revisions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No revisions recorded yet.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {detail.revisions.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                  <Badge variant="outline" className="tabular-nums">v{r.version}</Badge>
                  <span className="min-w-0 flex-1">
                    {r.note || "Snapshot"}
                    <span className="block text-xs text-muted-foreground">{r.createdByName ?? "System"} · {fmtDateTime(r.createdAt)}</span>
                  </span>
                  {canManage && isEditable ? (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void restoreRevision(r.id)}>
                      {busy === r.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Undo2 className="h-4 w-4 mr-1" />} Restore
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Small pieces ──

function Kv({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}

function Block({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <p className="whitespace-pre-wrap text-muted-foreground">{value?.trim() ? value : "—"}</p>
    </div>
  );
}
