"use client";

// MOHD.HMS ENTERPRISE — Central checklist template library + simple creation.

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { PageShell } from "@/components/hms/shared/page-shell";
import { LoadingState, EmptyState, ErrorState, StatusBadge } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, CHECKLIST_TASK_PRIORITIES, CHECKLIST_WORK_TYPES, CHECKLIST_RESPONSE_TYPES, humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2 } from "lucide-react";

type TemplateRow = {
  id: string; name: string; category: string; workType: string; equipmentCategory?: string;
  description: string; version: number; status: string; approvalRequired: boolean; itemCount: number;
  items: { label: string; required?: boolean; priority?: string; responseType?: string }[];
  createdAt: string;
};

type EditItem = { label: string; required: boolean; responseType: string; priority: string };

export function TemplatesPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const canCreate = hasPerm(user, PERMISSIONS.checklist_template_manage);

  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [newRowLabel, setNewRowLabel] = useState("");
  const [rows2, setRows2] = useState<EditItem[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; category: string; workType: string; description: string; items: EditItem[] } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<{ templates: TemplateRow[] }>("/api/v1/checklists/templates");
      setRows(res.data.templates);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const addRow = () => {
    if (!newRowLabel.trim()) return;
    setRows2((prev) => [...prev, { label: newRowLabel.trim(), required: true, responseType: "CHECKBOX", priority: "ROUTINE" }]);
    setNewRowLabel("");
  };

  const createTemplate = async () => {
    if (!name.trim() || !category.trim()) { toast({ title: "Name and category are required", variant: "destructive" }); return; }
    if (rows2.length < 3) { toast({ title: "A template needs at least 3 tasks", variant: "destructive" }); return; }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        category: category.trim(),
        items: rows2.map((r) => ({ label: r.label, required: r.required, responseType: r.responseType, priority: r.priority })),
      };
      await api.post("/api/v1/checklists/templates", body);
      toast({ title: "Template created", description: `${name.trim()} (${rows2.length} tasks).` });
      setCreating(false); setName(""); setCategory(""); setRows2([]);
      void load();
    } catch (e) {
      toast({ title: "Could not create template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const addEditRow = () => {
    if (!newRowLabel.trim() || !editForm) return;
    setEditForm({ ...editForm, items: [...editForm.items, { label: newRowLabel.trim(), required: true, responseType: "CHECKBOX", priority: "ROUTINE" }] });
    setNewRowLabel("");
  };

  const startEdit = (t: TemplateRow) => {
    setEditForm({
      name: t.name, category: t.category, workType: t.workType, description: t.description,
      items: (t.items ?? []).map((it) => ({ label: it.label, required: !!it.required, responseType: it.responseType ?? "CHECKBOX", priority: it.priority ?? "ROUTINE" })),
    });
    setEditingId(t.id);
  };

  const saveEdit = async () => {
    if (!editingId || !editForm) return;
    if (!editForm.name.trim() || !editForm.category.trim()) { toast({ title: "Name and category are required", variant: "destructive" }); return; }
    if (editForm.items.length < 3) { toast({ title: "A template needs at least 3 tasks", variant: "destructive" }); return; }
    setEditBusy(true);
    try {
      await api.patch(`/api/v1/checklists/templates/${editingId}`, {
        name: editForm.name.trim(), category: editForm.category.trim(), workType: editForm.workType,
        description: editForm.description, items: editForm.items, changelog: "Updated via template editor",
      });
      toast({ title: "Template updated", description: `${editForm.name.trim()} (v${editForm.items.length} tasks).` });
      setEditingId(null); setEditForm(null);
      void load();
    } catch (e) {
      toast({ title: "Could not update template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setEditBusy(false);
    }
  };

  const toggleStatus = async (t: TemplateRow, status: "ACTIVE" | "INACTIVE") => {
    setBusy(true);
    try {
      await api.patch(`/api/v1/checklists/templates/${t.id}`, { status, changelog: `Marked ${status.toLowerCase()} from template library` });
      toast({ title: `Template ${status.toLowerCase()}` });
      void load();
    } catch (e) {
      toast({ title: `Could not ${status.toLowerCase()} template`, description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const duplicateTemplate = async (t: TemplateRow) => {
    setDuplicatingId(t.id);
    try {
      await api.post(`/api/v1/checklists/templates/${t.id}/duplicate`);
      toast({ title: "Template duplicated", description: `${t.name} (copy).` });
      void load();
    } catch (e) {
      toast({ title: "Could not duplicate template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDuplicatingId(null);
    }
  };

  return (
    <PageShell backLabel="Back to Checklists" backHref="/checklists" title="Checklist templates" description="The central, versioned template library used by the deterministic generation path.">
      <div className="flex justify-end">
        {canCreate ? <Button onClick={() => setCreating((v) => !v)}><Plus className="h-4 w-4 mr-1.5" /> {creating ? "Close editor" : "New template"}</Button> : null}
      </div>

      {creating ? (
        <Card className="shadow-sm p-5 space-y-4 max-w-2xl my-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="e.g. Annual HVAC inspection" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-cat">Category</Label>
              <Input id="tpl-cat" value={category} onChange={(e) => setCategory(e.target.value)} maxLength={40} placeholder="e.g. HVAC" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Tasks (min 3)</Label>
            <div className="flex gap-2">
              <Input value={newRowLabel} onChange={(e) => setNewRowLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRow(); }} placeholder="Add a task label…" maxLength={300} aria-label="New task label" />
              <Button variant="outline" onClick={addRow} disabled={!newRowLabel.trim()}><Plus className="h-4 w-4 mr-1" /> Add</Button>
            </div>
            {rows2.length > 0 ? (
              <ul className="space-y-1.5 pt-1">
                {rows2.map((r, idx) => (
                  <li key={idx} className="flex items-center gap-2 rounded-lg border p-2.5">
                    <span className="text-sm flex-1">{r.label} {r.required ? <span className="text-destructive">*</span> : null}</span>
                    <select
                      value={r.priority}
                      onChange={(e) => setRows2((prev) => prev.map((p, i) => (i === idx ? { ...p, priority: e.target.value } : p)))}
                      className="h-7 rounded border bg-background px-1.5 text-xs"
                      aria-label={`Priority for ${r.label}`}
                    >
                      {CHECKLIST_TASK_PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
                    </select>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setRows2((prev) => prev.filter((_, i) => i !== idx))} aria-label={`Remove ${r.label}`}>
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="flex gap-2">
            <Button onClick={createTemplate} disabled={busy || rows2.length < 3}>{busy ? "Saving…" : "Create template"}</Button>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </Card>
      ) : null}

      {loading && !rows ? (
        <LoadingState label="Loading templates…" rows={4} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState title="No templates yet" hint={canCreate ? "Create the first template above." : "Templates will be added by authorized staff."} />
      ) : (
        <div className="space-y-3">
          {editingId && editForm ? (
            <Card className="shadow-sm max-w-2xl my-4">
              <CardHeader><CardTitle>Edit template</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="edit-tpl-name">Name</Label>
                  <Input id="edit-tpl-name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} maxLength={200} disabled={editBusy} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-tpl-category">Category</Label>
                  <Input id="edit-tpl-category" value={editForm.category} onChange={(e) => setEditForm({ ...editForm, category: e.target.value })} maxLength={40} disabled={editBusy} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-tpl-work-type">Work type</Label>
                  <select id="edit-tpl-work-type" value={editForm.workType} onChange={(e) => setEditForm({ ...editForm, workType: e.target.value })} className="h-7 rounded border bg-background px-1.5 text-xs" disabled={editBusy}>
                    {CHECKLIST_WORK_TYPES.map((wt) => <option key={wt} value={wt}>{humanize(wt)}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="edit-tpl-desc">Description</Label>
                  <Input id="edit-tpl-desc" value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} maxLength={2000} disabled={editBusy} />
                </div>
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1">Tasks <span className="text-xs text-muted-foreground">(min 3)</span></Label>
                  <div className="space-y-1">
                    {editForm.items.map((it, idx) => (
                      <div key={idx} className="flex items-center gap-2 rounded-lg border p-2">
                        <Input value={it.label} onChange={(e) => setEditForm({ ...editForm, items: editForm.items.map((i, i2) => i2 === idx ? { ...i, label: e.target.value } : i) })} placeholder="Task label" maxLength={300} disabled={editBusy} className="flex-1" />
                        <select value={it.responseType} onChange={(e) => setEditForm({ ...editForm, items: editForm.items.map((i, i2) => i2 === idx ? { ...i, responseType: e.target.value } : i) })} className="h-7 rounded border bg-background px-1.5 text-xs" disabled={editBusy} aria-label={`Response type for ${it.label}`}>
                          {CHECKLIST_RESPONSE_TYPES.map((rt) => <option key={rt} value={rt}>{rt}</option>)}
                        </select>
                        <select value={it.priority} onChange={(e) => setEditForm({ ...editForm, items: editForm.items.map((i, i2) => i2 === idx ? { ...i, priority: e.target.value } : i) })} className="h-7 rounded border bg-background px-1.5 text-xs" disabled={editBusy} aria-label={`Priority for ${it.label}`}>
                          {CHECKLIST_TASK_PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
                        </select>
                        <Checkbox checked={it.required} onCheckedChange={(checked) => setEditForm({ ...editForm, items: editForm.items.map((i, i2) => i2 === idx ? { ...i, required: !!checked } : i) })} disabled={editBusy} />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditForm({ ...editForm, items: editForm.items.filter((_, i2) => i2 !== idx) })} disabled={editBusy || editForm.items.length <= 3} aria-label={`Remove task ${it.label}`}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Input value={newRowLabel} onChange={(e) => setNewRowLabel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addEditRow(); }} placeholder="Add a task label…" maxLength={300} disabled={editBusy} />
                      <Button variant="outline" onClick={addEditRow} disabled={editBusy || !newRowLabel.trim()}><Plus className="h-4 w-4 mr-1" /> Add</Button>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button onClick={saveEdit} disabled={editBusy || editForm.items.length < 3}>{editBusy ? "Saving…" : "Save template"}</Button>
                  <Button variant="outline" onClick={() => { setEditingId(null); setEditForm(null); setNewRowLabel(""); }}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          ) : null}
          {rows.map((t) => (
            <div key={t.id} className="rounded-xl border bg-card shadow-sm p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <p className="font-medium">{t.name} <Badge variant="outline" className="ml-1.5 font-mono text-[10px]">{t.category}</Badge></p>
                  <p className="text-xs text-muted-foreground">
                    {humanize(t.workType)}{t.equipmentCategory ? ` · ${t.equipmentCategory}` : ""} · v{t.version} · {t.itemCount} tasks
                    {t.approvalRequired ? " · approval required" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1 sm:ml-auto">
                  <StatusBadge status={t.status} />
                  {canCreate ? (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => startEdit(t)} disabled={editBusy || (editingId !== null && editingId !== t.id)}>
                        {editingId === t.id ? "Editing…" : "Edit"}
                      </Button>
                      <Button size="sm" onClick={() => duplicateTemplate(t)} disabled={busy || duplicatingId === t.id}>
                        {duplicatingId === t.id ? "…" : "Duplicate"}
                      </Button>
                      <Button size="sm" variant={t.status === "ACTIVE" ? "destructive" : "outline"} onClick={() => toggleStatus(t, t.status === "ACTIVE" ? "INACTIVE" : "ACTIVE")} disabled={busy}>
                        {t.status === "ACTIVE" ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
              {t.description ? <p className="text-sm text-muted-foreground mt-2">{t.description}</p> : null}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">View tasks</summary>
                <ul className="mt-2 space-y-1 text-sm pl-1">
                  {t.items.map((it, idx) => (
                    <li key={idx}>• {it.label}{it.required ? <span className="text-destructive">*</span> : null}</li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}