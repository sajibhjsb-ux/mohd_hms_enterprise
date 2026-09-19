"use client";

// MOHD.HMS ENTERPRISE — QR scanner entry dialog.
// Camera hardware scanning is a device capability; the app's existing QR
// machinery is the qrToken deep link (/?resource=equipment:{qrToken}) used by
// printed QR labels. This dialog reuses that exact mechanism — paste/enter a
// scanned code (raw token or the full deep-link URL) and the shell navigates
// to the Equipment module through the same deep-link path. No duplicate QR logic.

import { useState } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { QrCode, ScanLine } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Goes through the shell's dirty-state guard before switching modules. */
  onNavigate: (module: string, token: string) => void;
};

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

  function submit() {
    const parsed = parseResource(code);
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
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              placeholder="e.g. /?resource=equipment:{token} or the raw token"
              autoComplete="off"
            />
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          </div>
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <ScanLine className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            Every equipment unit carries a unique QR label — scanning it deep-links straight to the asset record.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!code.trim()}>
            <QrCode className="h-4 w-4 mr-1.5" /> Open record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
