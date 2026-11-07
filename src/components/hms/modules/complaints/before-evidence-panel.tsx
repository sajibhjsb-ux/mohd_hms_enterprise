"use client";

// MOHD.HMS ENTERPRISE — Complaint BEFORE evidence (read-only, post-submission).
//
// Once a complaint is submitted, its evidence is permanently locked. This panel
// renders the submitted BEFORE photos/videos as a read-only gallery. No upload,
// camera, delete or replace controls exist here — maintenance evidence is
// collected exclusively through the associated Work Order.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { FileVideo, Image, Loader2, Lock, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/hms/format";

type MediaRow = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  label: string;
  uploadedById?: string | null;
  uploadedByName?: string | null;
  createdAt: string;
};

const isImage = (m: string) => m.startsWith("image/");

export function ComplaintBeforeEvidencePanel({
  complaintId,
  complaintControlled,
}: {
  complaintId: string;
  complaintControlled?: boolean;
}) {
  const [items, setItems] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MediaRow[]>(`/api/v1/complaints/${complaintId}/media`);
      const all = Array.isArray(res.data) ? res.data : [];
      // Complaint page shows only BEFORE evidence — DURING/AFTER live on the WO.
      setItems(all.filter((m) => m.label === "BEFORE"));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [complaintId]);

  useEffect(() => { void load(); }, [load]);

  const preview = previewIndex !== null ? items[previewIndex] ?? null : null;

  const stepPreview = (delta: number) => {
    if (previewIndex === null) return;
    setPreviewIndex((previewIndex + delta + items.length) % items.length);
  };

  return (
    <div className={cn("rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4", complaintControlled && "border-amber-200/50 bg-amber-50/30")}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-amber-600" aria-hidden />
            Before Work Evidence
          </h2>
          <p className="text-xs text-muted-foreground">
            Submitted with the complaint — locked after submission.
          </p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {items.length} file{items.length === 1 ? "" : "s"}
        </span>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading evidence…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-center">
          <Image className="h-8 w-8 text-muted-foreground/40 mx-auto" aria-hidden />
          <p className="mt-2 text-xs text-muted-foreground">No before-work evidence submitted with this complaint.</p>
        </div>
      ) : (
        <div className="max-h-[32rem] space-y-4 overflow-y-auto pr-1">
          {items.map((m, idx) => (
            <div key={m.id} className="group relative overflow-hidden rounded-lg border bg-muted/30">
              <button
                type="button"
                onClick={() => setPreviewIndex(idx)}
                className="block w-full aspect-square cursor-zoom-in"
                title={`Preview ${m.name}`}
                aria-label={`Preview ${m.name}`}
              >
                {isImage(m.mimeType) ? (
                  <img src={`/api/v1/complaints/${complaintId}/media/${m.id}/file`} alt={m.name} loading="lazy" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                    <FileVideo className="h-8 w-8" aria-hidden />
                    <span className="text-[10px] font-mono uppercase">{m.mimeType.split("/")[1]}</span>
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded bg-amber-900/80 px-1.5 py-0.5 text-[10px] font-medium text-amber-100">{m.label}</span>
              </button>
              <div className="space-y-0.5 border-t p-2">
                <p className="truncate text-xs font-medium" title={m.name}>{m.name}</p>
                <p className="text-[11px] text-muted-foreground">
                  {m.uploadedByName ?? "Unknown"} · {fmtDateTime(m.createdAt)} · {Math.round(m.sizeBytes / 1024)} KB
                </p>
                <div className="flex items-center gap-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setPreviewIndex(idx)}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={`Preview ${m.name}`}
                  >
                    <Play className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <a
                    href={`/api/v1/complaints/${complaintId}/media/${m.id}/file?download=1`}
                    download={m.name}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    aria-label={`Download ${m.name}`}
                    title="Download"
                  >
                    <Image className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {complaintControlled && items.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50/50 rounded-lg px-3 py-2">
          <Lock className="h-3 w-3" aria-hidden />
          Evidence locked — additional maintenance photos and videos must be uploaded through the associated Work Order.
        </p>
      )}
      {!complaintControlled && items.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden />
          Evidence will be locked once this complaint is submitted.
        </p>
      )}

      {/* Preview lightbox */}
      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={preview.name}>
          <button
            type="button"
            onClick={() => setPreviewIndex(null)}
            aria-label="Close preview"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <Image className="h-4 w-4" />
          </button>
          <div className="relative max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-background shadow-2xl">
            <div className="flex items-center justify-center bg-black/90 p-3 max-h-[calc(90vh-6.5rem)] overflow-auto">
              {isImage(preview.mimeType) ? (
                <img src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`} alt={preview.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <video src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`} controls playsInline className="max-h-full max-w-full" />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-foreground">{preview.name}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span>{preview.label}</span>·<span>{fmtDateTime(preview.createdAt)}</span>·<span>by {preview.uploadedByName ?? "Unknown"}</span>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
