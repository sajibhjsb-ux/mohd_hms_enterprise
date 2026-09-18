// MOHD.HMS ENTERPRISE — Client PDF download/preview helper (§10/§11).
//
// Flow per spec: loading state → GET API → status check → content-type check
// → blob → object URL → temporary <a download> → click → revoke. Success is
// reported ONLY after a valid application/pdf response was received (§36 —
// no fake success). Preview opens the same endpoint inline (browser PDF
// viewer, §11) without triggering a download.

import { useCallback, useState } from "react";
import { useToast } from "@/hooks/use-toast";

export type PdfType =
  | "work-order"
  | "complaint"
  | "inspection-report"
  | "quotation"
  | "invoice"
  | "purchase-order"
  | "equipment-report"
  | "pm-task"
  | "payment-receipt";

export class PdfClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1] : null;
}

/** Same endpoint powers download (attachment) and preview (inline). */
export function pdfInlineUrl(type: PdfType, id: string): string {
  return `/api/v1/pdf/${type}/${id}?disposition=inline`;
}

/** Fetch a document and trigger a real browser download (§10 flow). */
export async function downloadPdf(type: PdfType, id: string): Promise<{ filename: string; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/pdf/${type}/${id}`, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new PdfClientError("Could not reach the server. Check your connection and try again.", 0);
  }

  if (!res.ok) {
    let message = "The document could not be generated.";
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* non-JSON error body — keep the default message */
    }
    if (res.status === 401) message = "Your session has expired. Please sign in again.";
    else if (res.status === 403) message = "You do not have permission to download this document.";
    else if (res.status === 404) message = "This document does not exist or you cannot access it.";
    throw new PdfClientError(message, res.status);
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/pdf")) {
    // §36 — the server did NOT return a PDF; never pretend the download worked.
    throw new PdfClientError("The server returned an unexpected response instead of a PDF document.", 502);
  }

  const blob = await res.blob();
  if (blob.size < 100 || (blob.type && !blob.type.toLowerCase().includes("pdf"))) {
    throw new PdfClientError("The generated document is invalid or empty. Please try again.", 502);
  }

  const filename = filenameFromDisposition(res.headers.get("content-disposition")) ?? `MOHD-HMS-document-${Date.now()}.pdf`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);

  return { filename, bytes: blob.size };
}

/** Open the document inline in a new tab (browser PDF viewer) — §11 preview. */
export function previewPdf(type: PdfType, id: string): boolean {
  const win = window.open(pdfInlineUrl(type, id), "_blank", "noopener,noreferrer");
  if (!win) {
    // Pop-up blocked — surface a real, actionable message (§24).
    throw new PdfClientError("Your browser blocked the preview window. Allow pop-ups for this site, or use Download PDF.", 0);
  }
  return true;
}

/**
 * Hook wiring the download/preview flows into UI buttons: busy state for
 * disabled/loading labels, toast feedback only on real outcomes.
 */
export function usePdfDownload() {
  const { toast } = useToast();
  const [busyType, setBusyType] = useState<string | null>(null);

  const download = useCallback(
    async (type: PdfType, id: string, label?: string) => {
      const key = `${type}:${id}`;
      setBusyType(key);
      try {
        const { filename } = await downloadPdf(type, id);
        toast({ title: `${label ?? "Document"} downloaded`, description: filename });
        return true;
      } catch (e) {
        toast({
          title: "Download failed",
          description: e instanceof Error ? e.message : "The document could not be generated.",
          variant: "destructive",
        });
        return false;
      } finally {
        setBusyType(null);
      }
    },
    [toast]
  );

  const preview = useCallback(
    (type: PdfType, id: string) => {
      try {
        previewPdf(type, id);
      } catch (e) {
        toast({
          title: "Preview failed",
          description: e instanceof Error ? e.message : "The document could not be opened.",
          variant: "destructive",
        });
      }
    },
    [toast]
  );

  const busy = (type: PdfType, id: string) => busyType === `${type}:${id}`;

  return { download, preview, busy, busyType };
}
