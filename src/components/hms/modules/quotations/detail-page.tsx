"use client";

// MOHD.HMS ENTERPRISE — Quotation Detail (dedicated full page, quotations/{id}).
// Replaces the former detail dialog: same DocumentPreview, same workflow APIs
// (GET /quotations/{id}, POST /{id}/transition, POST /{id}/convert, DELETE) —
// no popup. Delete uses an AlertDialog; print stays a page-level print-only block.

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, money } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Check, Clock, Printer, Repeat, Send, Trash2, X } from "lucide-react";
import { DocumentPreview, loadCompanyIdentity, type CompanyIdentity, type QuotationDetail, type QuotationRow } from "./shared";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

const ACTION_LABEL: Record<string, string> = { send: "sent", approve: "approved", reject: "rejected", expire: "expired" };

export function QuotationDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.quotations_manage);

  const [detail, setDetail] = useState<QuotationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [company, setCompany] = useState<CompanyIdentity>({ name: "MOHD.HMS Enterprise", address: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { loadCompanyIdentity().then(setCompany); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<QuotationDetail>(`/api/v1/quotations/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function runTransition(action: "send" | "approve" | "reject" | "expire") {
    setBusy(true);
    try {
      const res = await api.post<QuotationRow>(`/api/v1/quotations/${id}/transition`, { action });
      toast({ title: `Quotation ${res.data.code} ${ACTION_LABEL[action] ?? action}`, description: `Status: ${res.data.status.replaceAll("_", " ").toLowerCase()}` });
      // Stay on the detail page — refresh with the authoritative server record.
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function convert() {
    setBusy(true);
    try {
      // The convert endpoint returns the created invoice object (id + code).
      const res = await api.post<{ id: string; code: string }>(`/api/v1/quotations/${id}/convert`);
      toast({ title: "Invoice created", description: `Quotation converted to invoice ${res.data.code} (draft).` });
      navigateTo("invoices", [res.data.id]);
    } catch (e) {
      toast({ title: "Conversion failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft() {
    setBusy(true);
    try {
      await api.del(`/api/v1/quotations/${id}`);
      toast({ title: "Draft quotation deleted" });
      navigateTo("quotations");
    } catch (e) {
      toast({ title: "Delete failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const status = detail?.status;

  // ── Page chrome is shared by every state (loading / error / ready) ──
  const chrome = (children: ReactNode) => (
    <>
      <div className="print:hidden">
        <PageShell
          backLabel="Back to Quotations"
          backHref="/quotations"
          crumbs={[{ label: "Quotations", href: "/quotations" }, { label: detail?.code ?? "Quotation" }]}
          title={detail ? `Quotation ${detail.code}` : "Quotation"}
          description={detail?.customer ? `${detail.customer.companyName} · Issued ${fmtDate(detail.quotationDate)}` : "Document preview and workflow actions"}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {detail ? <StatusBadge status={detail.status} /> : null}
              <Button variant="outline" onClick={() => window.print()} disabled={!detail}>
                <Printer className="h-4 w-4 mr-1.5" /> Print
              </Button>
              {detail ? <PdfButtons type="quotation" id={detail.id} label={`Quotation ${detail.code}`} showPreview /> : null}
            </div>
          }
        >
          {children}
        </PageShell>
      </div>
      {/* Print-only document — page-level version of the former print block */}
      {detail ? (
        <div className="hidden print:block">
          <DocumentPreview q={detail} company={company} />
        </div>
      ) : null}
    </>
  );

  if (loading && !detail) {
    return chrome(<LoadingState label="Loading quotation…" rows={4} />);
  }

  if (loadError && !detail) {
    return chrome(<ErrorState message={loadError} onRetry={load} />);
  }

  if (!detail) {
    return chrome(<EmptyState title="Quotation not found" hint="It may have been removed or the link is incorrect." />);
  }

  return chrome(
    <div className="grid gap-4 lg:grid-cols-3 items-start">
      {/* Main column — the document itself */}
      <div className="lg:col-span-2">
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6">
          <DocumentPreview q={detail} company={company} />
        </div>
      </div>

      {/* Action column — contextual to status (same rules as the old dialog) */}
      <div className="space-y-3 no-print">
        {canManage && status === "DRAFT" ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Send to customer</p>
            <p className="text-xs text-muted-foreground">Notifies the customer portal and the finance team.</p>
            <Button className="w-full" disabled={busy} onClick={() => runTransition("send")}>
              <Send className="h-4 w-4 mr-1.5" /> Send to customer
            </Button>
          </div>
        ) : null}

        {canManage && status === "SENT" ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Customer review</p>
            <p className="text-xs text-muted-foreground">Approve to allow conversion, or reject / expire this quotation.</p>
            <Button className="w-full" disabled={busy} onClick={() => runTransition("approve")}>
              <Check className="h-4 w-4 mr-1.5" /> Approve
            </Button>
            <Button variant="outline" className="w-full" disabled={busy} onClick={() => runTransition("reject")}>
              <X className="h-4 w-4 mr-1.5" /> Reject
            </Button>
            <Button variant="outline" className="w-full" disabled={busy} onClick={() => runTransition("expire")}>
              <Clock className="h-4 w-4 mr-1.5" /> Mark expired
            </Button>
          </div>
        ) : null}

        {canManage && status === "APPROVED" ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Convert</p>
            <p className="text-xs text-muted-foreground">Creates a draft invoice with the same lines and totals ({money(detail.totalCents)}).</p>
            <Button className="w-full" disabled={busy} onClick={convert}>
              <Repeat className="h-4 w-4 mr-1.5" /> Convert to Invoice
            </Button>
          </div>
        ) : null}

        {canManage && status === "DRAFT" ? (
          <div className="rounded-xl border border-destructive/30 bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm text-muted-foreground">Deleting removes this draft permanently.</p>
            <Button variant="destructive" className="w-full" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-1.5" /> Delete draft
            </Button>
          </div>
        ) : null}

        {!canManage && status === "CONVERTED" && detail.convertedInvoiceId ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Converted</p>
            <p className="text-xs text-muted-foreground">This quotation became an invoice.</p>
            <Button variant="outline" className="w-full" onClick={() => navigateTo("invoices", [detail.convertedInvoiceId as string])}>
              Open invoice
            </Button>
          </div>
        ) : null}
      </div>

      <WorkflowTimeline resourceType="QUOTATION" resourceId={detail.id} className="mt-6" />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft quotation {detail.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the quotation and its line items permanently. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep quotation</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={removeDraft}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
