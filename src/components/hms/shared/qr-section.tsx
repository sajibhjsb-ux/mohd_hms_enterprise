"use client";

// MOHD.HMS ENTERPRISE — Central QR UI section (ch.35 spec §14/§15/§29/§39/§40).
// ONE reusable component consumed by every module's detail page (§39: no QR UI
// duplicated per module, no QR menu §4/§67). Shows the canonical verification
// identity with contextual actions:
//   • QR status badge — ACTIVE / REVOKED / NOT GENERATED, kept clearly
//     DISTINCT from the document's own business status (§40)
//   • View / open the public verification page, copy the link
//   • Download print-grade PNG (ECC-H source, §43)
//   • Equipment: print-friendly branded physical label (§15)
//   • Regenerate / Revoke — authorized managers only, confirmed + reasoned
//     (§29/§30/§31); server-side RBAC is re-enforced by the API (§52).

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { fmtDate, fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Copy, Download, ExternalLink, Printer, QrCode, RefreshCw, ShieldBan, Loader2 } from "lucide-react";

type QrStatus = {
  id: string;
  status: string;
  verificationUrl: string;
  issuedAt: string;
  expiresAt: string | null;
  verifyCount: number;
  lastVerifiedAt: string | null;
  dataUrl: string;
};

type QrState = {
  qr: QrStatus | null;
  lastRevoked: { id: string; revokedAt: string; revokedReason: string } | null;
  canManage: boolean;
};

export function QrSection({
  entityType,
  entityId,
  label = "QR Verification",
  printLabel,
}: {
  entityType: string;
  entityId: string;
  label?: string;
  /** when provided, offers the print-friendly physical label (§15) */
  printLabel?: { title: string; subtitle?: string; reference: string };
}) {
  const { toast } = useToast();
  const [state, setState] = useState<QrState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "generate" | "revoke" | "regenerate">("");
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<QrState>(`/api/v1/qr/${entityType}/${entityId}`);
      setState(res.data);
    } catch (err) {
      setLoadError(err instanceof ClientApiError ? err.message : "QR status could not be loaded.");
    }
  }, [entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setBusy("generate");
    try {
      const res = await api.post<QrState>(`/api/v1/qr/${entityType}/${entityId}/ensure`, {});
      setState(res.data);
      toast({ title: "QR identity generated", description: "The record is now publicly verifiable online." });
    } catch (err) {
      toast({ title: "QR generation failed", description: err instanceof ClientApiError ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy("");
    }
  };

  const regenerate = async () => {
    setBusy("regenerate");
    try {
      const res = await api.post<QrState>(`/api/v1/qr/${entityType}/${entityId}/regenerate`, {});
      setState(res.data);
      toast({ title: "QR identity regenerated", description: "Printed labels with the old QR now verify as revoked." });
    } catch (err) {
      toast({ title: "QR regeneration failed", description: err instanceof ClientApiError ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy("");
    }
  };

  const revoke = async () => {
    if (revokeReason.trim().length < 3) return;
    setBusy("revoke");
    try {
      await api.post(`/api/v1/qr/${entityType}/${entityId}/revoke`, { reason: revokeReason.trim() });
      setRevokeOpen(false);
      setRevokeReason("");
      await load();
      toast({ title: "QR identity revoked", description: "Scanning the code now returns a clear revoked state." });
    } catch (err) {
      toast({ title: "QR revocation failed", description: err instanceof ClientApiError ? err.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusy("");
    }
  };

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Verification link copied" });
    } catch {
      toast({ title: "Copy failed", description: "The link could not be copied to the clipboard.", variant: "destructive" });
    }
  };

  /** §15 — print-friendly branded label in a self-contained print window. */
  const printLabelWindow = (qr: QrStatus) => {
    if (!printLabel) return;
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) {
      toast({ title: "Print blocked", description: "Allow pop-ups for this site to print the label.", variant: "destructive" });
      return;
    }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>QR Label — ${printLabel.reference}</title>
<style>
  @page { margin: 10mm; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; justify-content: center; padding: 16px; background: #fff; }
  .label { border: 2px solid #0c2414; border-radius: 12px; padding: 18px 22px; text-align: center; width: 300px; }
  .brand { color: #0c2414; letter-spacing: .28em; font-size: 11px; font-weight: 700; }
  .brand2 { color: #14532d; font-size: 15px; font-weight: 800; margin-top: 2px; }
  .qr { margin: 12px auto 10px; width: 210px; height: 210px; }
  .qr img { width: 100%; height: 100%; display: block; image-rendering: pixelated; }
  .id { font-size: 16px; font-weight: 800; color: #111; }
  .sub { font-size: 12px; color: #333; margin-top: 3px; }
  .hint { margin-top: 10px; font-size: 11px; color: #14532d; font-weight: 600; letter-spacing: .06em; }
  .foot { margin-top: 8px; font-size: 9px; color: #888; }
</style></head><body>
<div class="label">
  <div class="brand">MOHD.HMS</div>
  <div class="brand2">ENTERPRISE</div>
  <div class="qr"><img src="${qr.verificationUrl.replace(/verify\/.*/, "")}api/v1/qr/${entityType}/${entityId}/image?size=512" alt="Verification QR code" onload="window.focus();setTimeout(function(){window.print()},250)"></div>
  <div class="id">${printLabel.reference}</div>
  ${printLabel.subtitle ? `<div class="sub">${printLabel.subtitle}</div>` : ""}
  <div class="hint">SCAN TO VERIFY</div>
  <div class="foot">Verify online anytime — MOHD.HMS ENTERPRISE</div>
</div>
</body></html>`);
    w.document.close();
  };

  return (
    <section aria-label={label} className="rounded-xl border bg-card">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <QrCode className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <h3 className="text-sm font-semibold truncate">{label}</h3>
        </div>
        <QrBadge status={state?.qr ? "ACTIVE" : state?.lastRevoked ? "REVOKED" : state ? "NOT_GENERATED" : null} />
      </header>

      <div className="p-4">
        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
        {!state && !loadError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading QR identity…
          </div>
        )}

        {state?.qr && (
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="shrink-0 rounded-lg border bg-white p-2 self-start">
              <img src={state.qr.dataUrl} alt={`Verification QR code for ${printLabel?.reference ?? label}`} className="h-28 w-28" />
            </div>
            <div className="min-w-0 flex-1 space-y-2 text-sm">
              <p className="text-muted-foreground">
                Scanning this code opens the public online verification page and resolves the
                live record — anyone can verify, no sign-in required.
              </p>
              <p className="text-xs text-muted-foreground">
                Issued {fmtDate(state.qr.issuedAt)}
                {state.qr.verifyCount > 0 && <> · verified {state.qr.verifyCount}× (last {fmtDateTime(state.qr.lastVerifiedAt)})</>}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="outline" asChild>
                  <a href={state.qr.verificationUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> View verification
                  </a>
                </Button>
                <Button size="sm" variant="outline" onClick={() => void copyLink(state.qr!.verificationUrl)}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> Copy link
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={`/api/v1/qr/${entityType}/${entityId}/image?size=1024`} download>
                    <Download className="h-3.5 w-3.5" aria-hidden /> Download PNG
                  </a>
                </Button>
                {printLabel && (
                  <Button size="sm" variant="outline" onClick={() => printLabelWindow(state.qr!)}>
                    <Printer className="h-3.5 w-3.5" aria-hidden /> Print label
                  </Button>
                )}
              </div>
              {state.canManage && (
                <div className="flex flex-wrap gap-2 pt-1 border-t">
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy !== ""} onClick={() => setRevokeOpen(true)}>
                    <ShieldBan className="h-3.5 w-3.5" aria-hidden /> Revoke
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => void regenerate()}>
                    {busy === "regenerate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Regenerate
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {state && !state.qr && (
          <div className="space-y-3">
            {state.lastRevoked && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                The previous QR identity was revoked {fmtDateTime(state.lastRevoked.revokedAt)}
                {state.lastRevoked.revokedReason ? ` — ${state.lastRevoked.revokedReason}` : ""}. Printed copies
                carrying the old code verify as <strong>revoked</strong>.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              No QR identity has been generated for this record yet.
            </p>
            {state.canManage && (
              <Button size="sm" onClick={() => void generate()} disabled={busy !== ""}>
                {busy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <QrCode className="h-4 w-4" aria-hidden />} Generate QR identity
              </Button>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this QR identity?</AlertDialogTitle>
            <AlertDialogDescription>
              Every scan of the printed code will immediately return a clear “revoked” result. This
              action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="qr-revoke-reason">Reason (required)</Label>
            <Input
              id="qr-revoke-reason"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              placeholder="e.g. Document cancelled"
              maxLength={300}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revokeReason.trim().length < 3 || busy !== ""}
              onClick={(e) => {
                e.preventDefault();
                void revoke();
              }}
            >
              {busy === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null} Revoke QR
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** §40 — QR lifecycle badge, deliberately separate from any document status. */
export function QrBadge({ status }: { status: "ACTIVE" | "REVOKED" | "NOT_GENERATED" | null }) {
  if (status === null) return <span className="text-xs text-muted-foreground">QR: …</span>;
  const cls =
    status === "ACTIVE"
      ? "bg-emerald-100 text-emerald-800 border-emerald-300"
      : status === "REVOKED"
        ? "bg-red-100 text-red-800 border-red-300"
        : "bg-stone-100 text-stone-600 border-stone-300";
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${cls}`}>
      QR: {status === "NOT_GENERATED" ? "NOT GENERATED" : status}
    </span>
  );
}
