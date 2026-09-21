"use client";

// MOHD.HMS ENTERPRISE — Files browser (§6/§7): hierarchical folders + compact
// table (§58), breadcrumbs, create/rename/move/copy/delete/restore/purge/star,
// drag & drop upload landing (§18), open file detail (§20).
//
// MODE "my"     — the owner's private tree (full actions)
// MODE "shared" — a folder shared WITH the user (actions follow the granted
//                 permission level; only permitted actions render, and the
//                 backend enforces them regardless)

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight, Copy, FolderPlus, Home, MoreHorizontal, Pencil,
  Share2, Star, Trash2, Upload, FolderInput,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { LoadingState, ErrorState, EmptyState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { navigateTo } from "@/lib/hms/router";
import { fileIcon, folderIcon, fmtBytes, permAtLeast, when, type Crumb, type FileRow, type FolderRow } from "./shared";
import { ShareDialog } from "./share-dialog";

type Mode = { kind: "my" } | { kind: "shared" };

type BrowseData = {
  accessLevel?: string;
  isOwner?: boolean;
  breadcrumb: Crumb[];
  folders: FolderRow[];
  files: FileRow[];
};

export function FilesBrowser({ folderId, mode = { kind: "my" } as Mode }: { folderId: string | null; mode?: Mode }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<BrowseData | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[]>([]);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [shareTarget, setShareTarget] = useState<{ type: "FILE" | "FOLDER"; id: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ type: "FILE" | "FOLDER"; id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const base = mode.kind === "my" ? "/api/v1/files" : "/api/v1/files/folders";
  const listUrl = mode.kind === "my"
    ? `/api/v1/files?view=mine${folderId ? `&folderId=${folderId}` : ""}`
    : `/api/v1/files/folders/${folderId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<BrowseData>(listUrl);
      setData(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load this folder.");
    } finally {
      setLoading(false);
    }
  }, [listUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, success: string) => {
    try {
      await fn();
      toast({ title: success });
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const createFolder = () =>
    act(async () => {
      await api.post("/api/v1/files/folders", { name: newFolderName.trim(), parentId: folderId });
      setNewFolderOpen(false);
      setNewFolderName("");
    }, "Folder created");

  const starFolder = (f: FolderRow) =>
    act(() => api.post(`/api/v1/files/folders/${f.id}/star`), "Star updated");

  const uploadHere = () => fileInputRef.current?.click();

  const onPickDirect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Single-shot small files can upload straight from the browser context;
    // larger/multi goes through the dedicated Upload page (§19) with queue.
    navigateTo("files", ["upload"]);
  };

  if (loading) return <LoadingState label="Loading folder…" />;
  if (error || !data) {
    return (
      <div className="space-y-4">
        <PageHeader title={mode.kind === "my" ? "My Files" : "Shared folder"} />
        <ErrorState message={error ?? "Unable to load this folder."} onRetry={() => void load()} />
      </div>
    );
  }

  const accessLevel = data.accessLevel ?? "MANAGE";
  const isOwner = data.isOwner ?? (mode.kind === "my");

  return (
    <div className="space-y-4">
      <PageHeader
        title={mode.kind === "my" ? "My Files" : data.breadcrumb[data.breadcrumb.length - 1]?.name ?? "Shared folder"}
        subtitle={mode.kind === "my" ? "Your private file space — only you and people you share with can see anything here." : `Shared by ${data.files[0]?.owner?.name ?? data.folders[0]?.owner?.name ?? "another user"} — your access level: ${accessLevel.toLowerCase()}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            {permAtLeast(accessLevel, "EDIT") && (
              <Button variant="outline" size="sm" onClick={() => { setNewFolderOpen(true); }}>
                <FolderPlus className="h-4 w-4 mr-1.5" /> New folder
              </Button>
            )}
            {permAtLeast(accessLevel, "EDIT") && (
              <Button size="sm" onClick={() => navigateTo("files", ["upload"])}>
                <Upload className="h-4 w-4 mr-1.5" /> Upload here
              </Button>
            )}
          </div>
        }
      />

      {/* Breadcrumbs (§58) */}
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => navigateTo("files", mode.kind === "my" ? ["my"] : ["shared-folders"])}>
          <Home className="h-3.5 w-3.5" aria-hidden /> {mode.kind === "my" ? "My Files" : "Shared Folders"}
        </Button>
        {(data.breadcrumb ?? []).map((c) => (
          <span key={c.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => navigateTo("files", mode.kind === "my" ? ["my", c.id] : ["sf", c.id])}
            >
              {c.name}
            </Button>
          </span>
        ))}
      </nav>

      {/* Drag & drop landing (§18) */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) setDroppedFiles(files);
        }}
        className={`rounded-xl border-2 border-dashed transition-colors ${dragOver ? "border-primary bg-primary/5" : "border-transparent"}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => { void onPickDirect(e.target.files); e.currentTarget.value = ""; }}
        />
        {data.folders.length === 0 && data.files.length === 0 ? (
          <EmptyState
            title="This folder is empty"
            description="Drop files here to upload them to this folder, or use the Upload button."
            action={permAtLeast(accessLevel, "EDIT") ? (
              <Button size="sm" onClick={() => navigateTo("files", ["upload"])}>
                <Upload className="h-4 w-4 mr-1.5" /> Go to Upload
              </Button>
            ) : undefined}
          />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[220px]">Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Size</TableHead>
                  <TableHead className="hidden md:table-cell">Modified</TableHead>
                  {mode.kind === "shared" ? <TableHead className="hidden lg:table-cell">Owner</TableHead> : null}
                  <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.folders.map((folder) => (
                  <TableRow key={`f-${folder.id}`}>
                    <TableCell>
                      <button
                        className="flex items-center gap-2.5 text-left hover:underline"
                        onClick={() => navigateTo("files", mode.kind === "my" ? ["my", folder.id] : ["sf", folder.id])}
                      >
                        <folderIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                        <span className="font-medium">{folder.name}</span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">Folder</TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">{when(folder.updatedAt)}</TableCell>
                    {mode.kind === "shared" ? <TableCell className="hidden lg:table-cell text-muted-foreground">{folder.owner?.name ?? "—"}</TableCell> : null}
                    <TableCell>
                      {mode.kind === "my" ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${folder.name}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setRenaming({ type: "FOLDER", id: folder.id, name: folder.name }); setRenameValue(folder.name); }}>
                              <Pencil className="h-4 w-4 mr-2" /> Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setShareTarget({ type: "FOLDER", id: folder.id, name: folder.name }); }}>
                              <Share2 className="h-4 w-4 mr-2" /> Share
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void act(() => api.post(`/api/v1/files/folders/${folder.id}/copy`, {}), "Folder copy created")}>
                              <Copy className="h-4 w-4 mr-2" /> Copy
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => void starFolder(folder)}>
                              <Star className="h-4 w-4 mr-2" /> Star
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-red-600" onClick={() => void act(() => api.del(`/api/v1/files/folders/${folder.id}`), "Folder moved to trash")}>
                              <Trash2 className="h-4 w-4 mr-2" /> Move to trash
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
                {data.files.map((file) => {
                  const Icon = fileIcon(file.name, file.mimeType);
                  return (
                    <TableRow key={file.id}>
                      <TableCell>
                        <button className="flex items-center gap-2.5 text-left hover:underline w-full" onClick={() => navigateTo("files", ["file", file.id])}>
                          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                          <span className="font-medium truncate">{file.name}</span>
                          {file.permission ? (
                            <span className="ml-1.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{file.permission}</span>
                          ) : null}
                        </button>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell tabular-nums">{fmtBytes(file.sizeBytes)}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{when(file.updatedAt)}</TableCell>
                      {mode.kind === "shared" ? <TableCell className="hidden lg:table-cell text-muted-foreground">{file.owner?.name ?? "—"}</TableCell> : null}
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for ${file.name}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigateTo("files", ["file", file.id])}>
                              <FolderInput className="h-4 w-4 mr-2" /> Open
                            </DropdownMenuItem>
                            {permAtLeast(accessLevel, "EDIT") ? (
                              <DropdownMenuItem onClick={() => { setRenaming({ type: "FILE", id: file.id, name: file.name }); setRenameValue(file.name); }}>
                                <Pencil className="h-4 w-4 mr-2" /> Rename
                              </DropdownMenuItem>
                            ) : null}
                            {isOwner || accessLevel === "MANAGE" ? (
                              <DropdownMenuItem onClick={() => { setShareTarget({ type: "FILE", id: file.id, name: file.name }); }}>
                                <Share2 className="h-4 w-4 mr-2" /> Share
                              </DropdownMenuItem>
                            ) : null}
                            {isOwner ? (
                              <DropdownMenuItem className="text-red-600" onClick={() => void act(() => api.del(`/api/v1/files/${file.id}`), "File moved to trash")}>
                                <Trash2 className="h-4 w-4 mr-2" /> Move to trash
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
        {dragOver ? (
          <div className="py-8 text-center text-sm font-medium text-primary">DROP FILES TO UPLOAD — destination: this folder</div>
        ) : null}
      </div>

      {/* Drop confirm (§18 — confirm/change destination before upload) */}
      <Dialog open={droppedFiles.length > 0} onOpenChange={(open) => { if (!open) setDroppedFiles([]); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload {droppedFiles.length} file{droppedFiles.length === 1 ? "" : "s"}</DialogTitle>
            <DialogDescription>
              Destination: <span className="font-medium">{data.breadcrumb[data.breadcrumb.length - 1]?.name ?? "My Files"}</span>
              {" "}· {fmtBytes(droppedFiles.reduce((acc, f) => acc + f.size, 0))} total
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-40 overflow-y-auto text-sm space-y-1">
            {droppedFiles.map((f) => <div key={f.name} className="truncate border rounded px-2 py-1">{f.name} — {fmtBytes(f.size)}</div>)}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDroppedFiles([])}>Cancel</Button>
            <Button onClick={() => { setDroppedFiles([]); navigateTo("files", ["upload"]); }}>Continue to Upload</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New folder */}
      <Dialog open={newFolderOpen} onOpenChange={setNewFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Created inside the folder you are browsing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-folder-name">Name</Label>
            <Input id="new-folder-name" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="Documents" autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
            <Button disabled={!newFolderName.trim()} onClick={() => void createFolder()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={renaming !== null} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {renaming?.type === "FOLDER" ? "folder" : "file"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rename-value">Name</Label>
            <Input id="rename-value" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              disabled={!renameValue.trim()}
              onClick={() =>
                void act(async () => {
                  if (!renaming) return;
                  if (renaming.type === "FOLDER") await api.patch(`/api/v1/files/folders/${renaming.id}`, { name: renameValue.trim() });
                  else await api.patch(`/api/v1/files/${renaming.id}`, { name: renameValue.trim() });
                  setRenaming(null);
                }, "Renamed")
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share */}
      {shareTarget ? (
        <ShareDialog
          targetType={shareTarget.type}
          targetId={shareTarget.id}
          targetName={shareTarget.name}
          open={true}
          onOpenChange={(open) => { if (!open) setShareTarget(null); }}
          onChanged={() => void load()}
        />
      ) : null}
    </div>
  );
}
