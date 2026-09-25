"use client";

// MOHD.HMS ENTERPRISE — Template editor with LIVE PDF preview.
//
// The preview is REAL: every debounced edit posts the sanitized layout/style
// to /api/v1/templates/preview which renders a sample dataset through the
// SAME block renderers + PdfDoc engine used for production documents (§33 —
// no fake HTML preview). Editor ↔ preview run side-by-side on desktop and
// stacked on mobile (no horizontal overflow).
//
// Structure edits are a controlled reorder/hide/rename of the document's
// block catalog (template-meta.ts) — no free-form HTML, no code (§46).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Eye,
  EyeOff,
  GripVertical,
  History,
  Plus,
  RefreshCw,
  Save,
  Send,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS } from "@/lib/hms/constants";
import {
  BLOCK_META,
  DEFAULT_LAYOUT,
  TEMPLATE_TYPE_NAMES,
  TEMPLATE_VARIABLES,
  extractVarKeys,
  substituteVars,
  validateTemplate,
  type TemplateLayout,
  type TemplateType,
} from "@/lib/hms/pdf/template-meta";
import {
  DEFAULT_TEMPLATE_STYLE,
  STYLE_BOUNDS,
  TEMPLATE_FONTS,
  sanitizeStyle,
  type TemplateStyle,
} from "@/lib/hms/pdf/template-style";

type TemplateDetail = {
  id: string;
  templateType: string;
  name: string;
  description: string;
  status: string;
  isDefault: boolean;
  currentVersion: { id: string; version: number; status: string; layout: unknown; style: unknown } | null;
  versions: { id: string; version: number; status: string; createdAt: string; isCurrent: boolean }[];
  snapshotCount: number;
};

const SAMPLE_PREVIEW_VARS: Record<string, string> = {
  invoice_number: "INV-2026-000123",
  customer_name: "ABC Company",
  total: "BND 5,590.00",
  company_name: "MOHD.HMS Enterprise",
};

export function TemplateEditor({
  templateId,
  templateType,
  onBack,
}: {
  templateId: string;
  templateType: TemplateType;
  onBack: () => void;
}) {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.templates_manage);
  const canPublish = hasPerm(user, PERMISSIONS.templates_publish);

  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [layout, setLayout] = useState<TemplateLayout>(DEFAULT_LAYOUT);
  const [style, setStyle] = useState<TemplateStyle>(DEFAULT_TEMPLATE_STYLE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Preview state.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPages, setPreviewPages] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const urlRef = useRef<string | null>(null);

  const meta = BLOCK_META[templateType];
  const byId = useMemo(() => new Map(meta.map((b) => [b.id, b])), [meta]);

  // ── load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await api.get<TemplateDetail>(`/api/v1/templates/${templateId}`);
        if (!alive) return;
        const d = res.data;
        setDetail(d);
        setName(d.name);
        setDescription(d.description ?? "");
        if (d.currentVersion) {
          setLayout(sanitizeClientLayout(d.currentVersion.layout, templateType));
          setStyle(sanitizeStyle(d.currentVersion.style));
        } else {
          setLayout({ ...DEFAULT_LAYOUT, order: meta.map((b) => b.id) });
        }
      } catch (e) {
        toast({ title: "Load failed", description: e instanceof Error ? e.message : "Could not load template.", variant: "destructive" });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [templateId]);

  const markDirty = useCallback(() => setDirty(true), []);

  // ── live preview (debounced) ───────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const res = await fetch("/api/v1/templates/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ templateType, layout, style }),
        });
        if (!res.ok) {
          let msg = `Preview failed (${res.status})`;
          try {
            const j = await res.json();
            if (j?.error?.message) msg = j.error.message;
          } catch {
            /* keep default */
          }
          throw new Error(msg);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setPreviewUrl(url);
        setPreviewPages(Number(res.headers.get("X-Page-Count") ?? "0") || null);
        setPreviewError(null);
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : "Preview failed.");
      } finally {
        setPreviewLoading(false);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [layout, style, templateType, loading, previewNonce]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    []
  );

  // ── mutations ──────────────────────────────────────────────────────────────
  const saveDraft = async (silent = false) => {
    setSaving(true);
    try {
      const res = await api.patch<{ versionId: string; version: number; newVersionCreated: boolean }>(
        `/api/v1/templates/${templateId}`,
        { name: name.trim() || undefined, description, layout, style }
      );
      setDirty(false);
      if (detail) {
        setDetail({
          ...detail,
          name: name.trim() || detail.name,
          description,
          currentVersion: detail.currentVersion
            ? { ...detail.currentVersion, version: res.data.version, layout, style }
            : null,
        });
      }
      if (!silent) {
        toast({
          title: "Draft saved",
          description: res.data.newVersionCreated
            ? `Published versions are immutable — a new draft (v${res.data.version}) was created.`
            : `Saved to version ${res.data.version}.`,
        });
      }
      return true;
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const validation = useMemo(() => validateTemplate(templateType, layout, style), [templateType, layout, style]);

  const publish = async () => {
    setShowValidation(true);
    if (!validation.ok) {
      toast({ title: "Fix validation errors first", description: validation.errors[0], variant: "destructive" });
      return;
    }
    if (dirty) {
      const okSaved = await saveDraft(true);
      if (!okSaved) return;
    }
    setPublishing(true);
    try {
      const res = await api.post<{ version: number; warnings: string[] }>(`/api/v1/templates/${templateId}/publish`);
      toast({ title: `Version ${res.data.version} published`, description: "The template is now ACTIVE." });
      const d = await api.get<TemplateDetail>(`/api/v1/templates/${templateId}`);
      setDetail(d.data);
      if (d.data.currentVersion) {
        setLayout(sanitizeClientLayout(d.data.currentVersion.layout, templateType));
        setStyle(sanitizeStyle(d.data.currentVersion.style));
      }
      setDirty(false);
    } catch (e) {
      toast({ title: "Publish failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setPublishing(false);
    }
  };

  const restoreVersion = async (versionId: string) => {
    try {
      await api.post(`/api/v1/templates/${templateId}/restore`, { versionId });
      toast({ title: "Restored as new draft", description: "History was not changed — a fresh draft was created." });
      const d = await api.get<TemplateDetail>(`/api/v1/templates/${templateId}`);
      setDetail(d.data);
      if (d.data.currentVersion) {
        setLayout(sanitizeClientLayout(d.data.currentVersion.layout, templateType));
        setStyle(sanitizeStyle(d.data.currentVersion.style));
        setDirty(false);
      }
    } catch (e) {
      toast({ title: "Restore failed", description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
    }
  };

  // ── layout editing ─────────────────────────────────────────────────────────
  const setOrder = (order: string[]) => {
    setLayout((l) => ({ ...l, order }));
    markDirty();
  };
  const move = (idx: number, dir: -1 | 1) => {
    const order = [...layout.order];
    const target = idx + dir;
    if (target < 0 || target >= order.length) return;
    [order[idx], order[target]] = [order[target], order[idx]];
    setOrder(order);
  };
  const addToLayout = (id: string) => setOrder([...layout.order, id]);
  const removeFromLayout = (id: string) => {
    if (byId.get(id)?.required) return;
    setOrder(layout.order.filter((x) => x !== id));
  };
  const toggleHidden = (id: string) => {
    const hidden = layout.hidden.includes(id)
      ? layout.hidden.filter((x) => x !== id)
      : [...layout.hidden, id];
    setLayout((l) => ({ ...l, hidden }));
    markDirty();
  };
  const setHeading = (id: string, heading: string) => {
    setLayout((l) => ({ ...l, headings: { ...l.headings, [id]: heading } }));
    markDirty();
  };
  const setConfig = (id: string, key: string, value: unknown) => {
    setLayout((l) => ({ ...l, config: { ...l.config, [id]: { ...(l.config[id] ?? {}), [key]: value } } }));
    markDirty();
  };
  const setStyleKey = <K extends keyof TemplateStyle>(key: K, value: TemplateStyle[K]) => {
    setStyle((s) => ({ ...s, [key]: value }));
    markDirty();
  };

  const availableBlocks = meta.filter((b) => !layout.order.includes(b.id));
  const dragIdx = useRef<number | null>(null);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">Loading editor…</div>;
  }

  const statusBadge = detail
    ? detail.status === "ACTIVE"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : detail.status === "DRAFT"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : detail.status === "ARCHIVED"
          ? "bg-rose-50 text-rose-700 border-rose-200"
          : "bg-stone-100 text-stone-600 border-stone-200"
    : "";

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Button>
        <Badge variant="outline">{TEMPLATE_TYPE_NAMES[templateType]}</Badge>
        {detail ? <Badge variant="outline" className={statusBadge}>{detail.status}</Badge> : null}
        {detail?.currentVersion ? (
          <Badge variant="outline" className="tabular-nums">
            v{detail.currentVersion.version} · {detail.currentVersion.status}
          </Badge>
        ) : null}
        {detail?.isDefault ? (
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">
            Default
          </Badge>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowHistory((s) => !s)}>
            <History className="h-4 w-4" aria-hidden /> History ({detail?.versions.length ?? 0})
          </Button>
          {canManage ? (
            <Button variant="outline" size="sm" onClick={() => void saveDraft()} disabled={saving}>
              <Save className="h-4 w-4" aria-hidden /> {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
            </Button>
          ) : null}
          {canPublish ? (
            <Button size="sm" onClick={() => void publish()} disabled={publishing}>
              <Send className="h-4 w-4" aria-hidden /> {publishing ? "Publishing…" : "Validate & publish"}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tpl-name" className="text-xs">Template name</Label>
          <Input
            id="tpl-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              markDirty();
            }}
            disabled={!canManage}
            maxLength={80}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-desc" className="text-xs">Description</Label>
          <Input
            id="tpl-desc"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              markDirty();
            }}
            disabled={!canManage}
            maxLength={300}
            placeholder="What is this variant for?"
          />
        </div>
      </div>

      {/* version history */}
      {showHistory ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Version history</CardTitle>
            <p className="text-xs text-muted-foreground">
              Published versions are immutable. Restoring copies a historical version into a NEW draft — history is
              never rewritten. Documents already generated keep their pinned version ({detail?.snapshotCount ?? 0}{" "}
              document{detail?.snapshotCount === 1 ? "" : "s"} pinned to this template).
            </p>
          </CardHeader>
          <CardContent className="max-h-48 overflow-y-auto">
            <div className="space-y-1.5">
              {(detail?.versions ?? []).map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium tabular-nums">v{v.version}</span>
                  <Badge variant="outline" className={v.status === "PUBLISHED" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800"}>
                    {v.status}
                  </Badge>
                  {v.isCurrent ? <Badge variant="outline">working copy</Badge> : null}
                  <span className="text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
                  {canPublish && !v.isCurrent ? (
                    <Button variant="outline" size="sm" className="ml-auto" onClick={() => void restoreVersion(v.id)}>
                      Restore as draft
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* validation panel */}
      {showValidation ? (
        <Card className={validation.ok ? "border-emerald-200" : "border-rose-200"}>
          <CardContent className="pt-4">
            {validation.errors.length === 0 && validation.warnings.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-emerald-700">
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Validation passed — the template can be published.
              </p>
            ) : (
              <div className="space-y-1.5 text-sm">
                {validation.errors.map((e, i) => (
                  <p key={`e${i}`} className="flex items-start gap-2 text-rose-700">
                    <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {e}
                  </p>
                ))}
                {validation.warnings.map((w, i) => (
                  <p key={`w${i}`} className="flex items-start gap-2 text-amber-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {w}
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* editor + preview */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* LEFT — editor */}
        <div className="min-w-0 space-y-4">
          {/* layout */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Layout — document blocks</CardTitle>
              <p className="text-xs text-muted-foreground">
                Drag (or use the arrows) to reorder. Required blocks (QR verification) can never be removed.
              </p>
            </CardHeader>
            <CardContent className="max-h-[22rem] space-y-1.5 overflow-y-auto lg:max-h-[26rem]">
              {layout.order.map((id, idx) => {
                const b = byId.get(id);
                if (!b) return null;
                const hidden = layout.hidden.includes(id);
                const heading = layout.headings[id] ?? "";
                return (
                  <div
                    key={id}
                    draggable={canManage}
                    onDragStart={() => {
                      dragIdx.current = idx;
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragIdx.current;
                      if (from === null || from === idx) return;
                      const order = [...layout.order];
                      const [moved] = order.splice(from, 1);
                      order.splice(idx, 0, moved);
                      dragIdx.current = null;
                      setOrder(order);
                    }}
                    className="rounded-md border bg-background p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      {canManage ? (
                        <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.label}</span>
                      {b.required ? <Badge variant="outline" className="shrink-0 text-[10px]">required</Badge> : null}
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${b.label} up`} onClick={() => move(idx, -1)} disabled={idx === 0 || !canManage}>
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move ${b.label} down`} onClick={() => move(idx, 1)} disabled={idx === layout.order.length - 1 || !canManage}>
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                      {b.required ? null : (
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={hidden ? `Show ${b.label}` : `Hide ${b.label}`} onClick={() => toggleHidden(id)} disabled={!canManage}>
                          {hidden ? <EyeOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                        </Button>
                      )}
                      {b.required ? null : (
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Remove ${b.label}`} onClick={() => removeFromLayout(id)} disabled={!canManage}>
                          <X className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        </Button>
                      )}
                    </div>
                    <div className="mt-1.5 space-y-1.5 pl-6">
                      <Input
                        value={heading}
                        onChange={(e) => setHeading(id, e.target.value)}
                        placeholder={`Heading (default: ${b.label})`}
                        className="h-7 text-xs"
                        maxLength={60}
                        disabled={!canManage}
                        aria-label={`Custom heading for ${b.label}`}
                      />
                      {b.config?.includes("text") ? (
                        <div className="space-y-1">
                          <Textarea
                            value={String(layout.config[id]?.text ?? "")}
                            onChange={(e) => setConfig(id, "text", e.target.value)}
                            placeholder="Custom text — insert {{variables}} from the catalog below"
                            className="min-h-16 text-xs"
                            disabled={!canManage}
                            aria-label={`Custom text for ${b.label}`}
                          />
                          <VarPicker
                            type={templateType}
                            disabled={!canManage}
                            onInsert={(v) => setConfig(id, "text", `${String(layout.config[id]?.text ?? "")}{{${v.key}}}`)}
                          />
                        </div>
                      ) : null}
                      {b.config?.includes("photoColumns") ? (
                        <Select
                          value={String(layout.config[id]?.columns ?? "3")}
                          onValueChange={(v) => setConfig(id, "columns", Number(v))}
                          disabled={!canManage}
                        >
                          <SelectTrigger className="h-7 w-40 text-xs" aria-label="Photo grid columns">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">1 photo per row</SelectItem>
                            <SelectItem value="2">2 photos per row</SelectItem>
                            <SelectItem value="3">3 photos per row</SelectItem>
                            <SelectItem value="4">4 photos per row</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : null}
                      {hidden ? <p className="text-xs text-muted-foreground">Hidden — will not render.</p> : null}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* palette */}
          {availableBlocks.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Available blocks</CardTitle>
                <p className="text-xs text-muted-foreground">Click to add to the layout.</p>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {availableBlocks.map((b) => (
                  <Button key={b.id} variant="outline" size="sm" onClick={() => addToLayout(b.id)} disabled={!canManage}>
                    <Plus className="h-3.5 w-3.5" aria-hidden /> {b.label}
                  </Button>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {/* style */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Branding &amp; page style</CardTitle>
              <p className="text-xs text-muted-foreground">
                Only PDF-renderer-safe fonts and bounded sizes/margins are exposed — layouts cannot overlap or break
                generation.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <ColorField label="Primary" value={style.primaryColor} disabled={!canManage} onChange={(v) => setStyleKey("primaryColor", v)} />
                <ColorField label="Text" value={style.textColor} disabled={!canManage} onChange={(v) => setStyleKey("textColor", v)} />
                <ColorField label="Borders" value={style.borderColor} disabled={!canManage} onChange={(v) => setStyleKey("borderColor", v)} />
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">Font</Label>
                  <Select value={style.fontFamily} onValueChange={(v) => setStyleKey("fontFamily", v as TemplateStyle["fontFamily"])} disabled={!canManage}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Font family"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TEMPLATE_FONTS.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Orientation</Label>
                  <Select value={style.orientation} onValueChange={(v) => setStyleKey("orientation", v as TemplateStyle["orientation"])} disabled={!canManage}>
                    <SelectTrigger className="h-8 text-xs" aria-label="Orientation"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="portrait">Portrait (A4)</SelectItem>
                      <SelectItem value="landscape">Landscape (A4)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Body size ({style.baseFontSize}pt)</Label>
                  <input
                    type="range"
                    min={STYLE_BOUNDS.fontSize.min}
                    max={STYLE_BOUNDS.fontSize.max}
                    step={0.5}
                    value={style.baseFontSize}
                    onChange={(e) => setStyleKey("baseFontSize", Number(e.target.value))}
                    disabled={!canManage}
                    className="w-full accent-emerald-700"
                    aria-label="Body font size"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Line height ({style.lineHeight}×)</Label>
                  <input
                    type="range"
                    min={STYLE_BOUNDS.lineHeight.min}
                    max={STYLE_BOUNDS.lineHeight.max}
                    step={0.05}
                    value={style.lineHeight}
                    onChange={(e) => setStyleKey("lineHeight", Number(e.target.value))}
                    disabled={!canManage}
                    className="w-full accent-emerald-700"
                    aria-label="Line height"
                  />
                </div>
              </div>
              <Separator />
              <div className="grid gap-2 sm:grid-cols-4">
                {(["top", "bottom", "left", "right"] as const).map((m) => (
                  <div key={m} className="space-y-1">
                    <Label className="text-xs capitalize">{m} margin ({style.margins[m]}pt)</Label>
                    <input
                      type="range"
                      min={STYLE_BOUNDS.margin.min}
                      max={STYLE_BOUNDS.margin.max}
                      step={2}
                      value={style.margins[m]}
                      onChange={(e) => setStyleKey("margins", { ...style.margins, [m]: Number(e.target.value) })}
                      disabled={!canManage}
                      className="w-full accent-emerald-700"
                      aria-label={`${m} margin`}
                    />
                  </div>
                ))}
              </div>
              <Separator />
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Header</p>
                  {(["logo", "company", "address", "contact", "docNumber", "date", "meta"] as const).map((k) => (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <Label className="text-xs capitalize">{k === "docNumber" ? "document number" : k}</Label>
                      <Switch checked={style.header[k]} onCheckedChange={(v) => setStyleKey("header", { ...style.header, [k]: v })} disabled={!canManage} aria-label={`Header ${k}`} />
                    </div>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Footer</p>
                  {(["pageNumber", "generatedDate", "contact"] as const).map((k) => (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <Label className="text-xs">{k === "pageNumber" ? "Page X of Y" : k === "generatedDate" ? "Generated date" : "Contact"}</Label>
                      <Switch checked={style.footer[k]} onCheckedChange={(v) => setStyleKey("footer", { ...style.footer, [k]: v })} disabled={!canManage} aria-label={`Footer ${k}`} />
                    </div>
                  ))}
                  <Input
                    value={style.footer.customText}
                    onChange={(e) => setStyleKey("footer", { ...style.footer, customText: e.target.value })}
                    placeholder="Custom footer text (optional)"
                    className="h-7 text-xs"
                    maxLength={120}
                    disabled={!canManage}
                    aria-label="Custom footer text"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT — live preview */}
        <Card className="flex min-h-[32rem] flex-col">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Live preview — real PDF engine</CardTitle>
              <div className="ml-auto flex items-center gap-1">
                {previewPages ? <Badge variant="outline" className="tabular-nums">{previewPages} page{previewPages === 1 ? "" : "s"}</Badge> : null}
                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Refresh preview" onClick={() => setPreviewNonce((n) => n + 1)}>
                  <RefreshCw className={`h-3.5 w-3.5 ${previewLoading ? "animate-spin" : ""}`} aria-hidden />
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Rendered from safe sample data through the production PDF service — no business records are touched.
            </p>
          </CardHeader>
          <CardContent className="min-h-0 flex-1">
            {previewError ? (
              <div className="flex h-full items-center justify-center text-sm text-rose-700">{previewError}</div>
            ) : previewUrl ? (
              <div className="relative h-[calc(100%-0px)] min-h-[24rem]">
                <object data={previewUrl} type="application/pdf" className="h-full w-full rounded-md border" aria-label="Template PDF preview">
                  <iframe src={previewUrl} className="h-full w-full rounded-md border" title="Template PDF preview" />
                </object>
                {previewLoading ? (
                  <div className="pointer-events-none absolute right-3 top-3 rounded-full bg-background/90 px-3 py-1 text-xs shadow">
                    Rendering…
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                {previewLoading ? "Rendering preview…" : "Preview will appear here."}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Client-side layout normalization (mirrors the server sanitizer). */
function sanitizeClientLayout(input: unknown, type: TemplateType): TemplateLayout {
  const known = new Set(BLOCK_META[type].map((b) => b.id));
  const raw = (input ?? {}) as Partial<TemplateLayout>;
  const order = Array.isArray(raw.order) ? raw.order.filter((id): id is string => typeof id === "string" && known.has(id)) : [];
  const hidden = Array.isArray(raw.order) && order.length > 0 ? (Array.isArray(raw.hidden) ? raw.hidden.filter((id) => typeof id === "string" && known.has(id) && order.includes(id)) : []) : [];
  const headings: Record<string, string> = {};
  if (raw.headings && typeof raw.headings === "object") {
    for (const [id, v] of Object.entries(raw.headings)) {
      if (known.has(id) && typeof v === "string") headings[id] = v.slice(0, 60);
    }
  }
  const config: Record<string, Record<string, unknown>> = {};
  if (raw.config && typeof raw.config === "object") {
    for (const [id, v] of Object.entries(raw.config)) {
      if (known.has(id) && v && typeof v === "object" && !Array.isArray(v)) config[id] = { ...(v as Record<string, unknown>) };
    }
  }
  if (order.length === 0) return { ...DEFAULT_LAYOUT, order: BLOCK_META[type].map((b) => b.id) };
  return { order, hidden, headings, config };
}

function ColorField({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-8 w-9 cursor-pointer rounded border"
          aria-label={`${label} color`}
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-xs font-mono" maxLength={7} disabled={disabled} aria-label={`${label} hex`} />
      </div>
    </div>
  );
}

/** Variable catalog picker — inserts into custom text (§ variable system). */
function VarPicker({ type, onInsert, disabled }: { type: TemplateType; onInsert: (v: { key: string }) => void; disabled?: boolean }) {
  const vars = TEMPLATE_VARIABLES[type];
  return (
    <Select onValueChange={(k) => onInsert({ key: k })} disabled={disabled}>
      <SelectTrigger className="h-7 w-52 text-xs" aria-label="Insert variable">
        <span className="text-muted-foreground">Insert field…</span>
      </SelectTrigger>
      <SelectContent className="max-h-64">
        {vars.map((v) => (
          <SelectItem key={v.key} value={v.key}>
            {v.label} <span className="font-mono text-[10px] text-muted-foreground">{`{{${v.key}}}`}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Re-exported for potential reuse in previews elsewhere.
export { substituteVars, extractVarKeys, SAMPLE_PREVIEW_VARS };
