"use client";

// MOHD.HMS ENTERPRISE — dedicated QR Label page (equipment/{id}/label view).
// Replaces the former QR label dialog: same endpoint (GET /api/v1/equipment/{id}/qr),
// same label content, Download + window.print() kept. The label card is the only
// printable region — nav/footer are excluded via the global no-print classes.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Download, Printer, QrCode } from "lucide-react";
import type { QrData } from "./shared";

export function EquipmentLabelPage({ id }: { id: string }) {
  const [qr, setQr] = useState<QrData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<QrData>(`/api/v1/equipment/${id}/qr`);
      setQr(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate the QR label.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function downloadQr() {
    if (!qr) return;
    const a = document.createElement("a");
    a.href = qr.dataUrl;
    a.download = `qr-${qr.assetTag}.png`;
    a.click();
  }

  return (
    <PageShell
      backLabel="Back to Equipment"
      backHref="/equipment"
      crumbs={[
        { label: "Equipment", href: "/equipment" },
        { label: qr?.name ?? qr?.assetTag ?? "…", href: `/equipment/${encodeURIComponent(id)}` },
        { label: "QR Label" },
      ]}
      title="QR label"
      description="Scanning opens this asset in the app (staff) or its portal view."
    >
      {loading && !qr ? (
        <LoadingState label="Generating QR…" rows={2} />
      ) : error && !qr ? (
        <ErrorState message={error} onRetry={load} />
      ) : qr ? (
        <div className="max-w-sm mx-auto">
          {/* Printable label card — everything else on the page is no-print */}
          <div className="rounded-xl border bg-card shadow-sm p-6 flex flex-col items-center gap-3">
            <img src={qr.dataUrl} alt={`QR code for ${qr.assetTag}`} className="rounded-lg border p-2 w-56 h-56" />
            <div className="text-center">
              <p className="font-medium">{qr.name}</p>
              <p className="text-xs text-muted-foreground font-mono">{qr.assetTag}</p>
            </div>
            <p className="text-[11px] text-muted-foreground break-all text-center">{qr.url}</p>
          </div>

          <div className="grid grid-cols-2 gap-2 mt-4 no-print">
            <Button variant="outline" onClick={downloadQr}>
              <Download className="h-4 w-4 mr-1.5" /> Download
            </Button>
            <Button variant="outline" onClick={() => window.print()}>
              <Printer className="h-4 w-4 mr-1.5" /> Print
            </Button>
          </div>

          <p className="mt-3 text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5 no-print">
            <QrCode className="h-3.5 w-3.5" aria-hidden /> Print the label and attach it to the unit — scans route straight to this asset.
          </p>
        </div>
      ) : null}
    </PageShell>
  );
}
