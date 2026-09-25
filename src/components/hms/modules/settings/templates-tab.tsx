"use client";

// MOHD.HMS ENTERPRISE — Settings → Templates tab (document template management).
//
// View 1  — home cards grouped by document family (§3)
// View 2  — template list per type (search / status filter / actions)
// View 3  — the editor (template-editor.tsx) with the LIVE PDF preview
//
// ONE central template system over the central PDF registry (template-meta.ts
// is client-safe and shared verbatim with the server). Preview renders through
// the REAL production PDF pipeline (/api/v1/templates/preview) — no fake HTML
// preview, no second renderer.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Archive,
  BadgeCheck,
  Copy,
  Eye,
  FileText,
  Layers,
  Pencil,
  Plus,
  Search,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import {
  BLOCK_META,
  TEMPLATE_GROUPS,
  TEMPLATE_TYPE_NAMES,
  type TemplateType,
} from "@/lib/hms/pdf/template-meta";
import { TemplateEditor } from "./template-editor";

type TemplateListItem = {
  id: string;
  templateType: string;
  name: string;
  description: string;
  status: string;
  isDefault: boolean;
  currentVersion: { id: string; version: number; status: string } | null;
  versionCount: number;
  updatedAt: string;
};

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-amber-100 text-amber-800 border-amber-200",
  ACTIVE: "bg-emerald-100 text-emerald-800 border-emerald-200",
  INACTIVE: "bg-stone-100 text-stone-600 border-stone-200",
  ARCHIVED: "bg-rose-50 text-rose-700 border-rose-200",
};

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ").toLowerCase();
}

export function TemplatesTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.templates_manage);
  const canPublish = hasPerm(user, PERMISSIONS.templates_publish);

  const [view, setView] = useState<"home" | "list" | "editor">("home");
  const [activeType, setActiveType] = useState<TemplateType | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<TemplateListItem[]>("/api/v1/templates");
      setTemplates(res.data ?? []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view !== "editor") void load();
  }, [load, view]);

  const byType = useMemo(() => {
    const map = new Map<string, TemplateListItem[]>();
    for (const t of templates) {
      const arr = map.get(t.templateType) ?? [];
      arr.push(t);
      map.set(t.templateType, arr);
    }
    return map;
  }, [templates]);

  const openType = (type: TemplateType) => {
    setActiveType(type);
    setSearch("");
    setStatusFilter("all");
    setView("list");
  };

  const createTemplate = async () => {
    if (!activeType || !createName.trim()) return;
    setCreating(true);
    try {
      const res = await api.post<{ id: string }>("/api/v1/templates", {
        templateType: activeType,
        name: createName.trim(),
        description: createDesc.trim(),
      });
      toast({ title: "Template created", description: "A draft (version 1) was created — edit it, then publish." });
      setCreateOpen(false);
      setCreateName("");
      setCreateDesc("");
      await load();
      setEditingId(res.data.id);
      setView("editor");
    } catch (e) {
      toast({ title: "Create failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setCreating(false);
    }
  };

  const action = async (id: string, path: string, body?: unknown, successMsg?: string) => {
    setBusyId(id);
    try {
      await api.post(`/api/v1/templates/${id}/${path}`, body);
      toast({ title: successMsg ?? "Done" });
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    let rows = activeType ? byType.get(activeType) ?? [] : [];
    if (statusFilter !== "all") rows = rows.filter((t) => t.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    return rows;
  }, [byType, activeType, statusFilter, search]);

  // ── View 3: editor ────────────────────────────────────────────────────────
  if (view === "editor" && editingId && activeType) {
    return (
      <TemplateEditor
        templateId={editingId}
        templateType={activeType}
        onBack={() => {
          setEditingId(null);
          setView("list");
        }}
      />
    );
  }

  // ── View 1: home cards ────────────────────────────────────────────────────
  if (view === "home") {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-medium">Document Templates</h3>
          <p className="text-sm text-muted-foreground">
            Centralized templates for every PDF document the system generates — layouts, branding, and the live
            preview all use the real production PDF engine. The default template of each type drives new documents;
            historical documents keep the version they were generated with.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {TEMPLATE_GROUPS.map((g) => {
            const total = g.types.reduce((n, t) => n + (byType.get(t) ?? []).length, 0);
            const defaults = g.types
              .map((t) => (byType.get(t) ?? []).find((x) => x.isDefault))
              .filter(Boolean) as TemplateListItem[];
            return (
              <Card
                key={g.key}
                className="cursor-pointer transition-colors hover:border-primary/40 hover:bg-accent/40"
                role="button"
                tabIndex={0}
                onClick={() => openType(g.types[0])}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openType(g.types[0]);
                  }
                }}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <FileText className="h-5 w-5 text-primary" aria-hidden />
                    <Badge variant="outline" className="tabular-nums">
                      {total} {total === 1 ? "template" : "templates"}
                    </Badge>
                  </div>
                  <CardTitle className="text-base">{g.label}</CardTitle>
                  <CardDescription>{g.description}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {defaults.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {defaults.map((d) => (
                        <Badge key={d.id} variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-800">
                          <Star className="h-3 w-3" aria-hidden /> {d.name}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">Built-in layout (no default template yet)</span>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  // ── View 2: template list ─────────────────────────────────────────────────
  const meta = activeType ? BLOCK_META[activeType] : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setView("home")}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> All document types
        </Button>
        {activeType ? <Badge variant="outline">{TEMPLATE_TYPE_NAMES[activeType]}</Badge> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates…"
              className="h-9 w-44 pl-8"
              aria-label="Search templates"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9 w-36" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="INACTIVE">Inactive</SelectItem>
              <SelectItem value="ARCHIVED">Archived</SelectItem>
            </SelectContent>
          </Select>
          {canManage && activeType ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> New template
            </Button>
          ) : null}
        </div>
      </div>

      {activeType ? (
        <p className="text-sm text-muted-foreground">
          {meta.length} building blocks available (QR verification is required and always renders). New documents use
          the type default; documents already generated keep their pinned version.
        </p>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">Loading templates…</div>
          ) : visible.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <Layers className="h-6 w-6" aria-hidden />
              No templates yet — documents use the built-in canonical layout.
            </div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead className="hidden md:table-cell">Updated</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="max-w-64">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{t.name}</span>
                          {t.isDefault ? (
                            <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-800">
                              <Star className="h-3 w-3" aria-hidden /> Default
                            </Badge>
                          ) : null}
                        </div>
                        {t.description ? (
                          <div className="truncate text-xs text-muted-foreground">{t.description}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_STYLES[t.status] ?? ""}>
                          {humanize(t.status)}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {t.currentVersion ? `v${t.currentVersion.version} · ${humanize(t.currentVersion.status)}` : "—"}
                        <span className="block text-xs text-muted-foreground">{t.versionCount} total</span>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {new Date(t.updatedAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === t.id}
                            onClick={() => {
                              setEditingId(t.id);
                              setView("editor");
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                          </Button>
                          {canPublish && t.status === "ACTIVE" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === t.id || t.isDefault}
                              onClick={() => action(t.id, "default", undefined, "Default template updated")}
                              title={t.isDefault ? "Already the default" : "Make this the type default"}
                            >
                              <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> Default
                            </Button>
                          ) : null}
                          {canPublish && (t.status === "ACTIVE" || t.status === "INACTIVE") ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === t.id}
                              onClick={() =>
                                action(
                                  t.id,
                                  "status",
                                  { status: t.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" },
                                  t.status === "ACTIVE" ? "Template disabled" : "Template enabled"
                                )
                              }
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden /> {t.status === "ACTIVE" ? "Disable" : "Enable"}
                            </Button>
                          ) : null}
                          {canManage ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === t.id}
                              onClick={() => action(t.id, "duplicate", undefined, "Copy created as draft")}
                            >
                              <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
                            </Button>
                          ) : null}
                          {canPublish && t.status !== "ARCHIVED" ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-rose-700 hover:bg-rose-50"
                              disabled={busyId === t.id}
                              onClick={() => action(t.id, "archive", undefined, "Template archived")}
                            >
                              <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New {activeType ? TEMPLATE_TYPE_NAMES[activeType] : ""} template</DialogTitle>
            <DialogDescription>
              Creates a draft (version 1) starting from the built-in canonical layout. Publish requires validation to
              pass.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="tpl-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="tpl-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Standard Invoice 2026"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tpl-desc" className="text-sm font-medium">
                Description <span className="text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="tpl-desc"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="What is this variant for?"
                maxLength={300}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createTemplate} disabled={creating || !createName.trim()}>
              {creating ? "Creating…" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
