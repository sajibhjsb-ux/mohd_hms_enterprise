"use client";

// MOHD.HMS ENTERPRISE — Invoice Detail (dedicated full page, invoices/{id}).
// Replaces the former detail dialog: same DocumentPreview (incl. Paid /
// Balance-due rows), source attribution, payments table and workflow actions
// (GET /invoices/{id}, POST /{id}/transition, DELETE) — no popup.
// Record Payment lives on its own page (/invoices/{id}/payment).

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { WorkflowTimeline } from "@/components/hms/shared/workflow-timeline";
import { PdfButtons } from "@/components/hms/shared/pdf-buttons";
import { PERMISSIONS } from "@/lib/hms/constants";
import { customerLabel, fmtDate, money } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { INVOICE_DETAIL_EVENTS } from "@/lib/hms/realtime/matrix";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Ban, CircleDollarSign, Printer, Send, Trash2 } from "lucide-react";
import { DocumentPreview, loadCompanyIdentity, type CompanyIdentity, type InvoiceDetail, type InvoiceRow } from "./shared";

function errMessage(e: unknown): string {
  return e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.";
}

export function InvoiceDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.invoices_manage);
  const canRecord = hasPerm(user, PERMISSIONS.payments_record);
  const canReceipt = hasPerm(user, PERMISSIONS.payments_read);

  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
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
      const res = await api.get<InvoiceDetail>(`/api/v1/invoices/${id}`);
      setDetail(res.data);
    } catch (e) {
      setLoadError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Realtime (STEP 14): payments/status changes on this invoice refresh it live.
  useRealtimeEvent(INVOICE_DETAIL_EVENTS, (ev) => {
    if (!ev.aggregate_id || ev.aggregate_id === id) void load();
  });

  async function runTransition(action: "send" | "cancel") {
    setBusy(true);
    try {
      const res = await api.post<InvoiceRow>(`/api/v1/invoices/${id}/transition`, { action });
      toast({
        title: action === "send" ? `Invoice ${res.data.code} sent` : `Invoice ${res.data.code} cancelled`,
        description: `Status: ${res.data.status.replaceAll("_", " ").toLowerCase()}`,
      });
      // Stay on the detail page — refresh with the authoritative server record.
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function removeDraft() {
    setBusy(true);
    try {
      await api.del(`/api/v1/invoices/${id}`);
      toast({ title: "Draft invoice deleted" });
      navigateTo("invoices");
    } catch (e) {
      toast({ title: "Delete failed", description: errMessage(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const status = detail?.status;
  const canPay = !!detail && canRecord && !["DRAFT", "CANCELLED", "PAID"].includes(detail.status) && detail.balanceCents > 0;

  // ── Page chrome is shared by every state (loading / error / ready) ──
  const chrome = (children: ReactNode) => (
    <>
      <div className="print:hidden">
        <PageShell
          backLabel="Back to Invoices"
          backHref="/invoices"
          crumbs={[{ label: "Invoices", href: "/invoices" }, { label: detail?.code ?? "Invoice" }]}
          title={detail ? `Invoice ${detail.code}` : "Invoice"}
          description={detail?.customer ? `${customerLabel(detail.customer)} · Issued ${fmtDate(detail.invoiceDate)}` : "Document preview, payments and workflow actions"}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {detail ? <StatusBadge status={detail.status} /> : null}
              <Button variant="outline" onClick={() => window.print()} disabled={!detail}>
                <Printer className="h-4 w-4 mr-1.5" /> Print
              </Button>
              {detail ? <PdfButtons type="invoice" id={detail.id} label={`Invoice ${detail.code}`} showPreview /> : null}
            </div>
          }
        >
          {children}
        </PageShell>
      </div>
      {/* Print-only document — page-level version of the former print block */}
      {detail ? (
        <div className="hidden print:block">
          <DocumentPreview inv={detail} company={company} />
        </div>
      ) : null}
    </>
  );

  if (loading && !detail) {
    return chrome(<LoadingState label="Loading invoice…" rows={4} />);
  }

  if (loadError && !detail) {
    return chrome(<ErrorState message={loadError} onRetry={load} />);
  }

  if (!detail) {
    return chrome(<EmptyState title="Invoice not found" hint="It may have been removed or the link is incorrect." />);
  }

  return chrome(
    <div className="grid gap-4 lg:grid-cols-3 items-start">
      {/* Main column — document, source attribution, payments */}
      <div className="lg:col-span-2 space-y-4">
        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-6">
          <DocumentPreview inv={detail} company={company} />
        </div>

        {detail.quotation || detail.workOrders.length > 0 ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Source</p>
            <div className="flex flex-wrap gap-2">
              {detail.quotation ? (
                <a
                  href={`/quotations/${encodeURIComponent(detail.quotation.id)}`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                >
                  From quotation <span className="font-mono font-medium">{detail.quotation.code}</span>
                </a>
              ) : null}
              {detail.workOrders.map((w) => (
                <a
                  key={w.id}
                  href={`/work-orders/${encodeURIComponent(w.id)}`}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-accent transition-colors"
                >
                  From work order <span className="font-mono font-medium">{w.code}</span> — {w.title}
                </a>
              ))}
            </div>
          </div>
        ) : null}

        <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 text-sm">
          <p className="font-medium mb-2">Payments ({detail.payments.length})</p>
          {detail.payments.length === 0 ? (
            <p className="text-xs text-muted-foreground">No payments recorded yet.</p>
          ) : (
            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/50 text-left">
                    <th className="px-2 py-2 font-medium">Code</th>
                    <th className="px-2 py-2 font-medium">Date</th>
                    <th className="px-2 py-2 font-medium">Method</th>
                    <th className="px-2 py-2 font-medium hidden sm:table-cell">Reference</th>
                    <th className="px-2 py-2 font-medium text-right">Amount</th>
                    {canReceipt ? <th className="px-2 py-2 font-medium text-right">Receipt</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-2 py-2 font-medium">{p.code}</td>
                      <td className="px-2 py-2">{fmtDate(p.paidAt)}</td>
                      <td className="px-2 py-2">{p.method.replaceAll("_", " ")}</td>
                      <td className="px-2 py-2 hidden sm:table-cell">{p.reference || "—"}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{money(p.amountCents)}</td>
                      {canReceipt ? (
                        <td className="px-2 py-2 text-right">
                          <PdfButtons type="payment-receipt" id={p.id} label={`Receipt ${p.code}`} iconOnly />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Action column — contextual to status (same rules as the old dialog) */}
      <div className="space-y-3 no-print">
        {canManage && status === "DRAFT" ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Send to customer</p>
            <p className="text-xs text-muted-foreground">Marks the invoice as sent and starts collections.</p>
            <Button className="w-full" disabled={busy} onClick={() => runTransition("send")}>
              <Send className="h-4 w-4 mr-1.5" /> Send to customer
            </Button>
          </div>
        ) : null}

        {canPay ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm font-medium">Record a payment</p>
            <p className="text-xs text-muted-foreground">Outstanding balance: <strong className="text-foreground tabular-nums">{money(detail.balanceCents)}</strong></p>
            <Button className="w-full" disabled={busy} onClick={() => navigateTo("invoices", [detail.id, "payment"])}>
              <CircleDollarSign className="h-4 w-4 mr-1.5" /> Record Payment
            </Button>
          </div>
        ) : null}

        {canManage && ["DRAFT", "SENT", "OVERDUE"].includes(detail.status) ? (
          <div className="rounded-xl border bg-card shadow-sm p-4 space-y-2">
            <p className="text-sm text-muted-foreground">Cancelling stops collections on this invoice.</p>
            <Button variant="outline" className="w-full" disabled={busy} onClick={() => runTransition("cancel")}>
              <Ban className="h-4 w-4 mr-1.5" /> Cancel
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
      </div>

      <WorkflowTimeline resourceType="INVOICE" resourceId={detail.id} className="mt-6" />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft invoice {detail.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the invoice and its line items permanently. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep invoice</AlertDialogCancel>
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
