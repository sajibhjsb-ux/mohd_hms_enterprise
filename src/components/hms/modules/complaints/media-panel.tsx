"use client";

// MOHD.HMS ENTERPRISE — Complaint Media panel (§14).
// Gallery + upload for complaint photo/video evidence. Files are stored in the
// private object store (MinIO) with metadata in PostgreSQL; every byte is served
// through the authenticated, RBAC-scoped …/media/[mediaId]/file route — there is
// no public bucket, no presigned leakage, no ID-guessing (404 for out-of-scope).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/hms/format";

type MediaRow = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  label: string;
  uploadedById?: string | null;
  createdAt: string;
};

const PHASES = ["BEFORE", "DURING", "AFTER"] as const;

export function ComplaintMediaPanel({ complaintId, canUpload }: { complaintId: string; canUpload: boolean }) {
  const { user } = useSession();
  const { toast } = useToast();
  const [items, setItems] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [phase, setPhase] = useState<string>("DURING");
  const [preview, setPreview] = useState<MediaRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MediaRow[]>(`/api/v1/complaints/${complaintId}/media`);
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [complaintId]);

  useEffect(() => { void load(); }, [load]);

  const onUpload = async (file: File) => {
    if (!canUpload) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("phase", phase);
      const res = await api.postForm<MediaRow>("/api/v1/complaints/" + complaintId + "/media", fd);
      setItems((prev) => [res.data, ...prev]);
      toast({ title: "Media uploaded", description: "Added to this complaint's evidence." });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const isImage = (m: string) => m.startsWith("image/");

  return (
    <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs uppercase tracking-wide">Complaint media</p>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length} file{items.length === 1 ? "" : "s"}</span>
      </div>

      {canUpload ? (
        <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="cm-phase" className="text-xs uppercase tracking-wide text-muted-foreground">Phase</Label>
            <div className="flex items-center gap-1">
              {PHASES.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPhase(p)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors border",
                    phase === p ? "bg-primary text-primary-foreground border-primary" : "border-input text-muted-foreground hover:bg-accent"
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <label
            htmlFor={`cm-file-${complaintId}`}
            className="flex items-center justify-center gap-2 rounded-md border bg-background px-3 py-6 text-sm text-muted-foreground cursor-pointer hover:bg-accent/40 transition-colors"
          >
            <Upload className="h-4 w-4" aria-hidden />
            {uploading ? "Uploading…" : "Upload photo or video (JPEG/PNG/WebP ≤15 MB, MP4/WebM ≤50 MB)"}
          </label>
          <input
            id={`cm-file-${complaintId}`}
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onUpload(f);
            }}
          />
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading media…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No media attached yet.</p>
      ) : (
        <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
          {items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setPreview(m)}
                className="group relative block w-full overflow-hidden rounded-lg border bg-muted/30 aspect-square"
                title={`${m.name} (${m.label})`}
              >
                {isImage(m.mimeType) ? (
                   
                  <img
                    src={`/api/v1/complaints/${complaintId}/media/${m.id}/file`}
                    alt={m.name}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[10px] font-mono text-muted-foreground">MP4</span>
                )}
                <span className="absolute inset-x-0 bottom-0 bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white capitalize">{m.label.toLowerCase()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Preview dialog */}
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
                 
                <img src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`} alt={preview.name} className="max-h-full max-w-full object-contain" />
              ) : (
                 
                <video src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`} controls className="max-h-full max-w-full" />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">{preview.name}</span>
              <span className="flex items-center gap-2">
                <span className="capitalize">{preview.label.toLowerCase()}</span>·<span>{fmtDateTime(preview.createdAt)}</span>·<span>{Math.round(preview.sizeBytes / 1024)} KB</span>
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {canUpload ? null : <p className="text-xs text-muted-foreground">Viewing only — assigned technicians and staff can attach evidence.</p>}
    </div>
  );
}