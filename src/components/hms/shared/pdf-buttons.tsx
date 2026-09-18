"use client";

// MOHD.HMS ENTERPRISE — shared PDF action buttons (Download / Preview).
// Every module composes these; the actual flows live in lib/hms/pdf-client
// (§10 blob download, §11 inline preview). Success/error feedback is toast
// based and only fires on REAL outcomes (§36 — no fake success).

import { Button } from "@/components/ui/button";
import { Eye, FileDown } from "lucide-react";
import { usePdfDownload, type PdfType } from "@/lib/hms/pdf-client";

type Props = {
  type: PdfType;
  id: string;
  /** Human label used in toasts and aria-labels, e.g. "Invoice INV-2026-0001". */
  label?: string;
  size?: "sm" | "default";
  /** Compact icon-only variant for table rows. */
  iconOnly?: boolean;
  /** Also render the inline Preview button (opens the browser PDF viewer). */
  showPreview?: boolean;
  className?: string;
};

export function PdfButtons({ type, id, label, size = "sm", iconOnly = false, showPreview = false, className }: Props) {
  const { download, preview, busy } = usePdfDownload();
  const isBusy = busy(type, id);
  const text = label ?? "Document";

  if (iconOnly) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={className}
        disabled={isBusy}
        onClick={() => void download(type, id, text)}
        aria-label={`Download PDF for ${text}`}
        title="Download PDF"
      >
        <FileDown className="h-3.5 w-3.5" />
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size={size}
        className={className}
        disabled={isBusy}
        onClick={() => void download(type, id, text)}
        aria-label={`Download PDF for ${text}`}
      >
        <FileDown className="h-4 w-4 mr-1.5" />
        {isBusy ? "Preparing…" : "Download PDF"}
      </Button>
      {showPreview ? (
        <Button variant="outline" size={size} className={className} onClick={() => preview(type, id)} aria-label={`Preview PDF for ${text}`}>
          <Eye className="h-4 w-4 mr-1.5" /> Preview
        </Button>
      ) : null}
    </>
  );
}
