"use client";

// MOHD.HMS ENTERPRISE — Work Order Before-Work Evidence (§15/§18).
// Upload + gallery of pre-start work photos. Backend gate at Start Work counts
// these REAL persisted media records (never a boolean) against the configurable
// minimum (automation start_work_before_photos_min, default 1).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PhotoRow = { id: string; name: string; mimeType: string; sizeBytes: number; label: string; createdAt: string };

export function BeforeWorkPanel({ workOrderId, canUpload }: { workOrderId: string; canUpload: boolean }) {
  const { toast } = useToast();
  const [items, setItems] = useState<PhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<PhotoRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<PhotoRow[]>(`/api/v1/work-orders/${workOrderId}/photos`);
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workOrderId]);

  useEffect(() => { void load(); }, [load]);

  const onUpload = async (file: File) => {
    if (!canUpload) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("phase", "BEFORE");
      const res = await api.postForm<PhotoRow>("/api/v1/work-orders/" + workOrderId + "/photos", fd);
      setItems((prev) => [...prev, res.data]);
      toast({ title: "Photo uploaded", description: "Recorded as before-work evidence." });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const isImage = (m: string) => m.startsWith("image/");

  return (
    <div className={cn("rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4")}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <Camera className="h-4 w-4 text-primary" aria-hidden /> Before-work evidence
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length} photo{items.length === 1 ? "" : "s"}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Required before the assigned technician can <span className="font-medium">Start Work</span> — verified by the backend against these actual records.
      </p>

      {canUpload ? (
        <label
          htmlFor={`bw-file-${workOrderId}`}
          className="flex items-center justify-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-5 text-sm text-muted-foreground cursor-pointer hover:bg-accent/40 transition-colors"
        >
          <Upload className="h-4 w-4" aria-hidden />
          {uploading ? "Uploading…" : "Upload before-work photo (JPEG/PNG/WebP ≤15 MB, MP4/WebM ≤50 MB)"}
        </label>
      ) : null}
      <input
        id={`bw-file-${workOrderId}`}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
        capture="environment"
        className="sr-only"
        disabled={uploading}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onUpload(f);
        }}
      />

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No before-work photos yet.</p>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setPreview(m)}
                className="group relative block w-full overflow-hidden rounded-lg border bg-muted/30 aspect-square"
                title={m.name}
              >
                {isImage(m.mimeType) ? (
                   
                  <img
                    src={`/api/v1/work-orders/${workOrderId}/photos/${m.id}/file`}
                    alt={m.name}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] font-mono text-muted-foreground">MP4</span>
                )}
              </button>
            </li>
          ))}
        </ul>
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