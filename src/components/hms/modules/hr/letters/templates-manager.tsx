"use client";

// MOHD.HMS ENTERPRISE — Letter Templates manager (page, hr/letters/templates).
// Authorized HR/Admin users manage the reusable template catalog (§3):
// create, edit, duplicate, preview, version history, activate/deactivate,
// set default, archive. Ordinary employees/customers never reach this page
// (permission letters.templates — enforced server-side too).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { LetterPaper } from "./preview";
import { letterTypeLabel, type LetterPreviewModel, type LetterTemplateDto, type LetterTemplateVersionDto } from "@/lib/hms/letters/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Copy, Eye, FileText, History, MoreVertical, Pencil, Plus, Star, Trash2, Archive } from "lucide-react";

function errMsg(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.";
}

export function TemplatesManagerPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.letters_templates);

  const [templates, setTemplates] = useState<LetterTemplateDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [previewOf, setPreviewOf] = useState<LetterTemplateDto | null>(null);
  const [previewModel, setPreviewModel] = useState<LetterPreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [dupOf, setDupOf] = useState<LetterTemplateDto | null>(null);
  const [dupCode, setDupCode] = useState("");
  const [deleteOf, setDeleteOf] = useState<LetterTemplateDto | null>(null);
  const [versionsOf, setVersionsOf] = useState<LetterTemplateDto | null>(null);
  const [versions, setVersions] = useState<LetterTemplateVersionDto[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<LetterTemplateDto[]>("/api/v1/hr/letters/templates?pageSize=200");
      setTemplates(res.data ?? []);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openPreview = async (t: LetterTemplateDto) => {
    setPreviewOf(t);
    setPreviewModel(null);
    setPreviewLoading(true);
    try {
      const res = await api.post<LetterPreviewModel>(`/api/v1/hr/letters/templates/${t.id}/preview`, {});
      setPreviewModel(res.data);
    } catch {
      setPreviewModel(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const openVersions = async (t: LetterTemplateDto) => {
    setVersionsOf(t);
    setVersions(null);
    try {
      const res = await api.get<LetterTemplateVersionDto[]>(`/api/v1/hr/letters/templates/${t.id}/versions`);
      setVersions(res.data ?? []);
    } catch {
      setVersions([]);
    }
  };

  const duplicate = async () => {
    if (!dupOf) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/hr/letters/templates/${dupOf.id}/duplicate`, { code: dupCode });
      toast({ title: "Template duplicated", description: `${dupCode} created (inactive until reviewed)` });
      setDupOf(null);
      setDupCode("");
      await load();
    } catch (e) {
      toast({ title: "Duplicate failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const patch = async (t: LetterTemplateDto, data: Record<string, unknown>, okTitle: string) => {
    setBusy(true);
    try {
      await api.patch(`/api/v1/hr/letters/templates/${t.id}`, data);
      toast({ title: okTitle });
      await load();
    } catch (e) {
      toast({ title: "Update failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteOf) return;
    setBusy(true);
    try {
      const res = await api.del<{ deleted: boolean } | LetterTemplateDto>(`/api/v1/hr/letters/templates/${deleteOf.id}`);
      const archived = !(res.data as { deleted?: boolean }).deleted;
      toast({ title: archived ? "Template archived" : "Template deleted", description: archived ? "It is referenced by existing letters." : deleteOf.code });
      setDeleteOf(null);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const filtered = (templates ?? []).filter((t) =>
    !search.trim()
      ? true
      : [t.code, t.name, t.letterType, t.description].some((s) => s.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <PageShell
      backLabel="Back to Letters"
      backHref="/hr/letters"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Letters", href: "/hr/letters" }, { label: "Templates" }]}
      title="Letter Templates"
      description="Reusable, versioned templates — the structure is fixed here; letters fill it with data and AI-drafted content."
      actions={
        canManage ? (
          <Button size="sm" onClick={() => navigateTo("hr", ["letters", "templates", "new"])}>
            <Plus className="h-4 w-4 mr-1.5" /> New Template
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, name, type…"
          className="sm:max-w-xs"
          aria-label="Search templates"
        />
        <span className="text-xs text-muted-foreground sm:ml-auto">{filtered.length} template(s)</span>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !templates ? (
        <LoadingState label="Loading templates…" />
      ) : filtered.length === 0 ? (
        <EmptyState title="No templates" hint="Create the first template to start generating letters." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map((t) => (
            <div key={t.id} className="rounded-xl border bg-card p-4 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-mono text-xs text-muted-foreground">{t.code}</span>
                    <Badge variant="outline" className="text-[10px]">v{t.version}</Badge>
                    {t.isDefault ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-700">
                        <Star className="h-3 w-3 fill-amber-500 text-amber-500" /> default
                      </span>
                    ) : null}
                  </div>
                  <div className="font-semibold text-sm leading-snug mt-0.5">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{letterTypeLabel(t.letterType)}</div>
                </div>
                <StatusBadge status={t.status} />
              </div>
              {t.description ? <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p> : null}
              <div className="text-[11px] text-muted-foreground">
                {t.fields.length} field(s) · {t.lettersCount ?? 0} letter(s) generated
              </div>
              <div className="mt-auto flex items-center gap-1.5 pt-1">
                <Button size="sm" variant="outline" onClick={() => void openPreview(t)} aria-label={`Preview template ${t.code}`}>
                  <Eye className="h-3.5 w-3.5 mr-1" /> Preview
                </Button>
                {canManage ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => navigateTo("hr", ["letters", "templates", t.id])} aria-label={`Edit template ${t.code}`}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="ghost" aria-label={`More actions for ${t.code}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setDupOf(t); setDupCode(`${t.code.split("-")[0]}-${String(Date.now()).slice(-3)}`); }}>
                          <Copy className="h-4 w-4 mr-2" /> Duplicate…
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void openVersions(t)}>
                          <History className="h-4 w-4 mr-2" /> Version history
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void patch(t, { isDefault: !t.isDefault }, t.isDefault ? "Default cleared" : "Set as default for this letter type")}>
                          <Star className="h-4 w-4 mr-2" /> {t.isDefault ? "Clear default" : "Set as default"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void patch(t, { status: t.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" }, t.status === "ACTIVE" ? "Template deactivated" : "Template activated")}>
                          <FileText className="h-4 w-4 mr-2" /> {t.status === "ACTIVE" ? "Deactivate" : "Activate"}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600" onClick={() => setDeleteOf(t)}>
                          {t.lettersCount && t.lettersCount > 0 ? <Archive className="h-4 w-4 mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                          {t.lettersCount && t.lettersCount > 0 ? "Archive" : "Delete"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview dialog */}
      <Dialog open={previewOf !== null} onOpenChange={(o) => !o && setPreviewOf(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Preview — {previewOf?.name}</DialogTitle>
          </DialogHeader>
          {previewLoading || !previewModel ? (
            <p className="text-sm text-muted-foreground p-8 text-center">Rendering preview…</p>
          ) : (
            <LetterPaper model={previewModel} />
          )}
        </DialogContent>
      </Dialog>

      {/* Duplicate dialog */}
      <Dialog open={dupOf !== null} onOpenChange={(o) => !o && setDupOf(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Duplicate {dupOf?.code}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dup-code">New template code</Label>
            <Input id="dup-code" value={dupCode} onChange={(e) => setDupCode(e.target.value)} placeholder="e.g. LOU-002" />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setDupOf(null)}>Cancel</Button>
            <Button size="sm" disabled={!dupCode.trim() || busy} onClick={() => void duplicate()}>Duplicate</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Versions dialog (§27) */}
      <Dialog open={versionsOf !== null} onOpenChange={(o) => !o && setVersionsOf(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Versions — {versionsOf?.code}</DialogTitle>
          </DialogHeader>
          {!versions ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ol className="space-y-2">
              {versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">v{v.version}{versionsOf && v.version === versionsOf.version ? " · current" : ""}</span>
                  <span className="text-xs text-muted-foreground">{v.createdByName} · {new Date(v.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete / archive confirm */}
      <AlertDialog open={deleteOf !== null} onOpenChange={(o) => !o && setDeleteOf(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{deleteOf?.lettersCount ? "Archive template?" : "Delete template?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteOf?.lettersCount
                ? "This template is referenced by existing letters, so it will be archived (kept for audit) and removed from the active catalog."
                : "This template has not been used by any letter and will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
