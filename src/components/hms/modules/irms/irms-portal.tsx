"use client";

// MOHD.HMS ENTERPRISE — IRMS customer portal (spec §41, contract §14).
//
// CUSTOMER role view for EVERY irms hash. Lists reports shared to the
// customer's own customer (status CLIENT_REVIEW / APPROVED / ARCHIVED) as
// cards — no internal fields anywhere. "View" expands an inline detail panel
// (GET /api/v1/irms/portal/{id}: summary, findings, photos grouped by
// category read-only, signatures, PDF download). When status=CLIENT_REVIEW a
// review panel offers Confirm & Approve / Reject with comment →
// POST /api/v1/irms/portal/{id}/confirm (AlertDialog guarded). Realtime
// refetch on the "irms-portal" event matrix. Photo/signature/PDF access is
// server-scoped to APPROVED|ARCHIVED for portal users — during CLIENT_REVIEW
// the UI says so honestly instead of rendering broken images.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { fmtDate, fmtDateTime } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";
import { humanize, IRMS_PHOTO_CATEGORIES } from "@/lib/hms/constants";
import { IrmsAnnotationOverlay } from "./irms-annotation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCheck, ChevronDown, ChevronUp, FileCheck2, FileText, Images, PenTool, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (portal payload — internal fields intentionally absent) ──

type PortalPhoto = {
  id: string;
  category: string;
  photoNo: string;
  caption: string | null;
  annotation: string | null;
  urls: { thumb: string; display: string; original: string };
};

type PortalListItem = {
  id: string;
  code: string;
  title: string;
  status: string;
  inspectionDate: string | null;
  projectName?: string | null;
  inspectorName?: string | null;
};

type PortalDetail = PortalListItem & {
  summary?: string | null;
  overallCondition?: string | null;
  recommendations?: string | null;
  completionPercent?: number | null;
  findings: { id: string; finding: string; severity: string; recommendation?: string | null }[];
  photos: PortalPhoto[];
  signatures: { id: string; role: string; name: string; signedAt: string; url: string }[];
};

export function IrmsPortalPage() {
  const { toast } = useToast();

  const [items, setItems] = useState<PortalListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PortalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [comment, setComment] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; code: string; decision: "confirm" | "reject" } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<PortalListItem[]>("/api/v1/irms/portal");
      setItems(res.data ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load shared inspection reports.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useRealtimeEvent(MODULE_EVENTS["irms-portal"], () => { void load(); });

  const openDetail = useCallback(async (id: string) => {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await api.get<PortalDetail>(`/api/v1/irms/portal/${id}`);
      setDetail(res.data);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Could not load this report.");
    } finally {
      setDetailLoading(false);
    }
  }, [openId]);

  async function submitDecision() {
    if (!confirmTarget) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/irms/portal/${confirmTarget.id}/confirm`, {
        decision: confirmTarget.decision,
        comment: comment.trim() || undefined,
      });
      toast({
        title: confirmTarget.decision === "confirm" ? "Report approved" : "Report rejected",
        description: `${confirmTarget.code} — the inspection team has been notified.`,
      });
      setComment("");
      setConfirmTarget(null);
      setOpenId(null);
      setDetail(null);
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const mediaVisible = (status: string) => status === "APPROVED" || status === "ARCHIVED";

  return (
    <div>
      <PageHeader
        title="Inspection Reports"
        subtitle="Reports shared with your organisation by MOHD.HMS ENTERPRISE"
      />

      {loading ? (
        <LoadingState label="Loading your reports…" rows={3} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !items || items.length === 0 ? (
        <EmptyState
          title="No shared reports yet"
          hint="When an inspection report is shared with your organisation it appears here, with photos, findings and signatures."
        />
      ) : (
        <ul className="space-y-3">
          {items.map((it) => {
            const expanded = openId === it.id;
            return (
              <li key={it.id}>
                <Card className="shadow-sm">
                  <CardHeader className="pb-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                          <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                          <span>{it.code}</span>
                          <StatusBadge status={it.status} />
                        </CardTitle>
                        <p className="mt-1 text-sm text-muted-foreground">{it.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {it.projectName ? `${it.projectName} · ` : ""}Inspected {fmtDate(it.inspectionDate)}
                          {it.inspectorName ? ` · Inspector ${it.inspectorName}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {mediaVisible(it.status) ? (
                          <PdfButtons type="inspection-report" id={it.id} label={`Inspection report ${it.code}`} />
                        ) : null}
                        <Button
                          variant="outline" size="sm"
                          onClick={() => void openDetail(it.id)}
                          aria-expanded={expanded}
                          aria-controls={`portal-detail-${it.id}`}
                        >
                          {expanded ? <ChevronUp className="h-4 w-4 mr-1" /> : <ChevronDown className="h-4 w-4 mr-1" />}
                          {expanded ? "Hide" : "View"}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>

                  {/* Inline detail panel (no popups) */}
                  {expanded ? (
                    <CardContent id={`portal-detail-${it.id}`} className="border-t pt-4">
                      {detailLoading ? (
                        <LoadingState label="Loading report…" rows={2} />
                      ) : detailError ? (
                        <ErrorState message={detailError} onRetry={() => { setOpenId(null); void openDetail(it.id); }} />
                      ) : detail ? (
                        <div className="space-y-4">
                          {detail.status === "CLIENT_REVIEW" ? (
                            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
                              <p className="flex items-center gap-2 text-sm font-medium text-amber-900">
                                <FileCheck2 className="h-4 w-4" aria-hidden /> Client review requested
                              </p>
                              <p className="mt-1 text-xs text-amber-800">
                                The inspection team asks you to review this report. Confirm to approve it, or reject it with a comment.
                                Photos and signatures become viewable once approved.
                              </p>
                              <Textarea
                                rows={2}
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                placeholder="Comment (optional for approval, required for rejection)"
                                aria-label="Review comment"
                                className="mt-2 bg-white"
                              />
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm" disabled={busy}
                                  onClick={() => setConfirmTarget({ id: it.id, code: it.code, decision: "confirm" })}
                                >
                                  <CheckCheck className="h-4 w-4 mr-1.5" /> Confirm & Approve
                                </Button>
                                <Button
                                  size="sm" variant="outline" disabled={busy}
                                  onClick={() => setConfirmTarget({ id: it.id, code: it.code, decision: "reject" })}
                                  className="text-red-700 hover:bg-red-50"
                                >
                                  <X className="h-4 w-4 mr-1.5" /> Reject
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</p>
                              <p className="mt-1 whitespace-pre-wrap text-sm">{detail.summary?.trim() || "—"}</p>
                            </div>
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recommendations</p>
                              <p className="mt-1 whitespace-pre-wrap text-sm">{detail.recommendations?.trim() || "—"}</p>
                            </div>
                          </div>

                          {/* Findings */}
                          <div>
                            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Findings ({detail.findings.length})</p>
                            {detail.findings.length === 0 ? (
                              <p className="text-sm text-muted-foreground">No findings recorded.</p>
                            ) : (
                              <ul className="space-y-2">
                                {detail.findings.map((f) => (
                                  <li key={f.id} className="rounded-lg border p-2.5 text-sm">
                                    <div className="flex items-start justify-between gap-2">
                                      <p>{f.finding}</p>
                                      <Badge variant="outline" className="shrink-0 bg-muted/40">{humanize(f.severity)}</Badge>
                                    </div>
                                    {f.recommendation ? <p className="mt-1 text-xs text-muted-foreground">Recommendation: {f.recommendation}</p> : null}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>

                          {/* Photos grouped by category (read-only) */}
                          {mediaVisible(detail.status) ? (
                            <div>
                              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                <Images className="h-3.5 w-3.5" aria-hidden /> Photos
                              </p>
                              {detail.photos.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No photos were shared on this report.</p>
                              ) : (
                                <div className="space-y-4">
                                  {IRMS_PHOTO_CATEGORIES.filter((c) => detail.photos.some((p) => p.category === c)).map((c) => (
                                    <div key={c}>
                                      <p className="mb-1.5 text-xs font-semibold">{humanize(c)}</p>
                                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                        {detail.photos.filter((p) => p.category === c).map((p) => (
                                          <figure key={p.id} className="relative overflow-hidden rounded-lg border bg-card">
                                            { }
                                            <img src={p.urls.display} alt={p.caption || `Photo ${p.photoNo}`} className="aspect-square w-full object-cover" loading="lazy" />
                                            <IrmsAnnotationOverlay annotation={p.annotation} />
                                            <figcaption className="flex items-center justify-between gap-1 px-1.5 py-1 text-[11px] text-muted-foreground">
                                              <span className="font-semibold text-foreground">{p.photoNo}</span>
                                              <span className="truncate">{p.caption ?? ""}</span>
                                            </figcaption>
                                          </figure>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">Photos are viewable once the report is approved.</p>
                          )}

                          {/* Signatures */}
                          {mediaVisible(detail.status) ? (
                            <div>
                              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                <PenTool className="h-3.5 w-3.5" aria-hidden /> Signatures
                              </p>
                              {detail.signatures.length === 0 ? (
                                <p className="text-sm text-muted-foreground">No signatures recorded.</p>
                              ) : (
                                <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                                  {detail.signatures.map((s) => (
                                    <li key={s.id} className="rounded-lg border p-2.5">
                                      { }
                                      <img src={s.url} alt={`Signature of ${s.name}`} className="h-14 w-full rounded border bg-white object-contain" loading="lazy" />
                                      <p className="mt-1.5 text-sm font-medium">{s.name}</p>
                                      <p className="text-xs text-muted-foreground">{humanize(s.role)} · {fmtDateTime(s.signedAt)}</p>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : null}

                          <Separator />
                          <p className="text-xs text-muted-foreground">
                            Shared by MOHD.HMS ENTERPRISE · status {humanize(detail.status)} · inspection date {fmtDate(detail.inspectionDate)}
                          </p>
                        </div>
                      ) : null}
                    </CardContent>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {/* Confirm / reject guard */}
      <AlertDialog open={confirmTarget !== null} onOpenChange={(open) => { if (!open) setConfirmTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmTarget?.decision === "confirm" ? `Approve ${confirmTarget?.code}?` : `Reject ${confirmTarget?.code}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmTarget?.decision === "confirm"
                ? "Confirming approves this inspection report for your organisation. The inspection team is notified."
                : "Rejecting sends the report back to the inspection team with your comment."}
            </AlertDialogDescription>
            {/* Terms reference (spec §24) — canonical page, new tab so the
                dialog and the customer's place in the review are not lost. */}
            <p className="text-xs text-muted-foreground">
              Our{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary underline underline-offset-4 decoration-primary/40 hover:decoration-primary"
              >
                Terms &amp; Conditions
              </a>{" "}
              apply to portal confirmations. Confirming records that you have reviewed the report — it does not affect your rights under those Terms.
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(confirmTarget?.decision === "reject" && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
              onClick={() => void submitDecision()}
            >
              {confirmTarget?.decision === "confirm" ? "Confirm & Approve" : "Reject report"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
