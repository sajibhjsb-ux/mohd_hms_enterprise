"use client";

// MOHD.HMS ENTERPRISE — "Attach from Files" dialog (§20 — Files integration).
//
// READ-ONLY picker over the existing Files list API:
//   • browsing: GET /api/v1/files?view=mine[&folderId=…] → { breadcrumb, folders, files }
//   • search:   GET /api/v1/files?view=search&q=…       → { files, folders }
// The picker NEVER creates, renames or deletes anything — attaching copies a
// reference (fileId) that the backend re-authorizes object-level on save.

import { useEffect, useState } from "react";
import { ChevronRight, FileText, Folder as FolderIcon, Loader2, Search } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type PickerFile = { id: string; name: string; sizeBytes: number; mimeType: string };

type FolderLite = { id: string; name: string };
type Crumb = { id: string; name: string };

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FilesPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (file: PickerFile) => void;
}) {
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>([]);
  const [folders, setFolders] = useState<FolderLite[]>([]);
  const [files, setFiles] = useState<PickerFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced search → committed query (browsing resets to the root).
  useEffect(() => {
    const t = setTimeout(() => {
      const next = searchText.trim();
      setQ(next);
      if (next) setFolderId(null);
    }, 350);
    return () => clearTimeout(t);
  }, [searchText]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        if (q) {
          const res = await api.get<{ files: PickerFile[] }>(
            `/api/v1/files?view=search&q=${encodeURIComponent(q)}`
          );
          if (cancelled) return;
          setFiles(res.data.files ?? []);
          setFolders([]);
          setBreadcrumb([]);
        } else {
          const res = await api.get<{
            breadcrumb?: Crumb[];
            folders?: FolderLite[];
            files: PickerFile[];
          }>(`/api/v1/files?view=mine${folderId ? `&folderId=${encodeURIComponent(folderId)}` : ""}`);
          if (cancelled) return;
          setFiles(res.data.files ?? []);
          setFolders(res.data.folders ?? []);
          setBreadcrumb(res.data.breadcrumb ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Unable to load your files.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, q, folderId]);

  const reset = () => {
    setSearchText("");
    setQ("");
    setFolderId(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Attach from Files</DialogTitle>
          <DialogDescription>
            Pick one of your Files — the original stays in your Files space and the backend
            re-checks your access when the email is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search your files…"
            aria-label="Search files"
            className="h-9 pl-8"
          />
        </div>

        {/* Breadcrumbs while browsing (search mode is a flat result list) */}
        {!q && breadcrumb.length > 0 ? (
          <nav aria-label="Folder path" className="flex flex-wrap items-center gap-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFolderId(null)}
              className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              My Files
            </button>
            {breadcrumb.map((c, i) => (
              <span key={c.id} className="flex items-center">
                <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden />
                {i === breadcrumb.length - 1 ? (
                  <span className="px-1.5 py-1 font-medium">{c.name}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setFolderId(c.id)}
                    className="rounded px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {c.name}
                  </button>
                )}
              </span>
            ))}
          </nav>
        ) : null}

        <div
          className="max-h-[320px] min-h-[160px] overflow-y-auto rounded-md border"
          role="list"
          aria-label="Files"
        >
          {loading ? (
            <div className="space-y-2 p-3" role="status" aria-label="Loading files">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : (
            <>
              {/* Subfolders (browse mode only) */}
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="listitem"
                  onClick={() => setFolderId(f.id)}
                  className="flex w-full items-center gap-2 border-b px-3 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <FolderIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              ))}

              {files.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="listitem"
                  onClick={() => {
                    onSelect({ id: f.id, name: f.name, sizeBytes: f.sizeBytes, mimeType: f.mimeType });
                    onOpenChange(false);
                    reset();
                  }}
                  aria-label={`Attach ${f.name} (${fmtBytes(f.sizeBytes)})`}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    folders.length > 0 && "border-b"
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{fmtBytes(f.sizeBytes)}</span>
                </button>
              ))}

              {folders.length === 0 && files.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                  <FolderIcon className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                  <p className="mt-2 text-sm font-medium">{q ? "No matching files" : "No files yet"}</p>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                    {q
                      ? "Try a different search term."
                      : "Upload documents in the Files module, then attach them here."}
                  </p>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {files.length} file{files.length === 1 ? "" : "s"}
            {q ? " found" : " in this folder"}
          </span>
          <Button variant="ghost" size="sm" className="h-8" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
