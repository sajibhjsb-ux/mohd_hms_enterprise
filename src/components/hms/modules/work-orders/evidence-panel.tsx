"use client";

// MOHD.HMS ENTERPRISE — Work Order evidence (Before / During / After).
//
// Three strictly separated evidence sections:
//   • BEFORE WORK — read-only evidence imported from the originating Complaint.
//   • DURING WORK — editable evidence captured while the Work Order is active.
//   • AFTER WORK — editable completion evidence required before closure.
//
// All uploads go through the Work Order photos API. The backend enforces:
//   • No BEFORE uploads after complaint submission.
//   • No DURING uploads unless the WO is in an active state.
//   • No AFTER uploads unless the WO is in a completion-eligible state.
//   • No uploads at all after WO closure.
//   • At least one AFTER photo/video before CLOSED.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Camera, FileVideo, Image, Loader2, Lock, Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PhotoUploader } from "@/components/hms/shared/photo-capture";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/hms/format";

type MediaSource = "COMPLAINT" | "WORK_ORDER";

type MediaRow = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  label: string;
  uploadedById?: string | null;
  uploadedByName?: string | null;
  createdAt: string;
  source?: MediaSource;
};

type EvidencePhase = "BEFORE" | "DURING" | "AFTER";

const PHASE_LABELS: Record<EvidencePhase, string> = {
  BEFORE: "Before Work",
  DURING: "During Work",
  AFTER: "After Work",
};

const PHASE_DESC: Record<EvidencePhase, string> = {
  BEFORE: "Evidence captured before work starts. Complaint evidence is read-only; add photos here before starting.",
  DURING: "Capture evidence while work is in progress.",
  AFTER: "Capture completion evidence before submitting for review.",
};

const isImage = (m: string) => m.startsWith("image/");

const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

// Active states where DURING/AFTER uploads are allowed.
const ACTIVE_STATUSES = ["IN_PROGRESS", "ON_HOLD"];
// Before-work evidence is added before Start Work; supervisors/admins may
// correct it after start (the backend enforces the same rule).
const BEFORE_STATUSES = ["PENDING", "ACCEPTED"];

function canUploadPhase(
  phase: EvidencePhase,
  woStatus: string | null | undefined,
  canManageBefore: boolean
): boolean {
  if (!woStatus) return false;
  if (["COMPLETED", "CLOSED", "CANCELLED"].includes(woStatus)) return false;
  if (phase === "BEFORE") return BEFORE_STATUSES.includes(woStatus) || canManageBefore;
  if (phase === "DURING" || phase === "AFTER") return ACTIVE_STATUSES.includes(woStatus);
  return false;
}

export function EvidencePanel({
  workOrderId,
  complaintId,
  canUpload,
  canManageBefore = false,
  workOrderStatus,
}: {
  workOrderId: string;
  complaintId?: string | null;
  canUpload: boolean;
  /** Supervisors/admins may correct before-work evidence after Start Work. */
  canManageBefore?: boolean;
  workOrderStatus?: string | null;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<Record<EvidencePhase, MediaRow[]>>({
    BEFORE: [],
    DURING: [],
    AFTER: [],
  });
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<{ phase: EvidencePhase; item: MediaRow } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Imported BEFORE evidence comes from the originating complaint (if any).
      // The complaint may be out of scope for this caller; a failure here must
      // not hide the work-order evidence.
      let importedBefore: MediaRow[] = [];
      if (complaintId) {
        try {
          const res = await api.get<MediaRow[]>(`/api/v1/complaints/${complaintId}/media`);
          importedBefore = (Array.isArray(res.data) ? res.data : [])
            .filter((m) => m.label === "BEFORE")
            .map((m) => ({ ...m, source: "COMPLAINT" as const }));
        } catch {
          importedBefore = [];
        }
      }
      // BEFORE/DURING/AFTER evidence uploaded directly to the Work Order.
      const woRes = await api.get<MediaRow[]>(`/api/v1/work-orders/${workOrderId}/photos`);
      const woItems = (Array.isArray(woRes.data) ? woRes.data : []).map((m) => ({ ...m, source: "WORK_ORDER" as const }));
      setItems({
        BEFORE: [...importedBefore, ...woItems.filter((m) => m.label === "BEFORE")],
        DURING: woItems.filter((m) => m.label === "DURING"),
        AFTER: woItems.filter((m) => m.label === "AFTER"),
      });
    } catch {
      setItems({ BEFORE: [], DURING: [], AFTER: [] });
    } finally {
      setLoading(false);
    }
  }, [workOrderId, complaintId]);

  useEffect(() => { void load(); }, [load]);

  // Imported complaint evidence is streamed from the complaint route; work-order
  // evidence from the work-order route. Using the wrong route is a guaranteed
  // 404 — this is the bug that made Before Work evidence appear broken.
  const fileUrl = (m: MediaRow) =>
    m.source === "COMPLAINT"
      ? `/api/v1/complaints/${complaintId}/media/${m.id}/file`
      : `/api/v1/work-orders/${workOrderId}/photos/${m.id}/file`;

  const removePhoto = async (phase: EvidencePhase, item: MediaRow) => {
    if (item.source === "COMPLAINT" || !canUpload) return;
    if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
    try {
      await api.del(`/api/v1/work-orders/${workOrderId}/photos/${item.id}`);
      setItems((prev) => ({ ...prev, [phase]: prev[phase].filter((p) => p.id !== item.id) }));
      toast({ title: "Evidence deleted", description: item.name });
    } catch (e) {
      toast({ title: "Could not delete evidence", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    }
  };

  const uploadPhoto = async (phase: EvidencePhase, file: File, ctx: { uploadId: string }) => {
    if (!canUpload) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("phase", phase);
    fd.append("uploadId", ctx.uploadId);
    try {
      const res = await api.postForm<MediaRow>(`/api/v1/work-orders/${workOrderId}/photos`, fd);
      setItems((prev) => {
        const existing = prev[phase].some((p) => p.id === res.data.id);
        return { ...prev, [phase]: existing ? prev[phase] : [...prev[phase], res.data] };
      });
      toast({ title: "Evidence uploaded", description: `${file.name} saved as ${PHASE_LABELS[phase]} evidence.` });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    }
  };

  const openPreview = (phase: EvidencePhase, idx: number) => {
    setPreview({ phase, item: items[phase][idx] });
  };

  const renderGallery = (phase: EvidencePhase, uploadEnabled: boolean) => {
    const phaseItems = items[phase];
    const isAfter = phase === "AFTER";
    const isDuring = phase === "DURING";

    return (
      <div className="rounded-xl border shadow-sm p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Camera className="h-3.5 w-3.5" aria-hidden />
              {PHASE_LABELS[phase]} Evidence
            </h2>
            <p className="text-xs text-muted-foreground">{PHASE_DESC[phase]}</p>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {phaseItems.length} file{phaseItems.length === 1 ? "" : "s"}
          </span>
        </div>

        {uploadEnabled && canUpload ? (
          <div className="space-y-3 rounded-lg border border-dashed bg-muted/20 p-3">
            <PhotoUploader
              multiple
              maxBytes={IMAGE_MAX_BYTES}
              videoMaxBytes={VIDEO_MAX_BYTES}
              uploadLabel={phase === "BEFORE" ? "Add before-work photo" : "Upload photo"}
              videoEnabled={phase !== "BEFORE"}
              hint={phase === "BEFORE"
                ? "Take a photo or choose an existing image (JPEG/PNG/WebP ≤ 15 MB) before starting work."
                : isAfter
                  ? "At least one completion photo is required before this work order can be closed."
                  : "Take photos/videos or choose existing files."}
              onUpload={(file, ctx) => uploadPhoto(phase, file, ctx)}
              onUploaded={() => void load()}
              disabled={false}
            />
            <p className="text-xs text-muted-foreground">
              {phase === "BEFORE"
                ? "JPEG / PNG / WebP up to 15 MB."
                : "JPEG / PNG / WebP up to 15 MB · MP4 / MOV / WebM up to 50 MB."}
            </p>
          </div>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
        ) : phaseItems.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {isAfter ? "No completion evidence yet." : isDuring ? "No during-work evidence yet." : "No before-work evidence yet."}
          </p>
        ) : (
          <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3">
            {phaseItems.map((m, idx) => (
              <li key={m.id} className="group relative overflow-hidden rounded-lg border bg-muted/30">
                <button
                  type="button"
                  onClick={() => openPreview(phase, idx)}
                  className="block w-full aspect-square cursor-zoom-in"
                  title={`Preview ${m.name}`}
                  aria-label={`Preview ${m.name}`}
                >
                  {isImage(m.mimeType) ? (
                    <img src={fileUrl(m)} alt={m.name} loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
                      <FileVideo className="h-8 w-8" aria-hidden />
                      <span className="text-[10px] font-mono uppercase">{m.mimeType.split("/")[1]}</span>
                    </span>
                  )}
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                    {m.source === "COMPLAINT" ? "COMPLAINT" : m.label}
                  </span>
                </button>
                <div className="space-y-0.5 border-t p-2">
                  <p className="truncate text-xs font-medium" title={m.name}>{m.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {m.uploadedByName ?? "Unknown"} · {fmtDateTime(m.createdAt)} · {Math.round(m.sizeBytes / 1024)} KB
                  </p>
                  <div className="flex items-center gap-1 pt-0.5">
                    <button
                      type="button"
                      onClick={() => openPreview(phase, idx)}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={`Preview ${m.name}`}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <a
                      href={`${fileUrl(m)}?download=1`}
                      download={m.name}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      aria-label={`Download ${m.name}`}
                      title="Download"
                    >
                      <Image className="h-3.5 w-3.5" aria-hidden />
                    </a>
                    {m.source === "WORK_ORDER" && canUpload && uploadEnabled ? (
                      <button
                        type="button"
                        onClick={() => void removePhoto(phase, m)}
                        className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Delete ${m.name}`}
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : m.source === "COMPLAINT" ? (
                      <span className="rounded p-1 text-muted-foreground" title="Imported from complaint — read-only" aria-label="Read-only">
                        <Lock className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {phase === "AFTER" && phaseItems.length === 0 && uploadEnabled && canUpload && (
          <p className="flex items-center gap-1.5 text-xs text-destructive bg-destructive/5 rounded-lg px-3 py-2">
            <Image className="h-3 w-3" aria-hidden />
            Completion evidence required — at least one photo or video before this work order can be closed.
          </p>
        )}
      </div>
    );
  };

  const afterCount = items.AFTER.length;
  const afterRequiredMissing = workOrderStatus === "COMPLETED" && afterCount === 0;

  return (
    <div className="space-y-4">
      {/* ── BEFORE WORK — read-only, imported from complaint ── */}
      <section aria-label="Before Work evidence">
        {renderGallery("BEFORE", canUploadPhase("BEFORE", workOrderStatus, canManageBefore))}
        {!complaintId && (
          <p className="text-xs text-muted-foreground">No originating complaint — before-work evidence is uploaded directly to this work order.</p>
        )}
      </section>

      {/* ── DURING WORK ── */}
      <section aria-label="During Work evidence">
        {renderGallery("DURING", canUploadPhase("DURING", workOrderStatus, canManageBefore))}
      </section>

      {/* ── AFTER WORK ── */}
      <section aria-label="After Work evidence">
        {renderGallery("AFTER", canUploadPhase("AFTER", workOrderStatus, canManageBefore))}
        {afterRequiredMissing && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            <p className="font-semibold mb-1">Closure blocked</p>
            <p>At least one After Work photo or video is required before this work order can be closed.</p>
          </div>
        )}
      </section>

      {/* Preview lightbox */}
      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" role="dialog" aria-modal="true" aria-label={preview.item.name}>
          <button
            type="button"
            onClick={() => setPreview(null)}
            aria-label="Close preview"
            className="absolute right-3 top-3 z-10 rounded-full bg-black/60 p-2 text-white hover:bg-black/80"
          >
            <Image className="h-4 w-4" />
          </button>
          <div className="relative max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-background shadow-2xl">
            <div className="flex items-center justify-center bg-black/90 p-3 max-h-[calc(90vh-6.5rem)] overflow-auto">
              {isImage(preview.item.mimeType) ? (
                <img src={fileUrl(preview.item)} alt={preview.item.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <video src={fileUrl(preview.item)} controls playsInline className="max-h-full max-w-full" />
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-foreground">{preview.item.name}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span>{preview.item.label}</span>·<span>{fmtDateTime(preview.item.createdAt)}</span>·<span>by {preview.item.uploadedByName ?? "Unknown"}</span>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
