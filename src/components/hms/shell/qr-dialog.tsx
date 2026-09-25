"use client";

// MOHD.HMS ENTERPRISE — QR scanner entry dialog.
// Camera hardware scanning is a device capability; the app's existing QR
// machinery accepts every format the system prints:
//   • PUBLIC verification URLs (https://…/verify/{token}) — what EVERY QR code
//     now encodes (QR spec §2/§12). Resolved through the public verification
//     API; a verified equipment result carries the internal deep link, which
//     opens the record through the SAME deep-link path as before.
//   • Legacy deep-link URLs /?resource=equipment:{qrToken} (old printed
//     labels — still resolvable, QR spec §36 compatibility).
//   • Bare tokens (equipment:{token} or the raw qrToken).
// No duplicate QR logic.

import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { QrCode, ScanLine, Loader2 } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Goes through the shell's dirty-state guard before switching modules. */
  onNavigate: (module: string, token: string) => void;
};

/** /verify/{token} — the canonical public QR format. */
function parseVerifyUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim(), window.location.origin);
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length === 2 && segs[0] === "verify" && /^[A-Za-z0-9_-]{8,80}$/.test(segs[1])) {
      return segs[1];
    }
  } catch { /* not a URL */ }
  return null;
}

function parseResource(raw: string): { type: string; token: string } | null {
  const value = raw.trim();
  if (!value) return null;
  // Full deep-link URL: /?resource=equipment:{token}
  try {
    const url = new URL(value, window.location.origin);
    const res = url.searchParams.get("resource");
    if (res) {
      const [type, ...rest] = res.split(":");
      if (type && rest.length) return { type, token: rest.join(":") };
    }
  } catch { /* not a URL — fall through */ }
  // Bare token (equipment QR codes carry their token directly)
  if (value.includes(":")) {
    const [type, ...rest] = value.split(":");
    if (type && rest.length) return { type, token: rest.join(":") };
  }
  return { type: "equipment", token: value };
}

export function QrScanDialog({ open, onOpenChange, onNavigate }: Props) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const raw = code.trim();
    if (!raw) {
      setError("Enter the code printed on the QR label (or paste the scanned link).");
      return;
    }

    // PUBLIC verification URL → resolve through the public verification API,
    // then open the record through the existing deep-link mechanism.
    const verifyToken = parseVerifyUrl(raw);
    if (verifyToken) {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/v1/public/verify/${encodeURIComponent(verifyToken)}`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        const v = body?.verification as
          | { result?: string; number?: string; openPath?: string }
          | undefined;
        if (!v?.result) throw new Error("This QR code could not be verified.");
        const resourceToken = v.openPath?.match(/resource=equipment:([A-Za-z0-9_-]+)/)?.[1];
        if (v.result === "VERIFIED" && resourceToken) {
          onOpenChange(false);
          setCode("");
          onNavigate("equipment", resourceToken);
          return;
        }
        // Non-navigable result — honest message, dialog stays open.
        setError(
          v.result === "VERIFIED"
            ? `${v.number ?? "This record"} verified online. Open the record from its module page.`
            : "This QR code did not pass online verification."
        );
      } catch {
        setError("The verification service could not be reached. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }

    // Legacy deep link / bare token — existing behaviour.
    const parsed = parseResource(raw);
    if (!parsed || !parsed.token) {
      setError("Enter the code printed on the QR label (or paste the scanned link).");
      return;
    }
    onOpenChange(false);
    setCode("");
    setError(null);
    onNavigate(parsed.type, parsed.token);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setCode(""); setError(null); } onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="h-9 w-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <QrCode className="h-5 w-5" aria-hidden />
            </span>
            QR Scanner
          </DialogTitle>
          <DialogDescription>
            Scan an asset QR label with your device camera app, then paste the code or link here to open the record.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="qr-code">Scanned code or link</Label>
            <Input
              id="qr-code"
              value={code}
              onChange={(e) => { setCode(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              placeholder="e.g. https://app.mohdhms.com/verify/{token} or the raw token"
              autoComplete="off"
            />
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <ScanLine className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            Every QR code verifies online first — verified equipment records open directly.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={!code.trim() || busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <QrCode className="h-4 w-4 mr-1.5" />}
            {busy ? "Verifying…" : "Open record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
