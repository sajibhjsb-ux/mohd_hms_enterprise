"use client";

// MOHD.HMS ENTERPRISE — IRMS professional photo system (spec §11-§18).
//
// Features: upload dropzone (drag / browse / paste / camera capture), per-file
// upload queue with real progress + retry + cancel (AbortController) capped at
// 3 parallel requests, category tabs with counts, drag-to-reorder WITHIN a
// category (@dnd-kit/sortable + keyboard Move up/down buttons §55) persisted
// via photos/reorder, multi-select bulk toolbar (delete / move / rotate /
// set room / set swRef / download), and a lightbox Dialog with metadata panel,
// inline metadata editing and the non-destructive annotation editor (§16).
// Honest states everywhere — toasts only on real server responses (§67).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { RT } from "@/lib/hms/realtime/matrix";
import { humanize, IRMS_PHOTO_CATEGORIES, IRMS_PHOTO_PREFIX } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Camera, CheckCheck, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download, GripVertical,
  ImagePlus, Loader2, Paperclip, RotateCw, Save, Trash2, UploadCloud, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IrmsAnnotationEditor, IrmsAnnotationOverlay, parseIrmsAnnotation } from "./irms-annotation";

// ── Types ──

export type IrmsPhoto = {
  id: string;
  category: string;
  photoNo: string;
  sortOrder: number;
  caption: string | null;
  swRef: string | null;
  room: string | null;
  building: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  mimeType: string | null;
  cameraModel: string | null;
  takenAt: string | null;
  rotation: number;
  annotation: string | null;
  urls: { thumb: string; display: string; original: string };
};

type UploadStatus = "queued" | "uploading" | "done" | "error" | "canceled";
type UploadItem = { key: string; file: File; progress: number; status: UploadStatus; error?: string };

const MAX_PARALLEL = 3;
const ALL = "ALL";

function uid(): string {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function humanSize(bytes: number | null | undefined): string {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Upload one file with real progress via XHR (respects AbortSignal). */
function uploadFile(url: string, file: File, category: string, onProgress: (pct: number) => void, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve(null); }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (body?.error?.message) msg = body.error.message;
        } catch { /* non-JSON */ }
        reject(new ClientApiError(msg, "UPLOAD_FAILED", xhr.status));
      }
    };
    xhr.onerror = () => reject(new ClientApiError("Network error during upload.", "NETWORK", 0));
    xhr.onabort = () => reject(new DOMException("Upload canceled", "AbortError"));
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const form = new FormData();
    form.set("files", file);
    form.set("category", category);
    xhr.send(form);
  });
}

// ── Sortable thumbnail ──

function SortableThumb({
  photo, index, total, editable, selected, onToggle, onOpen, onMove,
}: {
  photo: IrmsPhoto;
  index: number;
  total: number;
  editable: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: photo.id, disabled: !editable });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "group relative rounded-lg border bg-card p-1.5 transition-shadow",
        isDragging ? "z-10 opacity-80 shadow-lg ring-2 ring-primary/50" : "hover:shadow-sm",
        selected && "ring-2 ring-primary",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open photo ${photo.photoNo}${photo.caption ? ` — ${photo.caption}` : ""}`}
      >
        { }
        <img src={photo.urls.thumb} alt={photo.caption || `Photo ${photo.photoNo}`} className="aspect-square w-full rounded-md object-cover" loading="lazy" draggable={false} />
      </button>

      {editable ? (
        <div className="absolute left-2 top-2">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggle()}
            aria-label={`Select photo ${photo.photoNo}`}
            className="bg-background/90 shadow"
          />
        </div>
      ) : null}

      <span className="absolute right-2 top-2 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums">
        {photo.photoNo}
      </span>

      {photo.caption ? (
        <p className="mt-1 truncate px-0.5 text-xs text-muted-foreground" title={photo.caption}>{photo.caption}</p>
      ) : (
        <p className="mt-1 px-0.5 text-xs text-muted-foreground/60">{humanize(photo.category)}</p>
      )}

      {editable ? (
        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Drag to reorder ${photo.photoNo}`}
            className="inline-flex h-7 w-7 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label={`Move ${photo.photoNo} earlier`}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              aria-label={`Move ${photo.photoNo} later`}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Main component ──

export function IrmsPhotoManager({
  reportId,
  editable,
  canManage,
}: {
  reportId: string;
  /** Report allows photo mutations (status + permission already resolved by the parent). */
  editable: boolean;
  /** User has irms.manage (extra bulk authority for review-active reports). */
  canManage: boolean;
}) {
  const { toast } = useToast();

  const [photos, setPhotos] = useState<IrmsPhoto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<string>(ALL);
  const [uploadCategory, setUploadCategory] = useState<string>("BEFORE");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [selection, setSelected] = useState<Set<string>>(new Set());
  const [orderState, setOrderState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkDialog, setBulkDialog] = useState<"room" | "swRef" | null>(null);
  const [bulkValue, setBulkValue] = useState("");
  const [movingIds, setMovingIds] = useState(false);
  const [moveTo, setMoveTo] = useState<string>("");

  const browseRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const abortsRef = useRef<Map<string, AbortController>>(new Map());

  // ── Load ──
  const load = useCallback(async () => {
    try {
      const res = await api.get<IrmsPhoto[]>(`/api/v1/irms/reports/${reportId}/photos`);
      setPhotos(res.data ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load photos.");
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: photo mutations from other sessions refresh this view (pageDirty-safe).
  useRealtimeEvent([RT.IRMS_PHOTOS_UPDATED], () => { void load(); });

  // Canonical display order: category (canonical order) → sortOrder.
  const sortedPhotos = useMemo(() => {
    const list = photos ?? [];
    const catIdx = (c: string) => {
      const i = IRMS_PHOTO_CATEGORIES.indexOf(c as (typeof IRMS_PHOTO_CATEGORIES)[number]);
      return i === -1 ? IRMS_PHOTO_CATEGORIES.length : i;
    };
    return [...list].sort((a, b) => catIdx(a.category) - catIdx(b.category) || a.sortOrder - b.sortOrder);
  }, [photos]);

  const visible = useMemo(
    () => (activeTab === ALL ? sortedPhotos : sortedPhotos.filter((p) => p.category === activeTab)),
    [sortedPhotos, activeTab],
  );

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of sortedPhotos) map.set(p.category, (map.get(p.category) ?? 0) + 1);
    return map;
  }, [sortedPhotos]);

  // ── Upload queue (max 3 parallel) ──
  const addFiles = useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setUploads((prev) => [
      ...prev,
      ...images.map((f) => ({ key: uid(), file: f, progress: 0, status: "queued" as const })),
    ]);
  }, []);

  useEffect(() => {
    const running = uploads.filter((u) => u.status === "uploading").length;
    const queued = uploads.filter((u) => u.status === "queued");
    const slots = MAX_PARALLEL - running;
    if (queued.length === 0 || slots <= 0) return;
    for (const item of queued.slice(0, slots)) {
      setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: "uploading" } : u)));
      const ac = new AbortController();
      abortsRef.current.set(item.key, ac);
      uploadFile(`/api/v1/irms/reports/${reportId}/photos`, item.file, uploadCategory, (pct) => {
        setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, progress: pct } : u)));
      }, ac.signal)
        .then(() => {
          setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: "done", progress: 100 } : u)));
          void load();
        })
        .catch((e) => {
          if (e instanceof DOMException && e.name === "AbortError") {
            setUploads((prev) => prev.filter((u) => u.key !== item.key));
          } else {
            setUploads((prev) => prev.map((u) => (u.key === item.key ? { ...u, status: "error", error: e instanceof Error ? e.message : "Upload failed" } : u)));
          }
        })
        .finally(() => abortsRef.current.delete(item.key));
    }
  }, [uploads, reportId, uploadCategory, load]);

  // Paste-upload (clipboard images) — §11.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!editable) return;
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
        toast({ title: `${files.length} image${files.length > 1 ? "s" : ""} pasted`, description: "Uploading to the selected category…" });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles, editable, toast]);

  const cancelUpload = (key: string) => {
    abortsRef.current.get(key)?.abort();
    setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, status: "canceled" } : u)));
    setTimeout(() => setUploads((prev) => prev.filter((u) => u.key !== key)), 1200);
  };

  // ── Reorder (drag or keyboard) — persists the FULL ordered id list ──
  const persistOrder = useCallback(async (nextOrder: IrmsPhoto[]) => {
    setPhotos(nextOrder.map((p) => ({ ...p })));
    setOrderState("saving");
    try {
      await api.post(`/api/v1/irms/reports/${reportId}/photos/reorder`, { ids: nextOrder.map((p) => p.id) });
      setOrderState("saved");
      setTimeout(() => setOrderState("idle"), 2500);
    } catch (e) {
      setOrderState("error");
      toast({ title: "Could not save the new order", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      await load();
      setTimeout(() => setOrderState("idle"), 2500);
    }
  }, [reportId, toast, load]);

  const moveWithinCategory = useCallback((photoId: string, dir: -1 | 1) => {
    // Keyboard-accessible reorder (§55): rearrange within the active view,
    // keep every other photo's relative order, then persist the full id list.
    const ids = visible.map((p) => p.id);
    const idx = ids.indexOf(photoId);
    const swapWith = idx + dir;
    if (idx === -1 || swapWith < 0 || swapWith >= ids.length) return;
    const newIds = arrayMove(ids, idx, swapWith);
    const order: IrmsPhoto[] = [];
    let ci = 0;
    for (const p of sortedPhotos) {
      if (ids.includes(p.id)) order.push(sortedPhotos.find((q) => q.id === newIds[ci++])!);
      else order.push(p);
    }
    void persistOrder(order);
  }, [sortedPhotos, visible, persistOrder]);

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const idsInCat = visible.map((p) => p.id);
    const oldIdx = idsInCat.indexOf(String(active.id));
    const newIdx = idsInCat.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const newCatIds = arrayMove(idsInCat, oldIdx, newIdx);
    const order: IrmsPhoto[] = [];
    let ci = 0;
    for (const p of sortedPhotos) {
      if (idsInCat.includes(p.id)) order.push(sortedPhotos.find((q) => q.id === newCatIds[ci++])!);
      else order.push(p);
    }
    void persistOrder(order);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Bulk operations ──
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const runBulk = async (action: "delete" | "moveCategory" | "rotate" | "setRoom" | "setSwRef", value?: string) => {
    const photoIds = Array.from(selection);
    if (photoIds.length === 0) return;
    setMovingIds(true);
    try {
      await api.post(`/api/v1/irms/reports/${reportId}/photos/bulk`, { action, photoIds, value });
      toast({
        title:
          action === "delete" ? `${photoIds.length} photo${photoIds.length > 1 ? "s" : ""} deleted`
          : action === "moveCategory" ? `Moved to ${humanize(value ?? "")}`
          : action === "rotate" ? `Rotated ${photoIds.length} photo${photoIds.length > 1 ? "s" : ""}`
          : `${action === "setRoom" ? "Room" : "SW reference"} updated`,
      });
      clearSelection();
      await load();
    } catch (e) {
      toast({ title: "Bulk action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setMovingIds(false);
      setBulkDialog(null);
      setBulkValue("");
      setMoveTo("");
    }
  };

  const downloadSelected = () => {
    const items = visible.filter((p) => selection.has(p.id));
    items.forEach((p, i) => {
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = p.urls.original;
        a.download = `${p.photoNo}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, i * 450);
    });
  };

  // ── Lightbox metadata editing ──
  const lightboxPhoto = lightboxIdx !== null ? visible[lightboxIdx] ?? null : null;

  const patchPhoto = async (id: string, patch: Record<string, unknown>) => {
    const res = await api.patch<IrmsPhoto>(`/api/v1/irms/photos/${id}`, patch);
    await load();
    return res.data;
  };

  // ── Render ──

  if (loading && photos === null) {
    return <LoadingState label="Loading photos…" rows={3} />;
  }
  if (loadError && photos === null) {
    return <ErrorState message={loadError} onRetry={() => void load()} />;
  }

  const activeUploads = uploads.length;

  return (
    <div className="space-y-4">
      {/* Upload zone */}
      {editable ? (
        <div className="space-y-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              addFiles(Array.from(e.dataTransfer.files ?? []));
            }}
            className={cn(
              "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-5 text-center transition-colors",
              dragOver ? "border-primary bg-primary/5" : "border-border bg-muted/30",
            )}
          >
            <UploadCloud className="h-7 w-7 text-primary" aria-hidden />
            <p className="text-sm font-medium">Drop photos here, paste from clipboard, or browse</p>
            <p className="text-xs text-muted-foreground">JPEG / PNG / WebP · up to 15 MB each · originals are never altered</p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => browseRef.current?.click()}>
                <ImagePlus className="h-4 w-4 mr-1.5" /> Browse files
              </Button>
              <Button type="button" variant="outline" size="sm" className="min-h-[44px] sm:hidden" onClick={() => cameraRef.current?.click()}>
                <Camera className="h-4 w-4 mr-1.5" /> Camera
              </Button>
              <div className="flex items-center gap-2">
                <Label htmlFor="upload-category" className="text-xs text-muted-foreground">Category</Label>
                <Select value={uploadCategory} onValueChange={setUploadCategory}>
                  <SelectTrigger id="upload-category" className="h-9 w-[190px]" aria-label="Upload category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IRMS_PHOTO_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <input
              ref={browseRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
            <input
              ref={cameraRef} type="file" accept="image/*" capture="environment" hidden
              onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
            />
          </div>

          {/* Upload queue */}
          {activeUploads > 0 ? (
            <ul className="space-y-2" aria-label="Upload progress">
              {uploads.map((u) => (
                <li key={u.key} className="rounded-lg border bg-card p-2.5">
                  <div className="flex items-center gap-2">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm" title={u.file.name}>{u.file.name}</span>
                    {u.status === "uploading" ? <span className="text-xs tabular-nums text-muted-foreground">{u.progress}%</span> : null}
                    {u.status === "queued" ? <span className="text-xs text-muted-foreground">Queued…</span> : null}
                    {u.status === "done" ? <CheckCheck className="h-4 w-4 text-emerald-600" aria-label="Uploaded" /> : null}
                    {u.status === "error" ? <X className="h-4 w-4 text-red-600" aria-label="Upload failed" /> : null}
                    {u.status === "canceled" ? <span className="text-xs text-muted-foreground">Canceled</span> : null}
                    {(u.status === "queued" || u.status === "uploading") ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => cancelUpload(u.key)} aria-label={`Cancel upload ${u.file.name}`}>
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                    {u.status === "error" ? (
                      <Button
                        type="button" variant="outline" size="sm"
                        onClick={() => setUploads((prev) => prev.map((x) => (x.key === u.key ? { ...x, status: "queued", progress: 0, error: undefined } : x)))}
                        aria-label={`Retry upload ${u.file.name}`}
                      >
                        Retry
                      </Button>
                    ) : null}
                  </div>
                  {u.status === "uploading" ? (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${u.progress}%` }} />
                    </div>
                  ) : null}
                  {u.status === "error" && u.error ? <p className="mt-1 text-xs text-destructive">{u.error}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Category tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto -mx-1 px-1 pb-1">
          <TabsList className="h-auto w-max min-w-full justify-start gap-1">
            <TabsTrigger value={ALL} className="min-h-[36px]">
              All <span className="ml-1 text-xs text-muted-foreground">{sortedPhotos.length}</span>
            </TabsTrigger>
            {IRMS_PHOTO_CATEGORIES.map((c) => (
              <TabsTrigger key={c} value={c} className="min-h-[36px]">
                {humanize(c)} <span className="ml-1 text-xs text-muted-foreground">{counts.get(c) ?? 0}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      {/* Order state + bulk toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        {editable && sortedPhotos.length > 1 ? (
          <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
            {orderState === "saving" ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Saving order…</span>
              : orderState === "saved" ? <span className="text-emerald-700">Order saved</span>
              : orderState === "error" ? <span className="text-destructive">Order not saved — restored from server</span>
              : "Drag thumbnails (or use ↑/↓) to set the order within a category."}
          </span>
        ) : <span className="text-xs text-muted-foreground">{sortedPhotos.length} photo{sortedPhotos.length === 1 ? "" : "s"} · tap a photo to view details</span>}

        {selection.size > 0 ? (
          <TooltipProvider delayDuration={200}>
            <div className="ml-auto flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-1.5">
              <span className="px-1 text-xs font-medium">{selection.size} selected</span>
              <Button type="button" variant="ghost" size="sm" onClick={clearSelection} aria-label="Clear selection">
                <X className="h-4 w-4" />
              </Button>
              {editable || canManage ? (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirmDelete(true)} aria-label="Delete selected photos">
                    <Trash2 className="h-4 w-4 text-red-600" /> Delete
                  </Button>
                  <Select value={moveTo} onValueChange={(c) => { if (c && c !== moveTo) { setMoveTo(c); void runBulk("moveCategory", c); } }} disabled={movingIds}>
                    <SelectTrigger className="h-9 w-[150px]" aria-label="Move selected to category"><SelectValue placeholder="Move to…" /></SelectTrigger>
                    <SelectContent>
                      {IRMS_PHOTO_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" size="sm" disabled={movingIds} onClick={() => void runBulk("rotate", "90")} aria-label="Rotate selected photos 90 degrees">
                    <RotateCw className="h-4 w-4" /> Rotate 90°
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={movingIds} onClick={() => { setBulkValue(""); setBulkDialog("room"); }} aria-label="Set room for selected photos">
                    Set Room
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={movingIds} onClick={() => { setBulkValue(""); setBulkDialog("swRef"); }} aria-label="Set switch reference for selected photos">
                    Set SW ref
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={movingIds} onClick={downloadSelected} aria-label="Download selected photos">
                    <Download className="h-4 w-4" /> Download
                  </Button>
                </>
              ) : null}
            </div>
          </TooltipProvider>
        ) : null}
      </div>

      {/* Grid */}
      {sortedPhotos.length === 0 ? (
        <EmptyState
          title="No photos yet"
          hint={editable ? "Upload site photos, drag & drop, paste screenshots or capture from the camera." : "Photos added by the inspector will appear here."}
        />
      ) : visible.length === 0 ? (
        <EmptyState title={`No ${humanize(activeTab).toLowerCase()} photos`} hint="Choose another category or upload photos to it." />
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((p) => p.id)} strategy={rectSortingStrategy} disabled={!editable}>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {visible.map((p, i) => (
                <SortableThumb
                  key={p.id}
                  photo={p}
                  index={i}
                  total={visible.length}
                  editable={editable}
                  selected={selection.has(p.id)}
                  onToggle={() => toggleSelect(p.id)}
                  onOpen={() => setLightboxIdx(i)}
                  onMove={(dir) => void moveWithinCategory(p.id, dir)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Bulk delete confirm */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selection.size} photo{selection.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Photo files are removed permanently and numbering is regenerated. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setConfirmDelete(false); void runBulk("delete"); }}
            >
              Delete photos
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Set room / SW ref dialog */}
      <Dialog open={bulkDialog !== null} onOpenChange={(open) => { if (!open) setBulkDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{bulkDialog === "room" ? "Set room" : "Set switch (SW) reference"}</DialogTitle>
            <DialogDescription>Applied to {selection.size} selected photo{selection.size === 1 ? "" : "s"}.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
            placeholder={bulkDialog === "room" ? "e.g. Level 3 — Server Room" : "e.g. SW-DB-02"}
            aria-label={bulkDialog === "room" ? "Room" : "Switch reference"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialog(null)}>Cancel</Button>
            <Button disabled={!bulkValue.trim() || movingIds} onClick={() => void runBulk(bulkDialog === "room" ? "setRoom" : "setSwRef", bulkValue.trim())}>
              {movingIds ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lightbox */}
      <Dialog open={lightboxPhoto !== null} onOpenChange={(open) => { if (!open) setLightboxIdx(null); }}>
        {lightboxPhoto ? (
          <LightboxContent
            key={lightboxPhoto.id}
            photo={lightboxPhoto}
            editable={editable}
            hasPrev={(lightboxIdx ?? 0) > 0}
            hasNext={(lightboxIdx ?? 0) < visible.length - 1}
            onPrev={() => setLightboxIdx((i) => (i !== null && i > 0 ? i - 1 : i))}
            onNext={() => setLightboxIdx((i) => (i !== null && i < visible.length - 1 ? i + 1 : i))}
            onClose={() => setLightboxIdx(null)}
            onPatched={() => void load()}
            patchPhoto={patchPhoto}
            position={`${(lightboxIdx ?? 0) + 1} / ${visible.length}`}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

// ── Lightbox (separate component so state resets per photo) ──

function LightboxContent({
  photo, editable, hasPrev, hasNext, onPrev, onNext, onClose, onPatched, patchPhoto, position,
}: {
  photo: IrmsPhoto;
  editable: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onPatched: () => void;
  patchPhoto: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  position: string;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"info" | "annotate">("info");
  const [meta, setMeta] = useState({
    caption: photo.caption ?? "",
    swRef: photo.swRef ?? "",
    room: photo.room ?? "",
    building: photo.building ?? "",
    category: photo.category,
  });
  const [savingMeta, setSavingMeta] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && hasPrev) onPrev();
      if (e.key === "ArrowRight" && hasNext) onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasPrev, hasNext, onPrev, onNext]);

  const saveMeta = async () => {
    setSavingMeta(true);
    try {
      await patchPhoto(photo.id, {
        caption: meta.caption.trim() || null,
        swRef: meta.swRef.trim() || null,
        room: meta.room.trim() || null,
        building: meta.building.trim() || null,
        category: meta.category,
      });
      toast({ title: `Photo ${photo.photoNo} updated` });
      onPatched();
    } catch (e) {
      toast({ title: "Could not update photo", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingMeta(false);
    }
  };

  const saveAnnotation = async (shapes: unknown[]) => {
    await patchPhoto(photo.id, { annotation: JSON.stringify(shapes) });
    toast({ title: `Annotation saved for ${photo.photoNo}` });
    onPatched();
  };

  return (
    <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto sm:max-w-5xl" onKeyDown={(e) => { if (e.key === "ArrowLeft" && hasPrev) onPrev(); if (e.key === "ArrowRight" && hasNext) onNext(); }}>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2 pr-8">
          {photo.photoNo} · {humanize(photo.category)}
          <span className="text-xs font-normal text-muted-foreground">{position}</span>
        </DialogTitle>
        <DialogDescription>{photo.caption || "No caption"}</DialogDescription>
      </DialogHeader>

      <div className="relative flex items-center justify-center rounded-lg bg-stone-100 p-2">
        {hasPrev ? (
          <button type="button" onClick={onPrev} aria-label="Previous photo" className="absolute left-2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        <div className="relative inline-block max-w-full">
          { }
          <img src={photo.urls.display} alt={photo.caption || `Photo ${photo.photoNo}`} className="max-h-[52vh] max-w-full rounded-md object-contain" />
          {!editable ? <IrmsAnnotationOverlay annotation={photo.annotation} /> : null}
        </div>
        {hasNext ? (
          <button type="button" onClick={onNext} aria-label="Next photo" className="absolute right-2 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRight className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      {editable ? (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "info" | "annotate")}>
          <div className="overflow-x-auto">
            <TabsList>
              <TabsTrigger value="info">Details</TabsTrigger>
              <TabsTrigger value="annotate">Annotate</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="info" className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`lb-caption-${photo.id}`}>Caption</Label>
                <Input id={`lb-caption-${photo.id}`} value={meta.caption} onChange={(e) => setMeta((m) => ({ ...m, caption: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={meta.category} onValueChange={(c) => setMeta((m) => ({ ...m, category: c }))}>
                  <SelectTrigger aria-label="Photo category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {IRMS_PHOTO_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`lb-sw-${photo.id}`}>SW reference</Label>
                <Input id={`lb-sw-${photo.id}`} value={meta.swRef} onChange={(e) => setMeta((m) => ({ ...m, swRef: e.target.value }))} placeholder="e.g. SW-DB-02" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`lb-room-${photo.id}`}>Room</Label>
                <Input id={`lb-room-${photo.id}`} value={meta.room} onChange={(e) => setMeta((m) => ({ ...m, room: e.target.value }))} placeholder="e.g. Level 3 — Server Room" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`lb-bld-${photo.id}`}>Building</Label>
                <Input id={`lb-bld-${photo.id}`} value={meta.building} onChange={(e) => setMeta((m) => ({ ...m, building: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Prefix</Label>
                <p className="text-sm text-muted-foreground">{IRMS_PHOTO_PREFIX[meta.category] ?? "—"}### numbering (managed by the server)</p>
              </div>
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void saveMeta()} disabled={savingMeta}>
                {savingMeta ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
                {savingMeta ? "Saving…" : "Save details"}
              </Button>
            </div>
            <MetadataPanel photo={photo} />
          </TabsContent>

          <TabsContent value="annotate">
            <IrmsAnnotationEditor
              key={photo.id}
              src={photo.urls.display}
              alt={photo.caption || `Photo ${photo.photoNo}`}
              annotation={photo.annotation}
              onSave={(shapes) => saveAnnotation(shapes)}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <>
          <MetadataPanel photo={photo} />
          {parseIrmsAnnotation(photo.annotation).length > 0 ? (
            <p className="text-xs text-muted-foreground">This photo carries {parseIrmsAnnotation(photo.annotation).length} annotation(s) — shown overlaid on the image above.</p>
          ) : null}
        </>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
      </div>
    </DialogContent>
  );
}

function MetadataPanel({ photo }: { photo: IrmsPhoto }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/20 p-3 text-sm sm:grid-cols-3">
      <Meta label="Captured" value={fmtDateTime(photo.takenAt)} />
      <Meta label="Camera" value={photo.cameraModel || "—"} />
      <Meta label="Dimensions" value={photo.width && photo.height ? `${photo.width} × ${photo.height}px` : "—"} />
      <Meta label="File size" value={humanSize(photo.sizeBytes)} />
      <Meta label="Room" value={photo.room || "—"} />
      <Meta label="SW ref" value={photo.swRef || "—"} />
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium">{value}</div>
    </div>
  );
}
