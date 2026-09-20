"use client";

// MOHD.HMS ENTERPRISE — PM Templates tab: reusable checklist programmes.
// Grid grouped by category; card shows item count + required count; detail
// dialog lists items (required badges, response types); "Use in plan" →
// /pm/new?templateId={id} (the create page prefills its checklist). pm_manage
// can create, edit and deactivate templates via the checklist editor.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileStack, Library, Pencil, Plus, Wand2 } from "lucide-react";
import { ChecklistEditor, type ChecklistItemDef } from "./pm-shared";

type TemplateRow = {
  id: string; name: string; category: string; description: string;
  items: ChecklistItemDef[] | string; itemsParsed?: ChecklistItemDef[];
  active: boolean; _count?: { plans?: number; items?: number };
};

function itemsOf(t: TemplateRow): ChecklistItemDef[] {
  if (Array.isArray(t.itemsParsed) && t.itemsParsed.length > 0) return t.itemsParsed;
  if (Array.isArray(t.items)) return t.items;
  try {
    const parsed = typeof t.items === "string" ? JSON.parse(t.items || "[]") : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const EMPTY_TEMPLATE = { name: "", category: "GENERAL", description: "", items: [] as ChecklistItemDef[] };

export function PmTemplatesTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.pm_manage);

  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewTemplate, setViewTemplate] = useState<TemplateRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_TEMPLATE);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<unknown>("/api/v1/pm/templates");
      // Contract: GET /api/v1/pm/templates?category=&active= → template list
      // + categories[]. The exact envelope may be a bare array (okList) or an
      // object carrying items + categories — accept both defensively.
      const raw = res.data as unknown;
      let list: TemplateRow[] = [];
      let cats: string[] = [];
      if (Array.isArray(raw)) {
        list = raw as TemplateRow[];
      } else if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        const candidate = obj.items ?? obj.data ?? obj.templates;
        if (Array.isArray(candidate)) list = candidate as TemplateRow[];
        if (Array.isArray(obj.categories)) cats = obj.categories as string[];
      }
      setTemplates(list);
      setCategories(cats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load PM templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useRealtimeEvent(MODULE_EVENTS.pm, () => { void load(); });

  const grouped = useMemo(() => {
    const map = new Map<string, TemplateRow[]>();
    for (const t of templates.filter((t) => t.active)) {
      map.set(t.category, [...(map.get(t.category) ?? []), t]);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [templates]);

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_TEMPLATE);
    setEditorOpen(true);
  };

  const openEdit = async (t: TemplateRow) => {
    setEditingId(t.id);
    setForm({ name: t.name, category: t.category, description: t.description ?? "", items: itemsOf(t) });
    setEditorOpen(true);
    setViewTemplate(null);
  };

  const save = async () => {
    if (!form.name.trim() || form.items.some((i) => !i.label.trim())) {
      toast({ title: "Template needs a name and fully-labelled items", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category,
        description: form.description,
        items: form.items.filter((i) => i.label.trim()).map((i) => ({ label: i.label.trim(), required: i.required, responseType: i.responseType })),
      };
      if (editingId) {
        await api.patch(`/api/v1/pm/templates/${encodeURIComponent(editingId)}`, payload);
        toast({ title: "Template updated", description: form.name.trim() });
      } else {
        await api.post("/api/v1/pm/templates", payload);
        toast({ title: "Template created", description: `${form.name.trim()} — use it from any plan.` });
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not save template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (t: TemplateRow) => {
    try {
      await api.del(`/api/v1/pm/templates/${encodeURIComponent(t.id)}`);
      toast({ title: "Template deactivated", description: `${t.name} no longer appears in pickers.` });
      setViewTemplate(null);
      await load();
    } catch (e) {
      toast({ title: "Could not deactivate template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div>
      <PageHeader
        title="Checklist Templates"
        subtitle="Reusable checklist programmes — apply one to any plan to keep standards consistent"
        actions={canManage ? (
          <Button size="sm" className="min-h-[44px]" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> New template
          </Button>
        ) : null}
      />

      {loading ? (
        <LoadingState label="Loading templates…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : grouped.length === 0 ? (
        <EmptyState
          title="No checklist templates"
          hint={canManage ? "Create a template once, then apply it to every similar plan." : "Templates will appear here once supervisors publish them."}
          action={canManage ? <Button size="sm" onClick={openCreate}><Library className="h-4 w-4 mr-1.5" /> New template</Button> : undefined}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(([category, rows]) => (
            <section key={category} aria-label={humanize(category)}>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <FileStack className="h-4 w-4 text-muted-foreground" /> {humanize(category)}
                <span className="text-muted-foreground font-normal tabular-nums">({rows.length})</span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((t) => {
                  const items = itemsOf(t);
                  const required = items.filter((i) => i.required).length;
                  return (
                    <Card key={t.id} className="shadow-sm hover:shadow-md transition-shadow">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-start justify-between gap-2">
                          <button type="button" onClick={() => setViewTemplate(t)} className="text-left font-medium hover:underline underline-offset-2 min-h-[44px]">
                            {t.name}
                          </button>
                          {canManage ? (
                            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => void openEdit(t)} aria-label={`Edit ${t.name}`}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          ) : null}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {t.description ? <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p> : null}
                        <div className="flex flex-wrap items-center gap-1.5 text-xs">
                          <Badge variant="outline" className="whitespace-nowrap">{items.length} items</Badge>
                          {required > 0 ? <Badge variant="outline" className="border-transparent bg-red-100 text-red-700 whitespace-nowrap">{required} required</Badge> : null}
                          {t._count?.plans ? <Badge variant="outline" className="whitespace-nowrap">{t._count.plans} plan{t._count.plans === 1 ? "" : "s"}</Badge> : null}
                        </div>
                        <Button
                          variant="outline" size="sm" className="w-full min-h-[44px]"
                          onClick={() => navigateTo("pm", ["new"], { templateId: t.id })}
                        >
                          <Wand2 className="h-4 w-4 mr-1.5" /> Use in plan
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={viewTemplate !== null} onOpenChange={(o) => { if (!o) setViewTemplate(null); }}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>{viewTemplate?.name}</DialogTitle>
            <DialogDescription>
              {viewTemplate ? `${humanize(viewTemplate.category)} · ${itemsOf(viewTemplate).length} checklist items` : ""}
            </DialogDescription>
          </DialogHeader>
          {viewTemplate ? (
            <>
              {viewTemplate.description ? <p className="text-sm text-muted-foreground">{viewTemplate.description}</p> : null}
              <ol className="space-y-2">
                {itemsOf(viewTemplate).map((c, i) => (
                  <li key={i} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{i + 1}</span>
                    <span className="flex-1 min-w-0 text-sm">{c.label}</span>
                    {c.required ? <Badge variant="outline" className="border-transparent bg-red-100 text-red-700">Required</Badge> : null}
                    <Badge variant="outline" className="whitespace-nowrap">{c.responseType === "CHECKBOX" ? "Tick box" : humanize(c.responseType)}</Badge>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <DialogFooter className="gap-2">
            {canManage && viewTemplate ? (
              <Button variant="outline" onClick={() => void deactivate(viewTemplate)}>Deactivate</Button>
            ) : null}
            {viewTemplate ? (
              <Button onClick={() => navigateTo("pm", ["new"], { templateId: viewTemplate.id })}>
                <Wand2 className="h-4 w-4 mr-1.5" /> Use in plan
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create / edit dialog */}
      <Dialog open={editorOpen} onOpenChange={(o) => { if (!saving) setEditorOpen(o); }}>
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-y-auto hms-scroll">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit template" : "New checklist template"}</DialogTitle>
            <DialogDescription>Name the programme, pick a category and build its checklist items.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pm-tpl-name">Name *</Label>
                <Input id="pm-tpl-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="min-h-[44px]" placeholder="Quarterly AC deep service" />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                  <SelectTrigger className="min-h-[44px]" aria-label="Category"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(categories.length > 0 ? categories : ["GENERAL", "HVAC", "ELECTRICAL", "PLUMBING", "LIFT", "FIRE_SAFETY", "SECURITY"]).map((c) => (
                      <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pm-tpl-desc">Description</Label>
              <Textarea id="pm-tpl-desc" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="min-h-[44px]" />
            </div>
            <div>
              <Label className="mb-1.5 block">Checklist items *</Label>
              <ChecklistEditor items={form.items} onChange={(items) => setForm((f) => ({ ...f, items }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : editingId ? "Save changes" : "Create template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
