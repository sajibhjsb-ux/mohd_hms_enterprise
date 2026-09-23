"use client";

// MOHD.HMS ENTERPRISE — Complaint Media panel (§2/§3/§4/§13/§14).
// PHOTOS & VIDEOS section on the complaint detail page. Upload stays available
// AFTER creation for the owning customer, the assigned technician and
// complaints_update staff — evidence is added during active handling, not only
// on the create form. Files live in the private object store (MinIO) with
// metadata in PostgreSQL; every byte is served through the authenticated,
// RBAC-scoped …/media/[mediaId]/file route — no public URLs, no ID guessing.
// Deletion is explicit + audited (uploader or staff, never on closed complaints).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { COMPLAINT_DETAIL_EVENTS } from "@/lib/hms/realtime/matrix";
import {
  AlertTriangle, ChevronLeft, ChevronRight, Download, FileVideo, Image as ImageIcon,
  Loader2, Trash2, Upload, X, ZoomIn,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { fmtDate, fmtDateTime, fmtTime } from "@/lib/hms/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PERMISSIONS } from "@/lib/hms/constants";

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

const PHASES = ["BEFORE", "DURING", "AFTER"] as const;
const IMAGE_MAX_BYTES = 15 * 1024 * 1024; // mirrors the backend magic-byte route
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

const isImage = (m: string) => m.startsWith("image/");

export function ComplaintMediaPanel({ complaintId, canUpload }: { complaintId: string; canUpload: boolean }) {
  const { user } = useSession();
  const { toast } = useToast();
  const [items, setItems] = useState<MediaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploadingKind, setUploadingKind] = useState<"image" | "video" | null>(null);
  const [phase, setPhase] = useState<string>("DURING");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<MediaRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const canUpdate = hasPerm(user, PERMISSIONS.complaints_update);
  const canDeleteItem = useCallback(
    (m: MediaRow) => canUpdate || (!!m.uploadedById && m.uploadedById === user?.id),
    [canUpdate, user?.id]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MediaRow[]>(`/api/v1/complaints/${complaintId}/media`);
      // Authoritative server list — the UI never invents upload state (§12/§38).
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [complaintId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: evidence added by another authorized user appears live.
  useRealtimeEvent(COMPLAINT_DETAIL_EVENTS, (ev) => {
    if (!ev.aggregate_id || ev.aggregate_id === complaintId) void load();
  });

  const upload = async (file: File, kind: "image" | "video") => {
    const limit = kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
    if (file.size > limit) {
      toast({
        title: "File too large",
        description: kind === "image" ? "Images must be 15 MB or smaller." : "Videos must be 50 MB or smaller.",
        variant: "destructive",
      });
      return;
    }
    setUploadingKind(kind);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("phase", phase);
      // POST persists to MinIO + PostgreSQL before responding — the toast below
      // fires only after the authoritative 201 (§12: no fake success).
      await api.postForm<MediaRow>(`/api/v1/complaints/${complaintId}/media`, fd);
      toast({ title: "Media uploaded", description: `${file.name} added to this complaint's evidence.` });
      await load();
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setUploadingKind(null);
    }
  };

  const removeMedia = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.del(`/api/v1/complaints/${complaintId}/media/${confirmDelete.id}`);
      toast({ title: "Media deleted", description: `${confirmDelete.name} was removed and the deletion recorded in the audit log.` });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  // §14 — chronological evidence timeline, newest day last in view? Newest
  // first for operators (latest evidence on top), items within a day oldest → newest.
  const grouped = useMemo(() => {
    const days: { day: string; rows: MediaRow[] }[] = [];
    for (const m of items) {
      const day = fmtDate(m.createdAt);
      let bucket = days.find((d) => d.day === day);
      if (!bucket) { bucket = { day, rows: [] }; days.push(bucket); }
      bucket.rows.push(m);
    }
    return days.reverse();
  }, [items]);

  const preview = previewIndex !== null ? items[previewIndex] ?? null : null;
  const stepPreview = (delta: number) => {
    if (previewIndex === null) return;
    const next = (previewIndex + delta + items.length) % items.length;
    setPreviewIndex(next);
    setZoomed(false);
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Photos &amp; Videos</h2>
          <p className="text-xs text-muted-foreground">Complaint evidence — added by customers, technicians and staff during handling.</p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{items.length} file{items.length === 1 ? "" : "s"}</span>
      </div>

      {canUpload ? (
        <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Evidence phase</Label>
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
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!!uploadingKind}
              onClick={() => photoInputRef.current?.click()}
              className="min-h-[44px]"
            >
              {uploadingKind === "image" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <ImageIcon className="h-4 w-4 mr-1.5" aria-hidden />}
              {uploadingKind === "image" ? "Uploading…" : "Add Photos"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!uploadingKind}
              onClick={() => videoInputRef.current?.click()}
              className="min-h-[44px]"
            >
              {uploadingKind === "video" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileVideo className="h-4 w-4 mr-1.5" aria-hidden />}
              {uploadingKind === "video" ? "Uploading…" : "Add Video"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            JPEG / PNG / WebP up to 15 MB · MP4 / MOV / WebM up to 50 MB. Uploads land in private object storage and only appear after the server confirms.
          </p>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={!!uploadingKind}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f, "image");
            }}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm"
            className="sr-only"
            disabled={!!uploadingKind}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f, "video");
            }}
          />
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading media…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No media attached yet.{canUpload ? " Use Add Photos or Add Video above — evidence can be added at any point while the complaint is open." : ""}
        </p>
      ) : (
        <div className="max-h-[32rem] space-y-4 overflow-y-auto pr-1">
          {grouped.map((group) => (
            <div key={group.day} className="space-y-2">
              <p className="sticky top-0 z-[1] bg-card text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.day}</p>
              <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {group.rows.map((m) => {
                  const idx = items.indexOf(m);
                  return (
                    <li key={m.id} className="group relative overflow-hidden rounded-lg border bg-muted/30">
                      <button
                        type="button"
                        onClick={() => { setPreviewIndex(idx); setZoomed(false); }}
                        className="block w-full aspect-square cursor-zoom-in"
                        title={`Preview ${m.name}`}
                        aria-label={`Preview ${m.name}`}
                      >
                        {isImage(m.mimeType) ? (
                          <img
                            src={`/api/v1/complaints/${complaintId}/media/${m.id}/file`}
                            alt={m.name}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                            <FileVideo className="h-8 w-8" aria-hidden />
                            <span className="text-[10px] font-mono uppercase">{m.mimeType.split("/")[1]}</span>
                          </span>
                        )}
                        <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{m.label}</span>
                      </button>
                      <div className="space-y-0.5 border-t p-2">
                        <p className="truncate text-xs font-medium" title={m.name}>{m.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {m.uploadedByName ?? "Unknown"} · {fmtTime(m.createdAt)} · {Math.round(m.sizeBytes / 1024)} KB
                        </p>
                        <div className="flex items-center gap-1 pt-0.5">
                          <button
                            type="button"
                            onClick={() => { setPreviewIndex(idx); setZoomed(false); }}
                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Preview ${m.name}`}
                          >
                            <ZoomIn className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <a
                            href={`/api/v1/complaints/${complaintId}/media/${m.id}/file?download=1`}
                            download={m.name}
                            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Download ${m.name}`}
                            title="Download"
                          >
                            <Download className="h-3.5 w-3.5" aria-hidden />
                          </a>
                          {canDeleteItem(m) ? (
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(m)}
                              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`Delete ${m.name}`}
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── Preview lightbox (§13): prev/next, zoom, video play/pause/seek ── */}
      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={preview.name}>
          <button
            type="button"
            onClick={() => { setPreviewIndex(null); setZoomed(false); }}
            aria-label="Close preview"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <X className="h-4 w-4" />
          </button>
          {items.length > 1 ? (
            <>
              <button
                type="button"
                onClick={() => stepPreview(-1)}
                aria-label="Previous media"
                className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => stepPreview(1)}
                aria-label="Next media"
                className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          ) : null}
          <div className="relative max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-background shadow-2xl">
            <div className={cn("flex items-center justify-center bg-black/90 p-3", zoomed ? "max-h-[calc(90vh-6.5rem)] overflow-auto" : "max-h-[calc(90vh-6.5rem)]")}>
              {isImage(preview.mimeType) ? (
                <img
                  src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`}
                  alt={preview.name}
                  className={cn("max-h-full max-w-full object-contain transition-transform", zoomed && "scale-150 cursor-zoom-out")}
                  onClick={() => setZoomed((z) => !z)}
                />
              ) : (
                <video
                  key={preview.id}
                  src={`/api/v1/complaints/${complaintId}/media/${preview.id}/file`}
                  controls
                  playsInline
                  className="max-h-full max-w-full"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-foreground">{preview.name}</span>
                {isImage(preview.mimeType) ? (
                  <button
                    type="button"
                    onClick={() => setZoomed((z) => !z)}
                    className="rounded p-1 hover:bg-accent hover:text-foreground"
                    aria-label={zoomed ? "Reset zoom" : "Zoom in"}
                  >
                    <ZoomIn className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span>{preview.label}</span>·<span>{fmtDateTime(preview.createdAt)}</span>
                ·<span>by {preview.uploadedByName ?? "Unknown"}</span>
                ·<span>{Math.round(preview.sizeBytes / 1024)} KB</span>
                ·<span>{previewIndex !== null ? `${previewIndex + 1}/${items.length}` : ""}</span>
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Delete confirmation (§15 — never silent, audit recorded server-side) ── */}
      <AlertDialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              The file is removed from storage and the deletion is recorded in the audit log with your name. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Keep media</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void removeMedia(); }}
            >
              {deleting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />}
              Delete media
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canUpload ? null : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Upload className="h-3 w-3" aria-hidden />
          Viewing only — the assigned technician, authorized staff and the owning customer can attach evidence.
        </p>
      )}
    </div>
  );
}
