"use client";

// MOHD.HMS ENTERPRISE — Work Order evidence (before-work and completion).
// Upload + gallery of evidence photos. The backend gate at Start Work counts
// real persisted media records against the configurable minimum, and completion
// requires persisted AFTER evidence. UI state is never trusted.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoUploader } from "@/components/hms/shared/photo-capture";
import { cn } from "@/lib/utils";

type PhotoRow = { id: string; name: string; mimeType: string; sizeBytes: number; label: string; createdAt: string };
type EvidencePhase = "BEFORE" | "AFTER";

export function BeforeWorkPanel({
  workOrderId,
  canUpload,
  phase = "BEFORE",
}: {
  workOrderId: string;
  canUpload: boolean;
  phase?: EvidencePhase;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<PhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [preview, setPreview] = useState<PhotoRow | null>(null);
  const isAfter = phase === "AFTER";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<PhotoRow[]>(`/api/v1/work-orders/${workOrderId}/photos`);
      setItems((Array.isArray(res.data) ? res.data : []).filter((m) => m.label === phase));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workOrderId, phase]);

  useEffect(() => { void load(); }, [load]);

  const uploadPhoto = async (file: File, ctx: { uploadId: string }) => {
    if (!canUpload) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("phase", phase);
    fd.append("uploadId", ctx.uploadId);
    const res = await api.postForm<PhotoRow>("/api/v1/work-orders/" + workOrderId + "/photos", fd);
    setItems((prev) => (prev.some((p) => p.id === res.data.id) ? prev : [...prev, res.data]));
  };

  const uploadVideo = async (file: File) => {
    if (!canUpload) return;
    setUploadingVideo(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("phase", phase);
      const res = await api.postForm<PhotoRow>("/api/v1/work-orders/" + workOrderId + "/photos", fd);
      setItems((prev) => (prev.some((p) => p.id === res.data.id) ? prev : [...prev, res.data]));
      toast({ title: "Video uploaded", description: isAfter ? "Recorded as completion evidence." : "Recorded as before-work evidence." });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setUploadingVideo(false);
    }
  };

  const isImage = (m: string) => m.startsWith("image/");

  return (
    <div className={cn("rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4")}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <Camera className="h-4 w-4 text-primary" aria-hidden /> {isAfter ? "Completion evidence" : "Before-work evidence"}
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length} file{items.length === 1 ? "" : "s"}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {isAfter
          ? "Required before this work order can be completed — the backend verifies at least one saved AFTER photo or video."
          : "Required before the assigned technician can Start Work — verified by the backend against these actual records."}
      </p>

      {canUpload ? (
        <div className="space-y-2">
          <PhotoUploader
            multiple
            maxBytes={15 * 1024 * 1024}
            uploadLabel="Upload photo"
            hint="Take a photo or choose existing images (JPEG/PNG/WebP, up to 15 MB). Review before uploading."
            onUpload={uploadPhoto}
            onUploaded={() => { toast({ title: "Evidence saved", description: isAfter ? "Completion evidence uploaded." : "Before-work evidence uploaded." }); }}
          />
          <div>
            <label
              htmlFor={`bw-video-${workOrderId}-${phase}`}
              className="inline-flex items-center gap-2 rounded-md border border-dashed bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground cursor-pointer hover:bg-accent/40 transition-colors min-h-[44px]"
            >
              {uploadingVideo ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Upload className="h-4 w-4" aria-hidden />}
              {uploadingVideo ? "Uploading video…" : "Add video evidence (MP4/WebM ≤50 MB)"}
            </label>
            <input
              id={`bw-video-${workOrderId}-${phase}`}
              type="file"
              accept="video/mp4,video/webm"
              className="sr-only"
              disabled={uploadingVideo}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void uploadVideo(f);
              }}
            />
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{isAfter ? "No completion evidence yet." : "No before-work photos yet."}</p>
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
                  <span className="flex h-full w-full items-center justify-center text-[10px] font-mono text-muted-foreground">VIDEO</span>
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
