"use client";

// MOHD.HMS ENTERPRISE — Settings → Legal tab.
// Admin management of the canonical Terms & Conditions / Privacy Policy
// (spec §22/§34): version history, draft editing, publishing and the
// customer-acceptance requirement toggle.
//
// Model:
//   • ONE canonical document per kind (TERMS | PRIVACY) — published versions
//     are IMMUTABLE; corrections ship as a new version (draft → publish
//     archives the previous one). Old versions stay as records.
//   • Sections are PLAIN TEXT (rendered as text everywhere — no HTML, no XSS).
//   • Sections flagged "requires review" carry needsReview — a visible
//     reminder that management/legal counsel has not approved that wording
//     yet (spec §19/§20/§32: never silently invent policy).
//   • Only settings_manage (SUPER_ADMIN/ADMIN) can write; read-only view for
//     other settings readers; customers have no write path at all.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink, FileCheck2, History, Plus, Save, Send, Trash2, TriangleAlert,
} from "lucide-react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type AdminSection = { id: string; title: string; body: string; needsReview?: boolean };
type AdminDoc = {
  id: string;
  kind: "TERMS" | "PRIVACY";
  version: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  effectiveDate: string | null;
  publishedAt: string | null;
  changeSummary: string;
  sections: AdminSection[];
  acceptanceCount: number;
};
type Overview = { documents: AdminDoc[]; acceptanceRequired: boolean };

type EditorState = {
  kind: "TERMS" | "PRIVACY";
  version: string;
  effectiveDate: string;
  changeSummary: string;
  sections: AdminSection[];
};

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function bumpVersion(v: string): string {
  const m = /^(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return "1.1";
  return `${m[1]}.${Number(m[2]) + 1}`;
}

function slugify(title: string, index: number): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || `section-${index + 1}`;
}

const EMPTY_EDITOR: EditorState = {
  kind: "TERMS",
  version: "",
  effectiveDate: "",
  changeSummary: "",
  sections: [{ id: "", title: "", body: "" }],
};

export function LegalTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.settings_manage);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishTarget, setPublishTarget] = useState<AdminDoc | null>(null);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<Overview>("/api/v1/legal/admin");
      setOverview(res.data);
    } catch (e) {
      setLoadError(e instanceof ClientApiError ? e.message : "Unable to load legal documents.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const docs = overview?.documents ?? [];
  const publishedByKind = useMemo(() => {
    const map = new Map<string, AdminDoc>();
    for (const d of docs) if (d.status === "PUBLISHED") map.set(d.kind, d);
    return map;
  }, [docs]);
  const drafts = useMemo(() => docs.filter((d) => d.status === "DRAFT"), [docs]);
  const history = useMemo(
    () => docs.filter((d) => d.status !== "DRAFT").sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")),
    [docs]
  );
  const reviewCount = (doc: AdminDoc | undefined) =>
    doc ? doc.sections.filter((s) => s.needsReview).length : 0;

  function startDraftFrom(kind: "TERMS" | "PRIVACY") {
    const current = publishedByKind.get(kind);
    setEditingDraftId(null);
    setEditor({
      kind,
      version: current ? bumpVersion(current.version) : "1.0",
      effectiveDate: "",
      changeSummary: "",
      sections: current
        ? current.sections.map((s) => ({ ...s }))
        : [{ id: "", title: "", body: "" }],
    });
  }

  function editExistingDraft(draft: AdminDoc) {
    setEditingDraftId(draft.id);
    setEditor({
      kind: draft.kind,
      version: draft.version,
      effectiveDate: draft.effectiveDate ?? "",
      changeSummary: draft.changeSummary,
      sections: draft.sections.map((s) => ({ ...s })),
    });
  }

  async function saveDraft() {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const payload = {
        kind: editor.kind,
        version: editor.version.trim(),
        effectiveDate: editor.effectiveDate || null,
        changeSummary: editor.changeSummary.trim(),
        sections: editor.sections.map((s, i) => ({
          id: s.id || slugify(s.title, i),
          title: s.title.trim(),
          body: s.body,
          ...(s.needsReview ? { needsReview: true } : {}),
        })),
      };
      await api.put("/api/v1/legal/admin", payload);
      toast({ title: "Draft saved", description: `Version ${payload.version} (${payload.kind}) saved as a draft.` });
      setEditor(null);
      setEditingDraftId(null);
      await load();
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof ClientApiError ? e.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    if (!publishTarget || publishing) return;
    setPublishing(true);
    try {
      await api.post("/api/v1/legal/admin", { id: publishTarget.id });
      toast({
        title: "Version published",
        description: `${publishTarget.kind === "TERMS" ? "Terms & Conditions" : "Privacy Policy"} v${publishTarget.version} is now the canonical document.`,
      });
      setPublishTarget(null);
      await load();
    } catch (e) {
      toast({
        title: "Publish failed",
        description: e instanceof ClientApiError ? e.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setPublishing(false);
    }
  }

  async function discardDraft(draft: AdminDoc) {
    try {
      await api.del(`/api/v1/legal/admin?id=${encodeURIComponent(draft.id)}`);
      toast({ title: "Draft discarded", description: `Version ${draft.version} draft removed.` });
      if (editingDraftId === draft.id) {
        setEditor(null);
        setEditingDraftId(null);
      }
      await load();
    } catch (e) {
      toast({
        title: "Discard failed",
        description: e instanceof ClientApiError ? e.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  }

  async function toggleAcceptance(required: boolean) {
    try {
      await api.put("/api/v1/settings", { values: { terms_acceptance_required: required ? "true" : "false" } });
      setOverview((o) => (o ? { ...o, acceptanceRequired: required } : o));
      toast({
        title: required ? "Acceptance required" : "Acceptance not required",
        description: required
          ? "Customers will be asked to accept the current version before using the portal."
          : "Customers will not be forced to re-accept new versions.",
      });
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof ClientApiError ? e.message : "Something went wrong.",
        variant: "destructive",
      });
    }
  }

  if (loading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading legal documents…</p>;
  }
  if (loadError || !overview) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          {loadError ?? "Legal documents are unavailable."}
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Current canonical versions ── */}
      <div className="grid gap-4 md:grid-cols-2">
        {(["TERMS", "PRIVACY"] as const).map((kind) => {
          const doc = publishedByKind.get(kind);
          const needsReview = reviewCount(doc);
          return (
            <Card key={kind}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileCheck2 className="h-4 w-4 text-primary" aria-hidden />
                  {kind === "TERMS" ? "Terms & Conditions" : "Privacy Policy"}
                </CardTitle>
                <CardDescription>
                  {doc ? (
                    <>Canonical version {doc.version} · published {fmtDateTime(doc.publishedAt)}</>
                  ) : (
                    "Not published yet."
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {doc?.effectiveDate ? (
                    <Badge variant="outline">Effective {fmtDateTime(doc.effectiveDate)}</Badge>
                  ) : (
                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                      Effective date pending approval
                    </Badge>
                  )}
                  {!!needsReview && doc ? (
                    <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                      <TriangleAlert className="mr-1 h-3 w-3" aria-hidden />
                      {needsReview} section{needsReview === 1 ? "" : "s"} need legal review
                    </Badge>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">
                  {doc?.acceptanceCount ?? 0} acceptance record{(doc?.acceptanceCount ?? 0) === 1 ? "" : "s"} for this version.
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="outline" size="sm" asChild>
                    <a href={kind === "TERMS" ? "/terms" : "/privacy"} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden /> View public page
                    </a>
                  </Button>
                  {canManage ? (
                    <Button variant="outline" size="sm" onClick={() => startDraftFrom(kind)}>
                      <Plus className="h-3.5 w-3.5" aria-hidden /> New version draft
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Acceptance requirement (spec §21/§23) ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Customer acceptance</CardTitle>
          <CardDescription>
            When required, customers are asked to accept the current version in the portal before using it —
            first acceptance and again when a new version is published (never silently re-marked). Acceptance
            records (user, version, timestamp, context) are stored append-only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch
              id="terms-acceptance-required"
              checked={overview.acceptanceRequired}
              onCheckedChange={(v) => void toggleAcceptance(v)}
              disabled={!canManage}
              aria-label="Require customers to accept the current Terms & Conditions"
            />
            <Label htmlFor="terms-acceptance-required" className="text-sm">
              {overview.acceptanceRequired ? "Required — customers must accept the current version" : "Not required — updated versions are notice-only"}
            </Label>
          </div>
          {!canManage ? (
            <p className="mt-2 text-xs text-muted-foreground">Read-only — ask an administrator to change this.</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Drafts ── */}
      {drafts.length > 0 ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Drafts</CardTitle>
            <CardDescription>Drafts are private to administrators until published.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {drafts.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
                <Badge variant="outline" className="bg-muted/50">{d.kind}</Badge>
                <span className="font-medium">v{d.version}</span>
                <span className="text-xs text-muted-foreground">
                  {d.sections.length} sections · updated {fmtDateTime(d.publishedAt ?? null)}
                </span>
                {reviewCount(d) > 0 ? (
                  <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700">
                    <TriangleAlert className="mr-1 h-3 w-3" aria-hidden /> {reviewCount(d)} for review
                  </Badge>
                ) : null}
                {canManage ? (
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => editExistingDraft(d)}>Edit</Button>
                    <Button size="sm" onClick={() => setPublishTarget(d)}>
                      <Send className="h-3.5 w-3.5" aria-hidden /> Publish
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void discardDraft(d)} aria-label={`Discard draft v${d.version}`}>
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Draft editor ── */}
      {editor ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Editing draft — {editor.kind === "TERMS" ? "Terms & Conditions" : "Privacy Policy"} v{editor.version}
            </CardTitle>
            <CardDescription>
              Plain text only. Published versions are immutable — changes ship as a new version.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="legal-version">Version</Label>
                <Input
                  id="legal-version"
                  value={editor.version}
                  onChange={(e) => setEditor({ ...editor, version: e.target.value })}
                  placeholder="1.1"
                  disabled={!canManage}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="legal-effective">Effective date (optional)</Label>
                <Input
                  id="legal-effective"
                  type="date"
                  value={editor.effectiveDate}
                  onChange={(e) => setEditor({ ...editor, effectiveDate: e.target.value })}
                  disabled={!canManage}
                />
              </div>
              <div className="space-y-1.5 sm:col-span-1">
                <Label htmlFor="legal-summary">Change summary</Label>
                <Input
                  id="legal-summary"
                  value={editor.changeSummary}
                  onChange={(e) => setEditor({ ...editor, changeSummary: e.target.value })}
                  placeholder="What changed in this version?"
                  disabled={!canManage}
                />
              </div>
            </div>

            <div className="space-y-3">
              {editor.sections.map((section, idx) => (
                <div key={idx} className="rounded-lg border p-3 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">Section {idx + 1}</span>
                    {editor.sections.length > 1 && canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-7 px-2 text-destructive hover:text-destructive"
                        onClick={() =>
                          setEditor({ ...editor, sections: editor.sections.filter((_, i) => i !== idx) })
                        }
                        aria-label={`Remove section ${idx + 1}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <Input
                    value={section.title}
                    onChange={(e) => {
                      const sections = [...editor.sections];
                      sections[idx] = { ...section, title: e.target.value };
                      setEditor({ ...editor, sections });
                    }}
                    placeholder="Section title"
                    disabled={!canManage}
                    aria-label={`Section ${idx + 1} title`}
                  />
                  <Textarea
                    rows={6}
                    value={section.body}
                    onChange={(e) => {
                      const sections = [...editor.sections];
                      sections[idx] = { ...section, body: e.target.value };
                      setEditor({ ...editor, sections });
                    }}
                    placeholder="Section body (plain text — blank line for a new paragraph)"
                    disabled={!canManage}
                    aria-label={`Section ${idx + 1} body`}
                  />
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`legal-review-${idx}`}
                      checked={!!section.needsReview}
                      onCheckedChange={(v) => {
                        const sections = [...editor.sections];
                        sections[idx] = { ...section, needsReview: v === true };
                        setEditor({ ...editor, sections });
                      }}
                      disabled={!canManage}
                    />
                    <Label htmlFor={`legal-review-${idx}`} className="text-xs font-normal text-muted-foreground">
                      Wording requires management/legal review (shows a review badge until approved)
                    </Label>
                  </div>
                </div>
              ))}
            </div>

            {canManage ? (
              <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  onClick={() =>
                    setEditor({ ...editor, sections: [...editor.sections, { id: "", title: "", body: "" }] })
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden /> Add section
                </Button>
                <div className="ml-auto flex gap-2">
                  <Button variant="ghost" onClick={() => { setEditor(null); setEditingDraftId(null); }}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void saveDraft()}
                    disabled={saving || !editor.version.trim() || editor.sections.some((s) => !s.title.trim())}
                  >
                    {saving ? <Save className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
                    Save draft
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* ── Version history ── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" aria-hidden /> Version history
          </CardTitle>
          <CardDescription>Published versions are kept immutable as records.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions published yet.</p>
          ) : (
            history.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
                <Badge variant="outline" className="bg-muted/50">{d.kind}</Badge>
                <span className="font-medium">v{d.version}</span>
                <Badge variant={d.status === "PUBLISHED" ? "default" : "outline"} className={d.status === "PUBLISHED" ? "bg-primary/10 text-primary border-primary/20" : ""}>
                  {d.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {d.effectiveDate ? `effective ${fmtDateTime(d.effectiveDate)}` : "no effective date set"} · {d.acceptanceCount} acceptance{d.acceptanceCount === 1 ? "" : "s"}
                </span>
                {d.changeSummary ? (
                  <span className="w-full text-xs text-muted-foreground sm:col-span-2">{d.changeSummary}</span>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* ── Publish confirmation ── */}
      <AlertDialog open={!!publishTarget} onOpenChange={(o) => { if (!o) setPublishTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish {publishTarget?.kind === "TERMS" ? "Terms & Conditions" : "Privacy Policy"} v{publishTarget?.version}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This becomes the single canonical document everywhere (public page, portal, consent gate). The
              previously published version is archived and kept as a record. Customers who accepted an older
              version are asked to accept the new one on their next visit — they are never silently re-marked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void publish()} disabled={publishing}>
              {publishing ? "Publishing…" : "Publish version"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
