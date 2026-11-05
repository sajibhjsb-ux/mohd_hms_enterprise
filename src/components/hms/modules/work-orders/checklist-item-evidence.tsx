// MOHD.HMS ENTERPRISE — Per-item checklist evidence.
// Uploads are linked to the checklist item through Document.label=<itemId> so
// submission validation counts photos per item, not globally.
"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoUploader } from "@/components/hms/shared/photo-capture";
import { cn } from "@/lib/utils";

type PhotoRow = { id: string; name: string; mimeType: string; sizeBytes: number; label: string; createdAt: string };

type ChecklistItemEvidenceProps = {
  workOrderId: string;
  itemId: string;
  canUpload?: boolean;
  requiresPhoto?: boolean;
  onChanged?: () => void;
};

export function ChecklistItemEvidence({
  workOrderId,
  itemId,
  canUpload = false,
  requiresPhoto = false,
  onChanged,
}: ChecklistItemEvidenceProps) {
  const { toast } = useToast();
  const [items, setItems] = useState<PhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PhotoRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<PhotoRow[]>(`/api/v1/work-orders/${workOrderId}/photos`);
      setItems((Array.isArray(res.data) ? res.data : []).filter((m) => m.label === itemId));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workOrderId, itemId]);

  useEffect(() => { void load(); }, [load]);

  const count = items.length;
  const isImage = (m: string) => m.startsWith("image/");

  const uploadPhoto = useCallback(
    async (file: File, ctx: { uploadId: string }) => {
      if (!canUpload) return;
      const fd = new FormData();
      fd.append("file", file);
      fd.append("itemId", itemId);
      fd.append("uploadId", ctx.uploadId);
      try {
        const res = await api.postForm<PhotoRow>(`/api/v1/work-orders/${workOrderId}/photos`, fd);
        setItems((prev) => (prev.some((p) => p.id === res.data.id) ? prev : [...prev, res.data]));
        void onChanged?.();
      } catch (e) {
        toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
      }
    },
    [workOrderId, itemId, canUpload, onChanged, toast]
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading…</p>
    );
  }

  return (
    <div className={cn("rounded-lg border p-2 sm:p-3 space-y-2", requiresPhoto && count === 0 ? "border-amber-500/50 bg-amber-50/5" : "")}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium flex items-center gap-1.5">
          <Camera className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          Evidence
        </p>
        <span className={cn("text-xs font-mono tabular-nums", count === 0 && requiresPhoto ? "text-destructive font-semibold" : "text-muted-foreground")}>
          {count} photo{count === 1 ? "" : "s"}
        </span>
      </div>
      {count === 0 && requiresPhoto ? (
        <p className="text-xs text-destructive">Photo evidence required for this item.</p>
      ) : null}

      {canUpload ? (
        <PhotoUploader
          multiple
          maxBytes={15 * 1024 * 1024}
          uploadLabel="Add item photo"
          hint="JPEG/PNG/WebP ≤ 15 MB. The photo is linked to this checklist item."
          onUpload={uploadPhoto}
          onUploaded={() => { toast({ title: "Item photo saved" }); }}
        />
      ) : null}

      {count === 0 && !canUpload ? (
        <p className="text-xs text-muted-foreground">No item evidence yet.</p>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {items.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-label={m.name}
              className="relative block aspect-square rounded-lg border overflow-hidden bg-muted/30 group"
              onClick={() => setPreview(m)}
            >
              {isImage(m.mimeType) ? (
                <img src={`/api/v1/work-orders/${workOrderId}/photos/${m.id}/file`} alt={m.name} loading="lazy" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-[10px] font-mono text-muted-foreground">VIDEO</span>
              )}
            </button>
          ))}
        </div>
      )}

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={preview.name}>
          <div className="relative max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-background shadow-2xl">
            <button
              type="button"
              onClick={() => setPreview(null)}
              aria-label="Close preview"
              className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex max-h-[calc(90vh-3.5rem)] items-center justify-center bg-black/90 p-3">
              {isImage(preview.mimeType) ? (
                <img src={`/api/v1/work-orders/${workOrderId}/photos/${preview.id}/file`} alt={preview.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <video src={`/api/v1/work-orders/${workOrderId}/photos/${preview.id}/file`} controls className="max-h-full max-w-full" />
              )}
            </div>
            <div className="border-t p-3 text-xs text-muted-foreground flex justify-between items-center gap-2">
              <span className="truncate font-medium text-foreground">{preview.name}</span>
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>Close</Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
