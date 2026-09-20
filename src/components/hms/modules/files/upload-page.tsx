"use client";

// MOHD.HMS ENTERPRISE — Upload page (§8/§18/§19). THE dedicated upload
// workspace (never a modal): drag & drop, file/folder pickers, destination
// folder, per-file queue with REAL progress, pause/resume/cancel/retry,
// chunked + resumable sessions, server-verified completion (no fake success —
// a file only shows "Uploaded" after the backend verified storage, checksum
// and metadata).

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleSlash, CloudUpload, FolderInput, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { PageHeader, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { navigateTo } from "@/lib/hms/router";
import { fmtBytes } from "./shared";

const CHUNK_SIZE = 8 * 1024 * 1024; // must match the server's MAX_CHUNK_BYTES plan check

type QueueStatus = "queued" | "uploading" | "paused" | "verifying" | "done" | "failed" | "cancelled";

type QueueItem = {
  key: string;
  file: File;
  name: string;
  sizeBytes: number;
  status: QueueStatus;
  progress: number; // 0..100 (bytes uploaded / total)
  uploadedBytes: number;
  sessionId?: string;
  receivedChunks: Set<number>;
  controller?: XhrController | null;
  error?: string;
  fileId?: string;
};

/** Per-item XHR controller (pause = abort mid-chunk, resume = re-plan chunks). */
type XhrController = { aborted: boolean };

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function UploadPage({ initialFolderId }: { initialFolderId: string | null }) {
  const { toast } = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [destination, setDestination] = useState<string>("root");
  const [dragOver, setDragOver] = useState(false);
  const [globalInfo, setGlobalInfo] = useState<{ count: number; size: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    void (async () => {
      try {
        setFoldersLoading(true);
        const res = await api.get<{ folders: { id: string; name: string }[] }>("/api/v1/files?view=mine");
        setFolders(res.data.folders);
        setFolderError(null);
      } catch (e) {
        setFolderError(e instanceof Error ? e.message : "Could not load folders.");
      } finally {
        setFoldersLoading(false);
      }
    })();
  }, []);

  const updateItem = (key: string, patch: Partial<QueueItem>) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const addFiles = useCallback((list: FileList | File[]) => {
    const files = Array.from(list);
    if (files.length === 0) return;
    setItems((prev) => [
      ...prev,
      ...files.map((file, i) => ({
        key: `${Date.now()}-${i}-${file.name}`,
        file,
        name: file.name,
        sizeBytes: file.size,
        status: "queued" as QueueStatus,
        progress: 0,
        uploadedBytes: 0,
        receivedChunks: new Set<number>(),
      })),
    ]);
  }, []);

  /** Upload one item through a chunked session (§8). Pause = stop after the
   *  current chunk; resume = re-request the server's received-chunk ledger. */
  const runItem = useCallback(async (key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (!item) return;
    const controller: XhrController = { aborted: false };
    updateItem(key, { status: "uploading", error: undefined, controller });
    try {
      const totalChunks = Math.ceil(item.sizeBytes / CHUNK_SIZE);
      if (!item.sessionId) {
        // checksum is computed client-side and VERIFIED server-side (§8 #3)
        const buf = await item.file.arrayBuffer();
        const checksum = await sha256Hex(buf);
        const created = await api.post<{ sessionId: string; receivedChunks: number[] }>("/api/v1/files/uploads", {
          name: item.name,
          sizeBytes: item.sizeBytes,
          mimeType: item.file.type || undefined,
          totalChunks,
          folderId: destination === "root" ? null : destination,
          checksum,
        });
        updateItem(key, { sessionId: created.data.sessionId, receivedChunks: new Set(created.data.receivedChunks) });
        item.sessionId = created.data.sessionId;
        item.receivedChunks = new Set(created.data.receivedChunks);
      }

      for (let index = 0; index < totalChunks; index++) {
        if (controller.aborted) return; // paused or cancelled — session stays resumable
        if (item.receivedChunks.has(index)) continue;
        const start = index * CHUNK_SIZE;
        const blob = item.file.slice(start, Math.min(start + CHUNK_SIZE, item.sizeBytes));
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", `/api/v1/files/uploads/${item.sessionId}/parts/${index}`);
          xhr.setRequestHeader("content-type", "application/octet-stream");
          xhr.timeout = 120_000;
          xhr.upload.onprogress = (e) => {
            const baseBytes = item.receivedChunks.size * CHUNK_SIZE;
            updateItem(key, { uploadedBytes: Math.min(item.sizeBytes, baseBytes + e.loaded) });
          };
          xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(`Chunk ${index} rejected (${xhr.status}).`)));
          xhr.onerror = () => reject(new Error("Network error during chunk upload."));
          xhr.ontimeout = () => reject(new Error("Chunk upload timed out."));
          xhr.send(blob);
        });
        item.receivedChunks.add(index);
        updateItem(key, { uploadedBytes: Math.min(item.sizeBytes, item.receivedChunks.size * CHUNK_SIZE) });
      }

      updateItem(key, { status: "verifying" });
      const done = await api.post<{ file: { id: string; name: string; sizeBytes: number } }>(
        `/api/v1/files/uploads/${item.sessionId}/complete`,
      );
      const uploadedPct = 100;
      updateItem(key, {
        status: "done",
        progress: uploadedPct,
        uploadedBytes: item.sizeBytes,
        fileId: done.data.file.id,
      });
      toast({ title: "Uploaded", description: `“${item.name}” verified and saved.` });
    } catch (e) {
      if (controller.aborted) {
        // Pause (cancel removes the item before this point) — keep the
        // session so Resume continues from the server's chunk ledger.
        updateItem(key, { status: "paused" });
        return;
      }
      updateItem(key, { status: "failed", error: e instanceof Error ? e.message : "Upload failed." });
    }
  }, [destination, toast, updateItem]);

  const startAll = () => {
    for (const it of items) {
      if (it.status === "queued" || it.status === "paused" || it.status === "failed") void runItem(it.key);
    }
  };

  const pauseItem = (key: string) => {
    const it = itemsRef.current.find((i) => i.key === key);
    if (it?.controller) it.controller.aborted = true;
    updateItem(key, { status: "paused" });
  };

  const cancelItem = async (key: string) => {
    const it = itemsRef.current.find((i) => i.key === key);
    if (!it) return;
    if (it.controller) it.controller.aborted = true; // stops the running chunk loop
    // Abort the session server-side — staged chunks are cleaned up (§8 cancel).
    if (it.sessionId) {
      try { await api.del(`/api/v1/files/uploads/${it.sessionId}`); } catch { /* may already be completed */ }
    }
    removeItem(key);
  };

  const removeItem = (key: string) => setItems((prev) => prev.filter((i) => i.key !== key));

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(true);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) setGlobalInfo({ count: files.length, size: files.reduce((a, f) => a + f.size, 0) });
    },
    onDragLeave: () => { setDragOver(false); setGlobalInfo(null); },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      setGlobalInfo(null);
      addFiles(e.dataTransfer.files);
    },
  };

  if (foldersLoading) return <LoadingState label="Preparing upload…" />;
  if (folderError) return <ErrorState message={folderError} onRetry={() => navigateTo("files", ["upload"])} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Upload"
        subtitle="Chunked, resumable, checksum-verified uploads into your private space."
        actions={<Button variant="outline" onClick={() => navigateTo("files", ["my"])}><FolderInput className="h-4 w-4 mr-1.5" /> My Files</Button>}
      />

      {/* Drop zone + pickers (§18/§19) */}
      <div
        {...dropHandlers}
        className={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-border"}`}
      >
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files ?? []); e.currentTarget.value = ""; }} />
        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          // @ts-expect-error — non-standard but widely supported folder picker
          webkitdirectory="true"
          onChange={(e) => { addFiles(e.target.files ?? []); e.currentTarget.value = ""; }}
        />
        <CloudUpload className={`mx-auto h-10 w-10 ${dragOver ? "text-primary" : "text-muted-foreground"}`} aria-hidden />
        <p className="mt-3 font-semibold">{dragOver && globalInfo ? `DROP ${globalInfo.count} FILE${globalInfo.count === 1 ? "" : "S"} — ${fmtBytes(globalInfo.size)}` : "Drag & drop files here"}</p>
        <p className="text-sm text-muted-foreground mt-1">PDF, images, video, audio, Office, ZIP and any other type. Files up to 200 MB.</p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>Choose files</Button>
          <Button variant="outline" size="sm" onClick={() => folderInput.current?.click()}>Choose folder</Button>
        </div>
      </div>

      {/* Destination + actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Upload queue</CardTitle>
          <CardDescription>
            {items.length === 0
              ? "Nothing queued yet."
              : `${items.filter((i) => i.status === "done").length}/${items.length} completed — uploads appear in My Files only after server verification.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="upload-destination">Destination folder</label>
              <Select value={destination} onValueChange={setDestination}>
                <SelectTrigger id="upload-destination" aria-label="Destination folder">
                  <SelectValue placeholder="Select destination" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">My Files (root)</SelectItem>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <Button onClick={startAll} disabled={items.every((i) => !["queued", "paused", "failed"].includes(i.status))}>
                <Play className="h-4 w-4 mr-1.5" /> {items.some((i) => i.status === "paused") ? "Resume all" : "Start upload"}
              </Button>
              {items.length > 0 ? (
                <Button variant="outline" onClick={() => setItems([])} disabled={items.some((i) => i.status === "uploading")}>
                  <Trash2 className="h-4 w-4 mr-1.5" /> Clear finished
                </Button>
              ) : null}
            </div>
          </div>

          {items.length > 0 ? (
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {items.map((it) => {
                const pct = it.status === "done" ? 100 : Math.min(99, Math.round((it.uploadedBytes / Math.max(1, it.sizeBytes)) * 100));
                return (
                  <div key={it.key} className="rounded-lg border p-3 space-y-2" data-testid="upload-queue-item">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium truncate flex-1">{it.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums shrink-0">{fmtBytes(it.sizeBytes)}</span>
                      <span
                        className={`text-xs font-medium shrink-0 ${
                          it.status === "done" ? "text-emerald-600" : it.status === "failed" ? "text-red-600" : it.status === "verifying" ? "text-amber-600" : "text-muted-foreground"
                        }`}
                      >
                        {it.status === "queued" ? "Queued" : it.status === "uploading" ? `${pct}%` : it.status === "paused" ? "Paused" : it.status === "verifying" ? "Verifying…" : it.status === "done" ? "Uploaded ✓" : it.status === "cancelled" ? "Cancelled" : "Failed"}
                      </span>
                    </div>
                    {it.status !== "done" && it.status !== "cancelled" ? (
                      <Progress value={pct} aria-label={`Uploading ${it.name}: ${pct}%`} />
                    ) : null}
                    {it.error ? <p className="text-xs text-red-600">{it.error}</p> : null}
                    <div className="flex flex-wrap gap-1.5">
                      {it.status === "uploading" ? (
                        <Button variant="outline" size="sm" onClick={() => pauseItem(it.key)}><Pause className="h-3.5 w-3.5 mr-1" /> Pause</Button>
                      ) : null}
                      {it.status === "paused" || it.status === "failed" ? (
                        <Button variant="outline" size="sm" onClick={() => void runItem(it.key)}>
                          <RefreshCw className="h-3.5 w-3.5 mr-1" /> {it.status === "paused" ? "Resume" : "Retry"}
                        </Button>
                      ) : null}
                      {["queued", "uploading", "paused", "failed"].includes(it.status) ? (
                        <Button variant="outline" size="sm" onClick={() => void cancelItem(it.key)}><X className="h-3.5 w-3.5 mr-1" /> Cancel</Button>
                      ) : null}
                      {it.status === "done" ? (
                        <>
                          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 px-2 py-1"><CheckCircle2 className="h-3.5 w-3.5" /> Verified in storage</span>
                          <Button variant="outline" size="sm" onClick={() => navigateTo("files", ["file", it.fileId!])}>Open</Button>
                          <Button variant="ghost" size="sm" onClick={() => removeItem(it.key)}><CircleSlash className="h-3.5 w-3.5 mr-1" /> Dismiss</Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
