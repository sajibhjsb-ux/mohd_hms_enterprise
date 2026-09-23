"use client";

// MOHD.HMS ENTERPRISE — Checklist instance review / execution detail page.
// Drafts: edit items + approve / reject (reason) / regenerate (AI).
// Active/Completed: run the checklist inline and capture an AI summary.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CheckCircle2, Loader2, Plus, RefreshCw, Sparkles, ThumbsDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { navigateTo } from "@/lib/hms/router";

type ChecklistItem = {
  label: string;
  description?: string;
  required: boolean;
  responseType: string;
  priority?: string;
  safetyCritical?: boolean;
  expectedResult?: string;
  unit?: string;
  requiresPhoto?: boolean;
  failRequiresFinding?: boolean;
  origin?: string;
  response?: string | null;
  done?: boolean;
};

type DetailData = {
  id: string;
  code: string;
  title: string;
  sourceType: string;
  sourceId: string;
  status: string;
  version: number;
  origin: string;
  itemsJson?: string;
  rejectionReason?: string | null;
  aiSummary?: string | null;
  createdAt: string;
  completedAt: string | null;
  items: ChecklistItem[];
  workOrder?: {
    id: string; code: string; title: string; status: string;
    checklist?: { id: string; label: string; responseType: string; response: string | null; done: boolean; required: boolean }[];
  } | null;
  template?: { id: string; name: string; version: number; category: string } | null;
  versions?: { id: string; version: number; origin: string; note: string | null; createdAt: string }[];
  aiGeneration?: { id: string; promptVersion: number; provider: string; model: string; status: string; itemCount: number; createdAt: string } | null;
};

function parseItems(raw: string | undefined): ChecklistItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((it): it is ChecklistItem => !!it && typeof it === "object" && typeof (it as ChecklistItem).label === "string");
  } catch {
    return [];
  }
}

const EXECUTABLE = new Set(["ACTIVE", "APPROVED"]);
const EDITABLE = new Set(["DRAFT", "PENDING_APPROVAL", "REJECTED"]);

export function ChecklistDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canEdit = hasPerm(user, PERMISSIONS.checklist_edit);
  const canApprove = hasPerm(user, PERMISSIONS.checklist_approve);
  const canGenerate = hasPerm(user, PERMISSIONS.checklist_generate);

  // Cache the raw instance so item edits (add item) reload without refetch.
  const [detail, setDetail] = useState<DetailData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [newItem, setNewItem] = useState("");
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<DetailData>(`/api/v1/checklists/${id}`);
      const items = Array.isArray(res.data.items) ? res.data.items : parseItems(res.data.itemsJson);
      for (const it of items) it.done ??= false;
      setDetail({ ...res.data, items });
      setAiSummary(res.data.aiSummary ?? null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this checklist.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: okMsg });
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
      void load();
    }
  }, [load, toast]);

  async function addItem() {
    if (!detail || !newItem.trim() || !EDITABLE.has(detail.status)) return;
    await runAction(
      () => api.post(`/api/v1/checklists/${detail.id}/items`, { label: newItem.trim(), required: true, responseType: "CHECKBOX" }),
      "Item added to draft."
    );
    setNewItem("");
  }

  async function executeItem(item: ChecklistItem, done: boolean) {
    const added = detail?.workOrder?.checklist ?? [];
    const target = added.find((c) => c.label === item.label);
    if (!target) {
      toast({ title: "Cannot record — item not materialized on the work order.", variant: "destructive" });
      return;
    }
    await runAction(
      () => api.patch(`/api/v1/work-orders/${detail!.workOrder!.id}/checklist`, { itemId: target.id, done }),
      done ? "Item marked done." : "Item re-opened."
    );
  }

  async function requestSummary() {
    if (!detail) return;
    setSummaryLoading(true);
    try {
      const res = await api.post<{ summary: string; aiAssisted: boolean }>(`/api/v1/checklists/${detail.id}/ai-summary`);
      setAiSummary(res.data.summary);
    } catch (e) {
      toast({ title: "Could not summarize", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSummaryLoading(false);
    }
  }

  if (loading && !detail) {
    return (
      <PageShell backLabel="Back to Checklists" backHref="/checklists" title="Checklist">
        <LoadingState label="Loading checklist…" rows={4} />
      </PageShell>
    );
  }
  if (loadError && !detail) {
    return (
      <PageShell backLabel="Back to Checklists" backHref="/checklists" title="Checklist">
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }
  if (!detail) {
    return (
      <PageShell backLabel="Back to Checklists" backHref="/checklists" title="Checklist">
        <EmptyState title="Checklist not found" hint="It may have been removed or the link is incorrect." />
      </PageShell>
    );
  }

  const editable = EDITABLE.has(detail.status);
  const executable = EXECUTABLE.has(detail.status);
  const completed = detail.status === "COMPLETED";
  const itemCount = detail.items.length;
  const doneCount = detail.items.filter((i) => i.done).length;

  return (
    <PageShell
      backLabel="Back to Checklists"
      backHref="/checklists"
      crumbs={[{ label: "Checklists", href: "/checklists" }, { label: detail.code }]}
      title={detail.title}
      description={`${humanize(detail.sourceType)} source · v${detail.version} · Created ${new Date(detail.createdAt).toLocaleString()}${detail.completedAt ? ` · Completed ${new Date(detail.completedAt).toLocaleString()}` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={detail.status} />
          <Badge variant="outline" className="font-mono text-[11px]">{detail.origin}</Badge>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {/* Items */}
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between gap-2">
                <span>Tasks ({doneCount}/{itemCount} done)</span>
                {editable ? <Badge variant="outline" className="text-[10px]">Draft editable</Badge> : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {detail.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tasks yet — generate or add one.</p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.items.map((item, idx) => (
                    <li key={idx} className="rounded-lg border p-2.5">
                      <div className="flex items-center gap-2.5">
                        {executable && item.responseType === "CHECKBOX" ? (
                          <Checkbox
                            checked={item.done === true}
                            disabled={busy || !detail.workOrder}
                            onCheckedChange={(chk) => void executeItem(item, chk === true)}
                            aria-label={`Toggle ${item.label}`}
                          />
                        ) : executable && item.done === true ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" aria-hidden />
                        ) : null}
                        <span className={cn("text-sm flex-1", item.required && !editable && "font-medium")}>
                          {item.label}
                          {item.required ? <span className="text-destructive ml-1" title="Required">*</span> : null}
                        </span>
                        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground whitespace-nowrap">
                          {item.priority ? <Badge variant="outline" className="text-[9px]">{humanize(item.priority)}</Badge> : null}
                          {item.safetyCritical ? <Badge className="text-[9px] bg-destructive/10 text-destructive border-destructive/30">SAFETY</Badge> : null}
                          {item.responseType !== "CHECKBOX" ? <span>{humanize(item.responseType)}</span> : null}
                          {item.origin ? <span>{item.origin}</span> : null}
                        </span>
                      </div>
                      {item.description || item.expectedResult ? (
                        <p className="text-xs text-muted-foreground mt-1 pl-7">
                          {item.description ?? ""}
                          {item.expectedResult ? (item.description ? " — " : "") + `Expect ${item.expectedResult}${item.unit ? ` ${item.unit}` : ""}` : ""}
                        </p>
                      ) : null}
                      {item.requiresPhoto ? <p className="text-[10px] text-muted-foreground mt-1 pl-7">Requires photo evidence</p> : null}
                    </li>
                  ))}
                </ul>
              )}
              {editable && canEdit ? (
                <div className="flex gap-2 pt-1">
                  <Input
                    value={newItem}
                    onChange={(e) => setNewItem(e.target.value)}
                    placeholder="Add a task to the draft…"
                    onKeyDown={(e) => { if (e.key === "Enter") addItem(); }}
                    maxLength={300}
                    aria-label="New checklist task"
                  />
                  <Button variant="outline" onClick={addItem} disabled={busy || !newItem.trim()}>
                    <Plus className="h-4 w-4 mr-1" /> Add
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Work order execution context */}
          {detail.workOrder ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Linked work order</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{detail.workOrder.code}</span>
                  <StatusBadge status={detail.workOrder.status} />
                </div>
                <p className="text-muted-foreground">{detail.workOrder.title}</p>
                {executable ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigateTo("work-orders", [detail.workOrder!.id])}
                  >
                    Open work order
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {/* AI summary (generated from real recorded results — labelled as AI-assisted) */}
          {executable || completed ? (
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  AI summary
                  {aiSummary ? <Badge variant="outline" className="text-[10px]">AI-assisted suggestion</Badge> : null}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {aiSummary ? (
                  <p className="text-sm whitespace-pre-wrap rounded-lg bg-muted/40 p-3">{aiSummary}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Summarize the recorded results (work order must be at least in progress).</p>
                )}
                <div className="flex justify-end pt-3">
                  <Button variant="outline" size="sm" onClick={requestSummary} disabled={summaryLoading || busy}>
                    {summaryLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
                    Generate summary
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* Actions column */}
        {editable || detail.status === "ACTIVE" ? (
          <div className="space-y-3">
            <div className="rounded-xl border bg-card shadow-sm p-4 space-y-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Review actions</p>
              {editable && canApprove ? (
                <Button className="w-full" disabled={busy || itemCount === 0} onClick={() => runAction(() => api.post(`/api/v1/checklists/${detail.id}/approve`), "Checklist approved and activated.")}>
                  <CheckCircle2 className="h-4 w-4 mr-1.5" /> Approve
                </Button>
              ) : null}
              {editable && canApprove ? (
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setShowReject(true)}>
                  <ThumbsDown className="h-4 w-4 mr-1.5" /> Reject
                </Button>
              ) : null}
              {editable && canGenerate ? (
                <Button variant="outline" className="w-full" disabled={busy} onClick={() => setShowRegenerate(true)}>
                  <RefreshCw className="h-4 w-4 mr-1.5" /> Regenerate (AI)
                </Button>
              ) : null}
              {detail.rejectionReason ? (
                <p className="text-xs rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
                  <span className="font-semibold">Rejected:</span> {detail.rejectionReason}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/* Reject dialog */}
      <AlertDialog open={showReject} onOpenChange={setShowReject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject checklist {detail.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              <Label htmlFor="cl-reject" className="text-xs text-muted-foreground">Reason (required)</Label>
              <Textarea id="cl-reject" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="Why was the draft rejected?" className="mt-2" />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy || rejectReason.trim().length < 3}
              onClick={() => { setShowReject(false); void runAction(() => api.post(`/api/v1/checklists/${detail.id}/reject`, { reason: rejectReason.trim() }), "Checklist rejected."); setRejectReason(""); }}
            >
              Reject checklist
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Regenerate confirm */}
      <AlertDialog open={showRegenerate} onOpenChange={setShowRegenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate {detail.code} with AI?</AlertDialogTitle>
            <AlertDialogDescription>
              The current draft is versioned first, then replaced by a fresh AI generation. This is not silent destructive work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep draft</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setShowRegenerate(false); void runAction(() => api.post(`/api/v1/checklists/${detail.id}/regenerate`), "Draft regenerated."); }}>
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}