"use client";

// MOHD.HMS ENTERPRISE — Files list views (§14/§15/§17/§23/§24/§25).
// Shared With Me · Shared Folders · Shared-folder browser · Starred · Trash ·
// Recent · Activity — all server-scoped (view=…), all real data.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronRight, Download, Eye, Home, MoreHorizontal, RotateCcw, Trash2, X,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { navigateTo } from "@/lib/hms/router";
import { fileIcon, folderIcon, fmtBytes, permAtLeast, when, type FileRow, type FolderRow } from "./shared";
import { FilesBackButton } from "./back-button";

function useList<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<T>(url);
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load.");
    } finally {
      setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, loading, error, reload: load };
}

function ListShell({ title, subtitle, url, empty, children }: {
  title: string;
  subtitle: string;
  url: string;
  empty: React.ReactNode;
  children: (data: Record<string, unknown>) => React.ReactNode;
}) {
  const { data, loading, error, reload } = useList<Record<string, unknown>>(url);
  if (loading) return <LoadingState label={`Loading ${title.toLowerCase()}…`} />;
  if (error || !data) return (
    <div className="space-y-4">
      <PageHeader title={title} />
      <ErrorState message={error ?? "Unknown error."} onRetry={() => void reload()} />
    </div>
  );
  const isEmpty = Array.isArray(data.files) && Array.isArray(data.folders)
    ? (data.files as unknown[]).length === 0 && (data.folders as unknown[]).length === 0
    : (Array.isArray(data.recent) || Array.isArray(data.items))
      ? ((data.recent ?? data.items) as unknown[]).length === 0
      : false;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {/* §2 — real history Back with a safe in-module fallback. */}
        <FilesBackButton label="Back" fallback={[]} />
        <PageHeader title={title} subtitle={subtitle} />
      </div>
      {isEmpty ? empty : children(data)}
    </div>
  );
}

const downloadFile = (id: string) => {
  window.open(`/api/v1/files/${id}/content?as=attachment`, "_blank");
};

/** §14 Shared With Me */
export function SharedWithMe() {
  return (
    <ListShell
      title="Shared With Me"
      subtitle="Files other users explicitly shared with you — nothing else is visible."
      url="/api/v1/files?view=shared"
      empty={<EmptyState title="Nothing shared yet" description="When someone shares a file with you it appears here and you get a notification." />}
    >
      {(data) => (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="hidden sm:table-cell">Permission</TableHead>
                <TableHead className="hidden sm:table-cell">Size</TableHead>
                <TableHead className="hidden md:table-cell">Shared</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.files as FileRow[]).map((f) => {
                const Icon = fileIcon(f.name, f.mimeType);
                return (
                  <TableRow key={f.id}>
                    <TableCell>
                      <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["file", f.id])}>
                        <Icon className="h-4 w-4 text-primary" aria-hidden />
                        <span className="font-medium">{f.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.sharedBy?.name ?? f.owner?.name ?? "—"}</TableCell>
                    <TableCell className="hidden sm:table-cell"><Badge variant="outline">{f.permission}</Badge></TableCell>
                    <TableCell className="hidden sm:table-cell tabular-nums">{fmtBytes(f.sizeBytes)}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{when(f.sharedAt)}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{f.expiresAt ? when(f.expiresAt) : "—"}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${f.name}`}><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigateTo("files", ["file", f.id])}><Eye className="h-4 w-4 mr-2" /> Open</DropdownMenuItem>
                          {permAtLeast(f.permission, "DOWNLOAD") ? (
                            <DropdownMenuItem onClick={() => downloadFile(f.id)}><Download className="h-4 w-4 mr-2" /> Download</DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </ListShell>
  );
}

/** §15 Shared Folders */
export function SharedFolders() {
  return (
    <ListShell
      title="Shared Folders"
      subtitle="Folders shared with you — permissions inside follow the granted level."
      url="/api/v1/files?view=shared-folders"
      empty={<EmptyState title="No shared folders" description="Folders shared with you will appear here." />}
    >
      {(data) => (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">Folder</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="hidden sm:table-cell">Permission</TableHead>
                <TableHead className="hidden sm:table-cell">Shared</TableHead>
                <TableHead className="hidden md:table-cell">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.folders as FolderRow[]).map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["sf", f.id])}>
                      <folderIcon className="h-4 w-4 text-primary" aria-hidden />
                      <span className="font-medium">{f.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{f.sharedBy?.name ?? f.owner?.name ?? "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell"><Badge variant="outline">{f.permission}</Badge></TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">{when(f.sharedAt)}</TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">{f.expiresAt ? when(f.expiresAt) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </ListShell>
  );
}

/** §15 — browse inside a shared folder (permission-scoped by the backend). */
export function SharedFolderBrowser({ folderId }: { folderId: string }) {
  return <FilesBrowserShared folderId={folderId} />;
}

function FilesBrowserShared({ folderId }: { folderId: string }) {
  // Reuses the folder GET (authorization-resolved) with shared-mode actions.
  const { toast } = useToast();
  const { data, loading, error, reload } = useList<{
    accessLevel: string; isOwner: boolean; breadcrumb: { id: string; name: string; parentId: string | null }[];
    folders: FolderRow[]; files: FileRow[];
  }>(`/api/v1/files/folders/${folderId}`);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  if (loading) return <LoadingState label="Loading shared folder…" />;
  if (error || !data) return (
    <div className="space-y-4">
      <PageHeader title="Shared folder" />
      <ErrorState message={error ?? "Unable to load this shared folder."} onRetry={() => void reload()} />
    </div>
  );

  const level = data.accessLevel ?? "VIEW";

  const header = (
    <div className="flex items-center gap-2">
      {/* §2 — Back to the Shared Folders list (real history, safe fallback). */}
      <FilesBackButton label="Back" fallback={["shared-folders"]} />
      <PageHeader title="Shared folder" />
    </div>
  );

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast({ title: success });
      await reload();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {header}
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => navigateTo("files", ["shared-folders"])}>
          <Home className="h-3.5 w-3.5" aria-hidden /> Shared Folders
        </Button>
        {data.breadcrumb.map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => navigateTo("files", ["sf", c.id])}>{c.name}</Button>
          </span>
        ))}
      </nav>

      {data.folders.length === 0 && data.files.length === 0 ? (
        <EmptyState title="Empty folder" description="This shared folder has no content." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Size</TableHead>
                <TableHead className="hidden md:table-cell">Modified</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.folders.map((folder) => (
                <TableRow key={folder.id}>
                  <TableCell>
                    <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["sf", folder.id])}>
                      <folderIcon className="h-4 w-4 text-primary" aria-hidden />
                      <span className="font-medium">{folder.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">Folder</TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">{when(folder.updatedAt)}</TableCell>
                  <TableCell />
                </TableRow>
              ))}
              {data.files.map((file) => {
                const Icon = fileIcon(file.name, file.mimeType);
                return (
                  <TableRow key={file.id}>
                    <TableCell>
                      <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["file", file.id])}>
                        <Icon className="h-4 w-4 text-primary" aria-hidden />
                        <span className="font-medium">{file.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell tabular-nums">{fmtBytes(file.sizeBytes)}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{when(file.updatedAt)}</TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${file.name}`}><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigateTo("files", ["file", file.id])}><Eye className="h-4 w-4 mr-2" /> Open</DropdownMenuItem>
                          {permAtLeast(level, "DOWNLOAD") ? (
                            <DropdownMenuItem onClick={() => downloadFile(file.id)}><Download className="h-4 w-4 mr-2" /> Download</DropdownMenuItem>
                          ) : null}
                          {permAtLeast(level, "EDIT") ? (
                            <DropdownMenuItem onClick={() => { setRenaming({ id: file.id, name: file.name }); setRenameValue(file.name); }}>
                              Rename
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename file</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="sf-rename">Name</label>
            <input id="sf-rename" className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button onClick={() => void act(async () => { if (renaming) { await api.patch(`/api/v1/files/${renaming.id}`, { name: renameValue.trim() }); setRenaming(null); } }, "Renamed")}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}

/** §23 Starred */
export function StarredList() {
  const { toast } = useToast();
  const { data, loading, error, reload } = useList<{ files: FileRow[]; folders: FolderRow[] }>("/api/v1/files?view=starred");
  const unstar = async (type: "FILE" | "FOLDER", id: string) => {
    try {
      await api.post(type === "FILE" ? `/api/v1/files/${id}/star` : `/api/v1/files/folders/${id}/star`);
      await reload();
    } catch (e) {
      toast({ title: "Could not unstar", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };
  if (loading) return <LoadingState label="Loading starred…" />;
  if (error || !data) return (
    <div className="space-y-4">
      <PageHeader title="Starred" />
      <ErrorState message={error ?? "Unknown error."} onRetry={() => void reload()} />
    </div>
  );
  const empty = data.files.length === 0 && data.folders.length === 0;
  return (
    <div className="space-y-4">
      <PageHeader title="Starred" subtitle="Your favorites — stars on items you can no longer access disappear automatically." />
      {empty ? (
        <EmptyState title="No starred items" description="Star files and folders to find them quickly." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[220px]">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Type</TableHead>
                <TableHead className="hidden sm:table-cell">Size</TableHead>
                <TableHead className="hidden md:table-cell">Modified</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.folders.map((f) => (
                <TableRow key={`fl-${f.id}`}>
                  <TableCell>
                    <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["my", f.id])}>
                      <folderIcon className="h-4 w-4 text-primary" aria-hidden /><span className="font-medium">{f.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">Folder</TableCell>
                  <TableCell className="hidden sm:table-cell" />
                  <TableCell className="hidden md:table-cell text-muted-foreground">{when(f.updatedAt)}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Unstar ${f.name}`} onClick={() => void unstar("FOLDER", f.id)}><X className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
              {data.files.map((f) => {
                const Icon = fileIcon(f.name, f.mimeType);
                return (
                  <TableRow key={`fi-${f.id}`}>
                    <TableCell>
                      <button className="flex items-center gap-2.5 hover:underline" onClick={() => navigateTo("files", ["file", f.id])}>
                        <Icon className="h-4 w-4 text-primary" aria-hidden /><span className="font-medium">{f.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">{f.mimeType}</TableCell>
                    <TableCell className="hidden sm:table-cell tabular-nums">{fmtBytes(f.sizeBytes)}</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{when(f.updatedAt)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Unstar ${f.name}`} onClick={() => void unstar("FILE", f.id)}><X className="h-4 w-4" /></Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** §17 Trash */
export function TrashList() {
  const { toast } = useToast();
  const { data, loading, error, reload } = useList<{ files: FileRow[]; folders: FolderRow[] }>("/api/v1/files?view=trash");
  const [confirmPurge, setConfirmPurge] = useState<{ type: "FILE" | "FOLDER"; id: string; name: string } | null>(null);

  if (loading) return <LoadingState label="Loading trash…" />;
  if (error || !data) return (
    <div className="space-y-4">
      <PageHeader title="Trash" />
      <ErrorState message={error ?? "Unknown error."} onRetry={() => void reload()} />
    </div>
  );
  const empty = data.files.length === 0 && data.folders.length === 0;

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast({ title: success });
      await reload();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FilesBackButton label="Back" fallback={[]} />
        <PageHeader title="Trash" subtitle="Deleted items stay here until you restore them or delete them permanently." />
      </div>
      {empty ? (
        <EmptyState title="Trash is empty" description="Deleted files and folders appear here." />
      ) : (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px]">Name</TableHead>
                <TableHead className="hidden sm:table-cell">Deleted</TableHead>
                <TableHead className="hidden md:table-cell">Size</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.folders.map((f) => (
                <TableRow key={`fl-${f.id}`}>
                  <TableCell><span className="flex items-center gap-2.5"><folderIcon className="h-4 w-4 text-muted-foreground" aria-hidden /><span className="font-medium">{f.name}</span></span></TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">{when(f.trashedAt)}</TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground">Folder</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Restore ${f.name}`} onClick={() => void act(() => api.post(`/api/v1/files/folders/${f.id}/restore`), "Folder restored")}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" aria-label={`Permanently delete ${f.name}`} onClick={() => setConfirmPurge({ type: "FOLDER", id: f.id, name: f.name })}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {data.files.map((f) => {
                const Icon = fileIcon(f.name, f.mimeType);
                return (
                  <TableRow key={`fi-${f.id}`}>
                    <TableCell><span className="flex items-center gap-2.5"><Icon className="h-4 w-4 text-muted-foreground" aria-hidden /><span className="font-medium">{f.name}</span></span></TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">{when(f.trashedAt)}</TableCell>
                    <TableCell className="hidden md:table-cell tabular-nums">{fmtBytes(f.sizeBytes)}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Restore ${f.name}`} onClick={() => void act(() => api.post(`/api/v1/files/${f.id}/restore`), "File restored")}>
                          <RotateCcw className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" aria-label={`Permanently delete ${f.name}`} onClick={() => setConfirmPurge({ type: "FILE", id: f.id, name: f.name })}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={confirmPurge !== null} onOpenChange={(open) => { if (!open) setConfirmPurge(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete “{confirmPurge?.name}”?</DialogTitle>
            <DialogDescription>
              This removes {confirmPurge?.type === "FOLDER" ? "the folder and EVERYTHING inside it" : "the file and all its versions"} from storage permanently. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmPurge(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() =>
                void act(async () => {
                  if (!confirmPurge) return;
                  if (confirmPurge.type === "FOLDER") await api.del(`/api/v1/files/folders/${confirmPurge.id}/purge`);
                  else await api.del(`/api/v1/files/${confirmPurge.id}/purge`);
                  setConfirmPurge(null);
                }, "Permanently deleted")
              }
            >
              Delete forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** §24 Recent — real activity feed. */
export function RecentList() {
  return (
    <ListShell
      title="Recent"
      subtitle="Your latest file activity from the real audit trail."
      url="/api/v1/files?view=recent"
      empty={<EmptyState title="No recent activity" description="Uploads, downloads, shares and edits appear here." />}
    >
      {(data) => (
        <div className="rounded-lg border bg-card divide-y">
          {(data.recent as { id: string; action: string; name: string; at: string; resourceType: string; resourceId: string }[]).map((r) => (
            <button
              key={r.id}
              className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left text-sm hover:bg-muted/50 transition-colors"
              onClick={() => navigateTo("files", r.resourceType === "FILE" ? ["file", r.resourceId] : r.resourceType === "FILE_FOLDER" ? ["my", r.resourceId] : [])}
            >
              <span className="font-medium capitalize w-28 shrink-0">{r.action.replace(/^FILE_|^FOLDER_/, "").toLowerCase().replace(/_/g, " ")}</span>
              <span className="truncate flex-1">{r.name || r.resourceId.slice(0, 10) + "…"}</span>
              <span className="text-xs text-muted-foreground shrink-0">{when(r.at)}</span>
            </button>
          ))}
        </div>
      )}
    </ListShell>
  );
}

type ActivityItem = { id: string; action: string; name: string; at: string; detail: Record<string, unknown> };

/** §25 Activity — paginated real audit feed. */
export function ActivityList() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ActivityItem[]>(`/api/v1/files/activity?page=${p}&pageSize=30`);
      setItems(res.data);
      const meta = (res.meta ?? {}) as { totalPages?: number };
      setTotalPages(meta.totalPages ?? 1);
      setPage(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load activity.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FilesBackButton label="Back" fallback={[]} />
        <PageHeader title="Activity" subtitle="Everything you did in Files — recorded by the existing audit system." />
      </div>
      {loading ? (
        <LoadingState label="Loading activity…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(page)} />
      ) : items.length === 0 ? (
        <EmptyState title="No activity yet" description="Your file actions will appear here." />
      ) : (
        <div className="rounded-lg border bg-card divide-y">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
              <span className="font-medium capitalize w-32 shrink-0">{item.action.replace(/^FILE_|^FOLDER_|^UPLOAD_/, "").toLowerCase().replace(/_/g, " ")}</span>
              <span className="truncate flex-1">{item.name || "—"}</span>
              <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">{when(item.at)}</span>
            </div>
          ))}
        </div>
      )}
      {totalPages > 1 ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>Previous</Button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages || loading} onClick={() => void load(page + 1)}>Next</Button>
        </div>
      ) : null}
    </div>
  );
}
