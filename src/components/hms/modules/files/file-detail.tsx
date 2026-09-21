"use client";

// MOHD.HMS ENTERPRISE — File detail page (§20/§21/§16/§13).
// Secure preview (authorization-checked inline stream), metadata, actions gated
// by the caller's resolved access level, version history, sharing management.

import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft, Download, History, MoreHorizontal, Pencil, RotateCcw, Share2, Star, Trash2, Upload,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { LoadingState, ErrorState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { navigateTo } from "@/lib/hms/router";
import { fileIcon, fmtBytes, permAtLeast, when } from "./shared";
import { ShareDialog } from "./share-dialog";

type VersionRow = {
  id: string; version: number; sizeBytes: number; mimeType: string; checksum: string;
  note: string; createdAt: string; uploadedBy?: { id: string; name: string } | null;
};

type Detail = {
  file: {
    id: string; name: string; mimeType: string; sizeBytes: number; checksum: string;
    currentVersion: number; createdAt: string; updatedAt: string; folderId: string | null;
    ownerId: string; owner: { id: string; name: string; email: string };
    versions: VersionRow[];
  };
  breadcrumb: { id: string; name: string }[];
  accessLevel: string;
  isOwner: boolean;
  shareCount: number;
};

export function FileDetailPage({ fileId }: { fileId: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceFile, setReplaceFile] = useState<File | null>(null);
  const [replaceNote, setReplaceNote] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [starred, setStarred] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<Detail>(`/api/v1/files/${fileId}`);
      setData(res.data);
      setRenameValue(res.data.file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load this file.");
    } finally {
      setLoading(false);
    }
  }, [fileId]);

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

  if (loading) return <LoadingState label="Loading file…" />;
  if (error || !data) return (
    <div className="space-y-4">
      <PageHeader title="File" />
      <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />
    </div>
  );

  const { file } = data;
  const level = data.accessLevel;
  const Icon = fileIcon(file.name, file.mimeType);
  const previewable = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/mp4", "text/plain", "text/csv", "application/json"]
    .includes(file.mimeType);

  const replaceVersion = async () => {
    if (!replaceFile) return;
    setReplacing(true);
    try {
      const fd = new FormData();
      fd.append("file", replaceFile);
      if (replaceNote.trim()) fd.append("note", replaceNote.trim());
      const res = await fetch(`/api/v1/files/${fileId}/versions`, { method: "POST", body: fd, credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "Version upload failed.");
      }
      toast({ title: "New version created", description: "The previous version remains in the history." });
      setReplaceOpen(false);
      setReplaceFile(null);
      setReplaceNote("");
      await load();
    } catch (e) {
      toast({ title: "Replace failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigateTo("files", file.folderId ? ["my", file.folderId] : ["my"])}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        {data.breadcrumb.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1 text-sm text-muted-foreground">
            {i > 0 ? <span>/</span> : <span className="font-medium">My Files</span>}
            <span>/</span>
            <span>{c.name}</span>
          </span>
        ))}
      </div>

      <PageHeader
        title={file.name}
        subtitle={`${data.isOwner ? "Owned by you" : `Owner: ${file.owner.name}`} · your access: ${level.toLowerCase()}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {permAtLeast(level, "DOWNLOAD") ? (
              <Button variant="outline" size="sm" onClick={() => window.open(`/api/v1/files/${fileId}/content?as=attachment`, "_blank")}>
                <Download className="h-4 w-4 mr-1.5" /> Download
              </Button>
            ) : null}
            {permAtLeast(level, "EDIT") ? (
              <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
                <Pencil className="h-4 w-4 mr-1.5" /> Rename
              </Button>
            ) : null}
            {level === "MANAGE" ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}>
                  <Share2 className="h-4 w-4 mr-1.5" /> Share{data.shareCount > 0 ? ` (${data.shareCount})` : ""}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void act(() => api.post(`/api/v1/files/${fileId}/star`), "Star updated")}>
                  <Star className="h-4 w-4 mr-1.5" /> Star
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-red-600"
                  onClick={() => void act(() => api.del(`/api/v1/files/${fileId}`), "Moved to trash")}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Preview (§21 — backend-authorized inline stream) */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="h-4 w-4 text-primary" aria-hidden /> Preview
            </CardTitle>
            <CardDescription>
              {previewable ? "Streamed through the authorized API — never a public storage link." : "This file type downloads instead of previewing (kept private by the backend)."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {previewable ? (
              file.mimeType === "application/pdf" ? (
                <iframe
                  src={`/api/v1/files/${fileId}/content?as=inline`}
                  title={`Preview of ${file.name}`}
                  className="w-full h-[480px] rounded-lg border bg-white"
                />
              ) : file.mimeType.startsWith("image/") ? (
                <img src={`/api/v1/files/${fileId}/content?as=inline`} alt={`Preview of ${file.name}`} className="max-h-[480px] w-auto rounded-lg border mx-auto" />
              ) : file.mimeType.startsWith("video/") ? (
                <video src={`/api/v1/files/${fileId}/content?as=inline`} controls className="w-full max-h-[480px] rounded-lg border" />
              ) : file.mimeType.startsWith("audio/") ? (
                <audio src={`/api/v1/files/${fileId}/content?as=inline`} controls className="w-full" />
              ) : (
                <iframe
                  src={`/api/v1/files/${fileId}/content?as=inline`}
                  title={`Preview of ${file.name}`}
                  className="w-full h-[480px] rounded-lg border bg-white"
                  sandbox=""
                />
              )
            ) : (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                <Icon className="h-12 w-12 text-muted-foreground" aria-hidden />
                {permAtLeast(level, "DOWNLOAD") ? (
                  <Button variant="outline" onClick={() => window.open(`/api/v1/files/${fileId}/content?as=attachment`, "_blank")}>
                    <Download className="h-4 w-4 mr-1.5" /> Download to view
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground">Download permission required.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Metadata (§20/§42) */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ["Type", file.mimeType],
              ["Size", fmtBytes(file.sizeBytes)],
              ["Owner", data.isOwner ? "You" : `${file.owner.name} (${file.owner.email})`],
              ["Location", data.breadcrumb.map((c) => c.name).join(" / ") || "My Files (root)"],
              ["Checksum (SHA-256)", file.checksum || "—"],
              ["Current version", `v${file.currentVersion}`],
              ["Created", when(file.createdAt)],
              ["Modified", when(file.updatedAt)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b pb-1.5 last:border-0">
                <span className="text-muted-foreground shrink-0">{k}</span>
                <span className="font-medium text-right break-all">{v}</span>
              </div>
            ))}
            {permAtLeast(level, "EDIT") ? (
              <Button variant="outline" size="sm" className="w-full mt-2" onClick={() => setReplaceOpen(true)}>
                <Upload className="h-4 w-4 mr-1.5" /> Upload new version
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Version history (§16) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" aria-hidden /> Version history
          </CardTitle>
          <CardDescription>Replacing a file never overwrites history — every version keeps its own object and checksum.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead className="hidden sm:table-cell">Size</TableHead>
                <TableHead className="hidden md:table-cell">Checksum</TableHead>
                <TableHead className="hidden md:table-cell">Note</TableHead>
                <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
                <TableHead className="w-10"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {file.versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    {v.version === file.currentVersion ? (
                      <Badge className="font-medium">v{v.version} · current</Badge>
                    ) : (
                      <Badge variant="outline">v{v.version}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell tabular-nums">{fmtBytes(v.sizeBytes)}</TableCell>
                  <TableCell className="hidden md:table-cell font-mono text-xs">{v.checksum.slice(0, 12)}…</TableCell>
                  <TableCell className="hidden md:table-cell text-muted-foreground max-w-40 truncate">{v.note || "—"}</TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">{when(v.createdAt)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Actions for version ${v.version}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => window.open(`/api/v1/files/${fileId}/versions/${v.version}?as=attachment`, "_blank")}>
                          <Download className="h-4 w-4 mr-2" /> Download
                        </DropdownMenuItem>
                        {permAtLeast(level, "EDIT") && v.version !== file.currentVersion ? (
                          <DropdownMenuItem onClick={() => void act(() => api.post(`/api/v1/files/${fileId}/versions/${v.version}`), `Version ${v.version} restored`)}>
                            <RotateCcw className="h-4 w-4 mr-2" /> Restore this version
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Rename */}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rename file</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="file-rename">Name</Label>
            <Input id="file-rename" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button onClick={() => void act(async () => { await api.patch(`/api/v1/files/${fileId}`, { name: renameValue.trim() }); setRenaming(false); }, "Renamed")}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Replace / new version */}
      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload a new version</DialogTitle>
            <DialogDescription>The current version is preserved in the history — nothing is overwritten.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="replace-file">File</Label>
              <Input id="replace-file" type="file" onChange={(e) => setReplaceFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="replace-note">Note (optional)</Label>
              <Input id="replace-note" value={replaceNote} onChange={(e) => setReplaceNote(e.target.value)} placeholder="What changed?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReplaceOpen(false)}>Cancel</Button>
            <Button disabled={!replaceFile || replacing} onClick={() => void replaceVersion()}>{replacing ? "Uploading…" : "Upload version"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ShareDialog
        targetType="FILE"
        targetId={fileId}
        targetName={file.name}
        open={shareOpen}
        onOpenChange={setShareOpen}
        onChanged={() => void load()}
      />
    </div>
  );
}
