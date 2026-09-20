"use client";

// MOHD.HMS ENTERPRISE — Email template administration (Email Configuration → Templates).
// Catalog with search/category filter, full editor (variable chips with cursor
// insertion, tag helpers, sandboxed HTML preview), test send, duplicate and
// version history. All data comes from the real email API — nothing simulated.

import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Eye, History, Plus, Save, Send, X } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type TemplateRow = {
  id: string;
  key: string;
  name: string;
  category: string | null;
  description: string | null;
  subject: string;
  bodyHtml: string;
  variables: string[];
  isActive: boolean;
  isSystem: boolean;
  critical: boolean;
  version: number;
  updatedAt: string;
  latestVersion: { version: number; createdAt: string; editedBy: string | null } | null;
};

type EmailMeta = { categories?: string[] };

type TemplateVersion = {
  id?: string;
  version: number;
  subject: string | null;
  editedBy: string | null;
  createdAt: string;
  bodyHtml?: string | null;
};

type TemplatePreview = { subject: string; html: string; warnings?: string[]; previewNote?: string | null };

type EditorForm = {
  key: string;
  name: string;
  category: string;
  description: string;
  subject: string;
  bodyHtml: string;
  variables: string[];
};

/** Always-available global variables (§30). */
const GLOBAL_VARS = [
  "COMPANY_NAME", "COMPANY_ADDRESS", "COMPANY_PHONE", "COMPANY_EMAIL", "COMPANY_WEBSITE", "PORTAL_URL",
];

const INSERT_TAGS: { label: string; title: string; before: string; after: string; placeholder: string }[] = [
  { label: "<p>", title: "Paragraph", before: "<p>", after: "</p>", placeholder: "Paragraph text" },
  { label: "<strong>", title: "Bold text", before: "<strong>", after: "</strong>", placeholder: "bold text" },
  { label: "<ul>", title: "Bullet list", before: "<ul>\n  <li>", after: "</li>\n</ul>", placeholder: "List item" },
  { label: "<a>", title: "Link", before: '<a href="https://">', after: "</a>", placeholder: "link text" },
  { label: "<hr>", title: "Divider", before: "<hr />", after: "", placeholder: "" },
];

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.filter((v) => v.trim() !== "")));
}

function keyFromName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function EmailTemplates() {
  const { user } = useSession();
  const { toast } = useToast();
  const canEdit = hasPerm(user, PERMISSIONS.email_templates);

  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [meta, setMeta] = useState<EmailMeta>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [toggling, setToggling] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);

  const load = useCallback(async (s: string, cat: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<TemplateRow[]>(
        `/api/v1/email/templates${qs({ search: s || undefined, category: cat !== "all" ? cat : undefined })}`
      );
      setTemplates(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load email templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Meta (categories) is best-effort — the list itself is the critical data.
  useEffect(() => {
    api.get<EmailMeta>("/api/v1/email/meta")
      .then((res) => setMeta(res.data ?? {}))
      .catch(() => setMeta({}));
  }, []);

  // Debounced filter fetch — also covers the initial load.
  useEffect(() => {
    const t = setTimeout(() => { void load(search, category); }, 300);
    return () => clearTimeout(t);
  }, [load, search, category]);

  const toggleActive = async (t: TemplateRow) => {
    setToggling(t.id);
    try {
      await api.patch(`/api/v1/email/templates/${t.id}`, { isActive: !t.isActive });
      toast({ title: !t.isActive ? "Template activated" : "Template deactivated", description: t.name });
      await load(search, category);
    } catch (e) {
      toast({ title: "Could not update template", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setToggling(null);
    }
  };

  const duplicate = async (t: TemplateRow) => {
    setDuplicating(t.id);
    try {
      await api.post(`/api/v1/email/templates/${t.id}/duplicate`, {});
      toast({ title: "Template duplicated", description: `${t.name} (copy) created — review and activate it.` });
      await load(search, category);
    } catch (e) {
      toast({ title: "Duplicate failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDuplicating(null);
    }
  };

  // ── Editor state ──
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [form, setForm] = useState<EditorForm>({ key: "", name: "", category: "SYSTEM", description: "", subject: "", bodyHtml: "", variables: [] });
  const [keyEdited, setKeyEdited] = useState(false);
  const [varDraft, setVarDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const openEditor = (t: TemplateRow) => {
    setEditing(t);
    setCreateMode(false);
    setKeyEdited(true);
    setPreview(null);
    setPreviewOpen(false);
    setVarDraft("");
    setForm({
      key: t.key,
      name: t.name,
      category: t.category ?? "SYSTEM",
      description: t.description ?? "",
      subject: t.subject ?? "",
      bodyHtml: t.bodyHtml ?? "",
      variables: dedupe([...(t.variables ?? []), ...GLOBAL_VARS]),
    });
    setEditorOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setCreateMode(true);
    setKeyEdited(false);
    setPreview(null);
    setPreviewOpen(false);
    setVarDraft("");
    setForm({ key: "", name: "", category: category !== "all" ? category : "SYSTEM", description: "", subject: "", bodyHtml: "", variables: [...GLOBAL_VARS] });
    setEditorOpen(true);
  };

  /** Insert text at the caret of the body textarea, wrapping any selection. */
  const insertIntoBody = (before: string, after = "", placeholder = "") => {
    const el = bodyRef.current;
    const value = form.bodyHtml;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    setForm((f) => ({ ...f, bodyHtml: next }));
    const caret = start + before.length + selected.length + after.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const addVariable = () => {
    const v = varDraft.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (!v) return;
    if (!form.variables.includes(v)) setForm((f) => ({ ...f, variables: [...f.variables, v] }));
    setVarDraft("");
  };

  const togglePreview = async () => {
    if (previewOpen) { setPreviewOpen(false); return; }
    if (createMode || !editing) return;
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const res = await api.get<TemplatePreview>(`/api/v1/email/templates/${editing.id}/preview`);
      setPreview(res.data);
    } catch (e) {
      toast({ title: "Preview failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const saveEditor = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", description: "Give the template a display name first.", variant: "destructive" });
      return;
    }
    if (createMode && !form.key.trim()) {
      toast({ title: "Key required", description: "Provide a template key (UPPER_SNAKE_CASE).", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (createMode) {
        await api.post("/api/v1/email/templates", {
          key: form.key.trim(),
          name: form.name.trim(),
          category: form.category.trim() || "SYSTEM",
          description: form.description.trim(),
          subject: form.subject,
          bodyHtml: form.bodyHtml,
          variables: form.variables,
        });
        toast({ title: "Template created", description: `${form.name.trim()} is ready — activate it when verified.` });
      } else if (editing) {
        await api.patch(`/api/v1/email/templates/${editing.id}`, {
          name: form.name.trim(),
          description: form.description.trim(),
          subject: form.subject,
          bodyHtml: form.bodyHtml,
          variables: form.variables,
        });
        toast({ title: "Template saved", description: `${form.name.trim()} updated — the change is versioned.` });
      }
      setEditorOpen(false);
      await load(search, category);
    } catch (e) {
      // Validation errors from the API are shown verbatim.
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ── Test send state ──
  const [testFor, setTestFor] = useState<TemplateRow | null>(null);
  const [testTo, setTestTo] = useState("");
  const [testSending, setTestSending] = useState(false);

  const sendTest = async () => {
    if (!testFor) return;
    const to = testTo.trim();
    if (!to) {
      toast({ title: "Recipient required", description: "Enter the address that should receive the test email.", variant: "destructive" });
      return;
    }
    setTestSending(true);
    try {
      const res = await api.post<{ ok: boolean; detail?: string; logId?: string }>(`/api/v1/email/templates/${testFor.id}/test-send`, { to });
      const ok = res.data?.ok === true;
      if (ok) toast({ title: "Test email queued", description: res.data?.detail ?? `${testFor.name} → ${to}.` });
      else toast({ title: "Test email failed", description: res.data?.detail ?? "The provider rejected the message.", variant: "destructive" });
    } catch (e) {
      toast({ title: "Test email failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setTestSending(false);
    }
  };

  // ── Version history state ──
  const [historyFor, setHistoryFor] = useState<TemplateRow | null>(null);
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<TemplateVersion | null>(null);

  useEffect(() => {
    if (!historyFor) { setVersions([]); setViewVersion(null); setHistoryError(null); return; }
    let alive = true;
    setHistoryLoading(true);
    setHistoryError(null);
    api.get<TemplateVersion[]>(`/api/v1/email/templates/${historyFor.id}/versions`)
      .then((res) => { if (alive) setVersions(res.data ?? []); })
      .catch((e) => { if (alive) setHistoryError(e instanceof Error ? e.message : "Unable to load version history."); })
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [historyFor]);

  const allVariables = dedupe([...(editing?.variables ?? []), ...GLOBAL_VARS]);

  return (
    <div className="space-y-4">
      {/* Filter header */}
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <Input
          aria-label="Search templates"
          placeholder="Search name, key or subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-xs"
        />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger aria-label="Filter by category" className="sm:w-52">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {(meta.categories ?? []).map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canEdit ? (
          <Button onClick={openCreate} className="sm:ml-auto">
            <Plus className="h-4 w-4 mr-1.5" /> New template
          </Button>
        ) : null}
      </div>

      {loading ? (
        <LoadingState label="Loading email templates…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(search, category)} />
      ) : templates.length === 0 ? (
        <EmptyState title="No templates found" hint={search || category !== "all" ? "No template matches the current filter." : "Create the first email template to get started."} />
      ) : (
        <Card data-testid="email-templates-list">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Copy className="h-4 w-4 text-primary" /> Templates
            </CardTitle>
            <CardDescription>
              {templates.length} template{templates.length === 1 ? "" : "s"}
              {canEdit ? " — edits are versioned and audited." : " — read-only for your role."}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden lg:table-cell">Version</TableHead>
                  <TableHead className="hidden lg:table-cell">Updated</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium flex items-center gap-1.5">
                        {t.name}
                        {t.critical ? (
                          <Badge variant="outline" className="text-[10px] border-red-300 text-red-700">critical</Badge>
                        ) : null}
                        {t.isSystem ? <Badge variant="outline" className="text-[10px] text-muted-foreground">system</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{t.key}</div>
                      <div className="text-xs text-muted-foreground sm:hidden">
                        {(t.category ?? "—") + " · v" + t.version + " · " + when(t.updatedAt)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {t.category ? <Badge variant="outline">{t.category}</Badge> : "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="outline" className="font-mono">v{t.version}</Badge>
                      {t.latestVersion && t.latestVersion.version !== t.version ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">latest v{t.latestVersion.version}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{when(t.updatedAt)}</TableCell>
                    <TableCell>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Switch
                                checked={t.isActive}
                                disabled={!canEdit || t.critical || toggling === t.id}
                                aria-label={`Activate ${t.name}`}
                                onCheckedChange={() => void toggleActive(t)}
                              />
                            </span>
                          </TooltipTrigger>
                          {t.critical ? <TooltipContent>Security-critical</TooltipContent> : null}
                        </Tooltip>
                      </TooltipProvider>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button size="sm" variant="outline" className="h-7" data-testid="email-template-edit" onClick={() => openEditor(t)}>
                          {canEdit ? "Edit" : "View"}
                        </Button>
                        {canEdit ? (
                          <>
                            <Button size="sm" variant="ghost" className="h-7" data-testid="email-template-test-send" onClick={() => { setTestFor(t); setTestTo(""); }}>
                              <Send className="h-3 w-3 mr-1" /> Test
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7" disabled={duplicating === t.id} onClick={() => void duplicate(t)}>
                              <Copy className="h-3 w-3 mr-1" /> Duplicate
                            </Button>
                          </>
                        ) : null}
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setHistoryFor(t)}>
                          <History className="h-3 w-3 mr-1" /> History
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Editor / view dialog ── */}
      <Dialog open={editorOpen} onOpenChange={(o) => { setEditorOpen(o); if (!o) setPreviewOpen(false); }}>
        <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {createMode ? "New email template" : `Template — ${editing?.name ?? ""}`}
              {!createMode && editing ? <Badge variant="outline" className="font-mono">v{editing.version}</Badge> : null}
              {!canEdit ? <Badge variant="outline" className="text-muted-foreground">read-only</Badge> : null}
            </DialogTitle>
            <DialogDescription>
              {canEdit
                ? "Subject and body support {{VARIABLE}} placeholders. Saving records a new version — the previous version stays in history."
                : "You can view this template but not edit it — template management requires the email templates permission."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {createMode ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-key">Key (UPPER_SNAKE)</Label>
                  <Input
                    id="tpl-key"
                    value={form.key}
                    disabled={!canEdit}
                    onChange={(e) => { setKeyEdited(true); setForm((f) => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") })); }}
                    placeholder="E.g. WO_COMPLETED"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Key</Label>
                  <Input value={editing?.key ?? ""} disabled />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="tpl-name">Name</Label>
                <Input
                  id="tpl-name"
                  value={form.name}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const name = e.target.value;
                    setForm((f) => ({ ...f, name, key: !createMode || keyEdited ? f.key : keyFromName(name) }));
                  }}
                  placeholder="E.g. Work order completed"
                />
              </div>
              {createMode ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tpl-category">Category</Label>
                  <Input
                    id="tpl-category"
                    value={form.category}
                    disabled={!canEdit}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") }))}
                    placeholder="SYSTEM"
                  />
                </div>
              ) : null}
              <div className={"space-y-1.5 " + (createMode ? "" : "sm:col-span-1")}>
                <Label htmlFor="tpl-subject">Subject</Label>
                <Input
                  id="tpl-subject"
                  value={form.subject}
                  disabled={!canEdit}
                  onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                  placeholder="E.g. {{WO_REF}} — work order {{STATUS}}"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tpl-desc">Description</Label>
                <Input
                  id="tpl-desc"
                  value={form.description}
                  disabled={!canEdit}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What this template is used for"
                />
              </div>
            </div>

            {/* Variables — tag input + insertion chips */}
            <div className="space-y-2">
              <Label>Variables</Label>
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {form.variables.map((v) => (
                    <Badge key={v} variant="outline" className="font-mono text-xs gap-1 pr-1">
                      {v}
                      <button
                        type="button"
                        aria-label={`Remove variable ${v}`}
                        className="rounded-full p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => setForm((f) => ({ ...f, variables: f.variables.filter((x) => x !== v) }))}
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </Badge>
                  ))}
                  <Input
                    aria-label="Add variable"
                    className="h-8 w-48 font-mono text-xs"
                    value={varDraft}
                    onChange={(e) => setVarDraft(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addVariable(); }
                    }}
                    onBlur={addVariable}
                    placeholder="ADD_VARIABLE + Enter"
                  />
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {form.variables.map((v) => (
                    <Badge key={v} variant="outline" className="font-mono text-xs">{v}</Badge>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Click a variable to insert <code className="font-mono">{"{{VAR}}"}</code> at the cursor. Globals are always available.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {allVariables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!canEdit}
                    className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs hover:bg-primary/10 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={() => insertIntoBody("{{" + v + "}}")}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Label htmlFor="tpl-body">Body (HTML)</Label>
                {canEdit ? (
                  <div className="flex flex-wrap gap-1 ml-2">
                    {INSERT_TAGS.map((tag) => (
                      <Button key={tag.label} type="button" size="sm" variant="outline" className="h-6 px-1.5 font-mono text-[11px]" title={tag.title}
                        onClick={() => insertIntoBody(tag.before, tag.after, tag.placeholder)}>
                        {tag.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
              <Textarea
                id="tpl-body"
                ref={bodyRef}
                className="font-mono text-xs min-h-[320px]"
                value={form.bodyHtml}
                disabled={!canEdit}
                onChange={(e) => setForm((f) => ({ ...f, bodyHtml: e.target.value }))}
                placeholder="<p>Hello {{COMPANY_NAME}} team…</p>"
              />
            </div>

            {/* Preview */}
            {!createMode && editing ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" data-testid="email-template-preview" onClick={() => void togglePreview()}>
                    <Eye className="h-4 w-4 mr-1.5" /> {previewOpen ? "Hide preview" : "Preview"}
                  </Button>
                  {previewOpen ? (
                    <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">PREVIEW — sample data</Badge>
                  ) : null}
                </div>
                {previewLoading ? <LoadingState label="Rendering preview…" rows={2} /> : null}
                {previewOpen && preview ? (
                  <div className="space-y-2">
                    <iframe
                      title="Template preview"
                      sandbox=""
                      srcDoc={preview.html}
                      className="w-full h-[420px] border rounded-md bg-white"
                    />
                    {preview.previewNote ? <p className="text-xs text-muted-foreground">{preview.previewNote}</p> : null}
                    {(preview.warnings ?? []).length > 0 ? (
                      <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-2.5 text-xs space-y-1">
                        <p className="font-medium text-amber-800">Warnings</p>
                        {(preview.warnings ?? []).map((w, i) => (
                          <p key={i} className="text-amber-800 break-words">• {w}</p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>{canEdit ? "Cancel" : "Close"}</Button>
            {canEdit ? (
              <Button onClick={() => void saveEditor()} data-testid="email-template-save" disabled={saving}>
                <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : createMode ? "Create template" : "Save template"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Test send dialog ── */}
      <Dialog open={testFor !== null} onOpenChange={(o) => { if (!o) setTestFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Renders <span className="font-medium">{testFor?.name}</span> with sample data and sends it to the given address.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-test-to">Recipient</Label>
            <Input
              id="tpl-test-to"
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="name@company.com"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestFor(null)}>Cancel</Button>
            <Button onClick={() => void sendTest()} disabled={testSending}>
              <Send className="h-4 w-4 mr-1.5" /> {testSending ? "Sending…" : "Send test"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Version history dialog ── */}
      <Dialog open={historyFor !== null} onOpenChange={(o) => { if (!o) { setHistoryFor(null); setViewVersion(null); } }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Version history — {historyFor?.name}</DialogTitle>
            <DialogDescription>Every saved change is an immutable version. Click a version to inspect its body.</DialogDescription>
          </DialogHeader>
          {historyLoading ? <LoadingState label="Loading versions…" rows={2} /> : null}
          {historyError ? <ErrorState message={historyError} /> : null}
          {!historyLoading && !historyError ? (
            versions.length === 0 ? (
              <EmptyState title="No versions recorded" hint="Versions appear once the template is edited." />
            ) : (
              <div className="space-y-2">
                {versions.map((v) => (
                  <div key={v.id ?? v.version} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono">v{v.version}</Badge>
                      <span className="text-xs text-muted-foreground">{when(v.createdAt)}</span>
                      {v.editedBy ? <span className="text-xs text-muted-foreground">· {v.editedBy}</span> : null}
                      <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setViewVersion(viewVersion?.version === v.version ? null : v)}>
                        {viewVersion?.version === v.version ? "Hide body" : "View body"}
                      </Button>
                    </div>
                    {v.subject ? <p className="text-xs text-muted-foreground mt-1 truncate">Subject: {v.subject}</p> : null}
                    {viewVersion?.version === v.version ? (
                      v.bodyHtml ? (
                        <iframe
                          title={`Version ${v.version} body`}
                          sandbox=""
                          srcDoc={viewVersion.bodyHtml || undefined}
                          className="w-full h-64 border rounded-md bg-white mt-2"
                        />
                      ) : (
                        <p className="text-xs text-muted-foreground mt-2">Body not retained for this version.</p>
                      )
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
