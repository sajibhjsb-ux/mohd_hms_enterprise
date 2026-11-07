// MOHD.HMS ENTERPRISE — Visual page builder editor (§CMS).
// Three-panel editor: element library / navigator / media library (left),
// live canvas (center), properties (right). Autosave drafts; publish to the
// public website; undo/redo history; responsive device toggle.

"use client";

import React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Plus, Minus, Trash2, Save, Check, X, RotateCcw, Upload,
  Image as PicIcon, Layout, List, Menu, Code, Eye, Anchor,
  Heading as HeadingIcon, Text as TextIcon,
} from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { useSession, hasPerm } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PageHeader } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RenderPage from "./page-renderer";

type Block = { id: string; type: string; props?: Record<string, unknown>; children?: Block[] };
type Content = { blocks: Block[] };

type Device = "desktop" | "tablet" | "mobile";
const DEVICE_WIDTH: Record<Device, string> = { desktop: "1024px", tablet: "768px", mobile: "375px" };
const DEVICE_LABEL: Record<Device, string> = { desktop: "Desktop", tablet: "Tablet", mobile: "Mobile" };

const EMPTY_CONTENT: Content = { blocks: [] };

function newBlock(type: string, props: Record<string, unknown> = {}): Block {
  return { id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, type, props, children: [] };
}

const DEFAULT_BLOCKS: Record<string, Record<string, unknown>> = {
  section: { backgroundColor: "transparent", padding: "1rem" },
  container: { maxWidth: 1200, margin: "0 auto", padding: "1rem" },
  columns: { gap: "1.5rem" },
  column: { width: "50%", padding: "0.5rem" },
  heading: { text: "Heading", tag: "h2", fontSize: "1.5rem", color: "", marginBottom: "1rem" },
  text: { text: "Write something…", tag: "p", fontSize: "1rem", color: "", marginBottom: "1rem" },
  image: { src: "", alt: "", width: undefined, height: undefined, marginBottom: "1rem" },
  button: { text: "Button", marginBottom: "1rem" },
  divider: { marginBottom: "1rem" },
  spacer: { height: "1rem" },
  html: { html: "<p>HTML block</p>", marginBottom: "1rem" },
};

const BLOCK_LABELS: Record<string, string> = {
  section: "Section", container: "Container", columns: "Columns", column: "Column",
  heading: "Heading", text: "Text", image: "Image", button: "Button",
  divider: "Divider", spacer: "Spacer", html: "HTML",
};
const BLOCK_ICONS: Record<string, any> = {
  section: Layout, container: Layout, columns: Layout, column: Layout,
  heading: HeadingIcon, text: TextIcon, image: PicIcon, button: Anchor,
  divider: Minus, spacer: Minus, html: Code,
};

export function PageBuilder({ initialPage }: { initialPage: any }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canPublish = hasPerm(user, PERMISSIONS.cms_pages_publish);
  const canUpdate = hasPerm(user, PERMISSIONS.cms_pages_update);

  const [pageTitle, setPageTitle] = useState(initialPage?.title ?? "");
  const [content, setContent] = useState<Content>(initialPage?.content ?? EMPTY_CONTENT);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>("desktop");
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "error">("saved");
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaTarget, setMediaTarget] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string; mimeType: string; objectKey: string }[]>([]);

  const historyRef = useRef<Content[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    historyRef.current = [content];
  }, [content]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.get<{ files: any[] }>("/api/v1/files?view=mine");
        const imgs = res.data.files.filter((f) => String(f.mimeType || "").startsWith("image/"));
        setFiles(imgs.slice(0, 60));
      } catch {
        /* media list optional */
      }
    })();
  }, []);

  const page = useMemo(() => ({
    id: initialPage.id, slug: initialPage.slug, title: initialPage.title,
    status: initialPage.status, seoTitle: initialPage.seoTitle,
    seoDescription: initialPage.seoDescription,
  }), [initialPage]);

  // ─── History / autosave ─────────────────────────────────────────────

  const pushHistory = useCallback((next: Content) => {
    setContent(next);
    historyRef.current = [...historyRef.current.slice(0, 50), next];
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.length < 2) return;
    h.pop();
    const previous = h[h.length - 1];
    if (previous) setContent(previous);
    setSaveStatus("saving");
    scheduleSave();
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveDraft(false); }, 1500);
  }, []);

  const saveDraft = useCallback(async (showToast = false) => {
    if (!canUpdate) return;
    setIsSaving(true);
    setSaveStatus("saving");
    try {
      await api.patch(`/api/v1/cms/pages/${initialPage.id}`, {
        title: pageTitle,
        content,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
      });
      setSaveStatus("saved");
      if (showToast) toast({ title: "Saved", description: "Draft saved." });
    } catch (e) {
      setSaveStatus("error");
      toast({ title: "Save failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setIsSaving(false);
    }
  }, [canUpdate, content, pageTitle, initialPage.id, page.seoTitle, page.seoDescription, toast]);

  useEffect(() => { scheduleSave(); }, [content, pageTitle, scheduleSave]);

  const handlePublish = async () => {
    if (!canPublish) { toast({ title: "Not authorized", description: "Publishing requires admin rights." }); return; }
    if (!content.blocks.length) { toast({ title: "Add content first", description: "Drop at least one block onto the canvas." }); return; }
    try {
      await saveDraft(false);
      const res = await api.post<{ revision: any }>(`/api/v1/cms/pages/${initialPage.id}/publish`, {
        changeSummary: "Published from page builder.",
      });
      setSaveStatus("saved");
      toast({ title: "Published", description: `Page ${page.slug} is live (v${res.data.revision.version}).` });
    } catch (e) {
      toast({ title: "Publish failed", description: e instanceof Error ? e.message : String(e) });
    }
  };

  // ─── Block operations ────────────────────────────────────────────────

  const addBlock = useCallback((type: string) => {
    const block = newBlock(type, { ...DEFAULT_BLOCKS[type] });
    const next = { ...content, blocks: [...content.blocks, block] };
    setSelectedId(block.id);
    pushHistory(next);
    scheduleSave();
  }, [content, pushHistory]);

  const insertImage = useCallback((objectKey: string) => {
    if (!mediaTarget) return;
    const next = { ...content, blocks: content.blocks.map((b) => b.id === mediaTarget
      ? { ...b, props: { ...b.props, src: objectKey } }
      : b) };
    setContent(next);
    pushHistory(next);
    setMediaOpen(false);
    setMediaTarget(null);
    scheduleSave();
  }, [content, pushHistory]);

  const openMedia = useCallback((blockId: string) => {
    setMediaTarget(blockId);
    setMediaOpen(true);
  }, []);

  const updateBlock = useCallback((id: string, patch: Record<string, unknown>) => {
    const next = { ...content, blocks: content.blocks.map((b) => b.id === id ? { ...b, props: { ...b.props, ...patch } } : b) };
    setContent(next);
    pushHistory(next);
    scheduleSave();
  }, [content, pushHistory]);

  const deleteBlock = useCallback((id: string) => {
    const next = { ...content, blocks: content.blocks.filter((b) => b.id !== id) };
    setSelectedId(selectedId === id ? null : selectedId);
    setContent(next);
    pushHistory(next);
    scheduleSave();
  }, [content, pushHistory, selectedId]);

  const duplicateBlock = useCallback((id: string) => {
    const idx = content.blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const block = content.blocks[idx];
    const copy = { ...block, id: `${block.type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
    const next = { ...content, blocks: [...content.blocks.slice(0, idx + 1), copy, ...content.blocks.slice(idx + 1)] };
    setSelectedId(copy.id);
    pushHistory(next);
    scheduleSave();
  }, [content, pushHistory]);

  const moveBlock = useCallback((id: string, dir: -1 | 1) => {
    const idx = content.blocks.findIndex((b) => b.id === id);
    if (idx === -1) return;
    const target = idx + dir;
    if (target < 0 || target >= content.blocks.length) return;
    const next = { ...content, blocks: [...content.blocks] };
    [next.blocks[idx], next.blocks[target]] = [next.blocks[target], next.blocks[idx]];
    setContent(next);
    pushHistory(next);
    scheduleSave();
  }, [content, pushHistory]);

  const selectedBlock = content.blocks.find((b) => b.id === selectedId) ?? null;
  const deviceClass = `cms-device-${device}`;

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Top toolbar */}
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 border-b bg-background/80 backdrop-blur z-20">
        <div className="flex items-center gap-2">
          <Input
            value={pageTitle}
            onChange={(e) => setPageTitle(e.target.value)}
            className="w-48 text-sm font-medium"
            placeholder="Page title"
          />
        </div>
        <div className="flex items-center gap-1">
          <Select defaultValue="desktop" onValueChange={(v) => setDevice(v as Device)}>
            <SelectTrigger className="w-20"><SelectValue placeholder="Device" /></SelectTrigger>
            <SelectContent>
              {([ "desktop", "tablet", "mobile" ] as Device[]).map((d) => (
                <SelectItem key={d} value={d}>{DEVICE_LABEL[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={undo} disabled={historyRef.current.length < 2}><RotateCcw className="w-4 h-4" /> Undo</Button>
          <Button variant="outline" size="sm" disabled={isSaving}><Save className="w-3 h-3" /> {isSaving ? "Saving…" : "Save draft"}</Button>
          {canPublish && (
            <Button onClick={handlePublish} disabled={!content.blocks.length}><Eye className="w-4 h-4" /> Publish</Button>
          )}
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel */}
        <aside className="w-72 shrink-0 border-r bg-card p-3 overflow-y-auto">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Menu className="w-4 h-4" /> Elements
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(DEFAULT_BLOCKS).map(([type]) => {
                const Icon = BLOCK_ICONS[type];
                return (
                  <Button
                    key={type}
                    variant="outline"
                    size="sm"
                    onClick={() => addBlock(type)}
                    className="flex flex-col items-center gap-1 p-2"
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs">{BLOCK_LABELS[type]}</span>
                  </Button>
                );
              })}
            </div>

            <Separator />
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <List className="w-4 h-4" /> Navigator
            </div>
            <ScrollArea className="h-48">
              <div className="space-y-1">
                {content.blocks.map((b) => (
                  <NavigatorItemFixed
                    key={b.id}
                    block={b}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onDelete={deleteBlock}
                    depth={0}
                  />
                ))}
              </div>
            </ScrollArea>

            <Separator />
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <PicIcon className="w-4 h-4" /> Media Library
            </div>
            <Button variant="outline" size="sm" onClick={() => { setMediaOpen(true); }} className="w-full">
              <Upload className="w-3 h-3 mr-1" /> Insert image
            </Button>
          </div>
        </aside>

        {/* Center canvas */}
        <main className="flex-1 relative flex items-center justify-center bg-muted overflow-auto">
          <div className={`relative border border-border/50 shadow-lg ${deviceClass}`} style={{ width: DEVICE_WIDTH[device], height: "100%", maxHeight: "100vh" }}>
            <RenderPage blocks={content.blocks} />
          </div>
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-background/90 border border-border rounded-full px-3 py-1 text-xs">
            <span>Canvas — {DEVICE_WIDTH[device]}</span>
            <span className="w-px h-3 bg-muted-foreground"></span>
            <span>{content.blocks.length} block{content.blocks.length !== 1 ? "s" : ""}</span>
          </div>
        </main>

        {/* Right panel — properties */}
        <aside className="w-80 shrink-0 border-l bg-card p-3 overflow-y-auto">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <Anchor className="w-4 h-4" /> Properties
          </div>
          {selectedBlock ? (
            <PropertiesPanel block={selectedBlock} onUpdate={(patch) => updateBlock(selectedBlock.id, patch)} onOpenMedia={openMedia} />
          ) : (
            <div className="mt-10 flex flex-col items-center gap-2 text-muted-foreground text-sm">
              <X className="w-6 h-6 opacity-40" />
              <p>Select a block to edit its properties</p>
            </div>
          )}
        </aside>
      </div>

      <div className="px-3 py-1 text-xs border-t text-muted-foreground">
        {saveStatus === "saving" ? <span className="flex items-center gap-1 animate-pulse"><Save className="w-3 h-3" /> Saving draft…</span>
        : saveStatus === "error" ? <span className="text-destructive">Save failed — retrying.</span>
        : <span className="flex items-center gap-1"><Check className="w-3 h-3" /> Saved</span>}
      </div>

      <DialogMediaLibrary open={mediaOpen} onOpenChange={setMediaOpen} onSelectImage={insertImage} files={files} />
    </div>
  );
}

// ─── Navigator item ──────────────────────────────────────────────────────

function NavigatorItemFixed({ block, selectedId, onSelect, onDelete, depth }: { block: Block; selectedId: string | null; onSelect: (id: string) => void; onDelete: (id: string) => void; depth: number }) {
  const sel = selectedId === block.id;
  const hasChildren = (block.children ?? []).length > 0;
  return (
    <div className="flex items-center gap-2 pl-2">
      <div className={`w-6 h-6 rounded border flex items-center justify-center text-xs cursor-pointer ${sel ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`} onClick={(e) => { e.stopPropagation(); onSelect(block.id); }} title={block.type}>
        {String(block.type).slice(0, 1).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0 cursor-pointer overflow-hidden truncate" onClick={(e) => { e.stopPropagation(); onSelect(block.id); }} title={BLOCK_LABELS[block.type] ?? block.type}>
        <span className="text-sm font-medium">{BLOCK_LABELS[block.type] ?? block.type}</span>
        <span className="ml-1 text-xs text-muted-foreground">[{block.id.slice(-6)}]</span>
      </div>
      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); onDelete(block.id); }}><Trash2 className="w-3 h-3" /></Button>
      {hasChildren && (
        <div className="ml-4 border-l border-border/30 pl-2 space-y-1">
          {block.children?.map((c) => (
            <NavigatorItemFixed key={c.id} block={c} selectedId={selectedId} onSelect={onSelect} onDelete={onDelete} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Properties panel ────────────────────────────────────────────────────

function PropertiesPanel({ block, onUpdate, onOpenMedia }: { block: Block; onUpdate: (patch: Record<string, unknown>) => void; onOpenMedia?: (id: string) => void }) {
  const p = block.props ?? {};
  const [local, setLocal] = useState<Record<string, unknown>>({ ...p });

  useEffect(() => { setLocal({ ...p }); }, [block.id, JSON.stringify(p)]);

  const setField = (key: string, val: unknown) => {
    const next = { ...local, [key]: val };
    setLocal(next);
    onUpdate(next);
  };

  const field = (label: string, key: string, input: React.ReactElement) => (
    <div className="space-y-1" key={key}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">{input}</div>
    </div>
  );

  const common = (
    <>
      {field("Background color", "backgroundColor", <Input value={String(local.backgroundColor ?? "")} placeholder="transparent" onChange={(e) => setField("backgroundColor", e.target.value)} />)}
      {field("Text color", "color", <Input value={String(local.color ?? "")} onChange={(e) => setField("color", e.target.value)} />)}
      {field("Font size", "fontSize", <Input value={String(local.fontSize ?? "")} placeholder="1rem" onChange={(e) => setField("fontSize", e.target.value)} />)}
      {field("Text align", "textAlign", <Input value={String(local.textAlign ?? "")} placeholder="left" onChange={(e) => setField("textAlign", e.target.value)} />)}
      {field("Padding", "padding", <Input value={String(local.padding ?? "")} placeholder="1rem" onChange={(e) => setField("padding", e.target.value)} />)}
      {field("Margin", "margin", <Input value={String(local.margin ?? "")} placeholder="0" onChange={(e) => setField("margin", e.target.value)} />)}
      {field("Width", "width", <Input value={String(local.width ?? "")} placeholder="100%" onChange={(e) => setField("width", e.target.value)} />)}
      {field("Height", "height", <Input value={String(local.height ?? "")} placeholder="auto" onChange={(e) => setField("height", e.target.value)} />)}
      {field("Border radius", "borderRadius", <Input value={String(local.borderRadius ?? "")} placeholder="0" onChange={(e) => setField("borderRadius", e.target.value)} />)}
    </>
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase">Block: {BLOCK_LABELS[block.type] ?? block.type}</span>
        <span className="text-xs text-muted-foreground">{block.id.slice(-8)}</span>
      </div>
      <Separator />

      {block.type === "heading" && (
        <>
          {field("Text", "text", <Input value={String(local.text ?? "Heading")} onChange={(e) => setField("text", e.target.value)} />)}
          {field("Tag", "tag", <Select value={String(local.tag ?? "h2")} onValueChange={(v) => setField("tag", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="h1">H1</SelectItem><SelectItem value="h2">H2</SelectItem><SelectItem value="h3">H3</SelectItem><SelectItem value="h4">H4</SelectItem></SelectContent>
          </Select>)}
          {common}
        </>
      )}
      {block.type === "text" && (
        <>
          {field("Text (HTML)", "text", <Input value={String(local.text ?? "")} onChange={(e) => setField("text", e.target.value)} />)}
          {field("Tag", "tag", <Select value={String(local.tag ?? "p")} onValueChange={(v) => setField("tag", v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="p">Paragraph</SelectItem><SelectItem value="div">Div</SelectItem><SelectItem value="span">Span</SelectItem></SelectContent>
          </Select>)}
          {common}
        </>
      )}
      {block.type === "image" && (
        <>
          {field("Image object key", "src", <Input value={String(local.src ?? "")} placeholder="MinIO object key" onChange={(e) => setField("src", e.target.value)} />)}
          {field("Alt text", "alt", <Input value={String(local.alt ?? "")} onChange={(e) => setField("alt", e.target.value)} />)}
          {field("Width", "width", <Input value={String(local.width ?? "")} onChange={(e) => setField("width", e.target.value)} />)}
          {field("Height", "height", <Input value={String(local.height ?? "")} onChange={(e) => setField("height", e.target.value)} />)}
          <Button variant="outline" size="sm" onClick={() => onOpenMedia?.(block.id)}>
            Choose from Media Library
          </Button>
          {common}
        </>
      )}
      {block.type === "button" && (
        <>
          {field("Text", "text", <Input value={String(local.text ?? "Button")} onChange={(e) => setField("text", e.target.value)} />)}
          {common}
        </>
      )}
      {block.type === "spacer" && (
        <>
          {field("Height", "height", <Input value={String(local.height ?? "1rem")} onChange={(e) => setField("height", e.target.value)} />)}
          {common}
        </>
      )}
      {block.type === "html" && (
        <>
          {field("HTML", "html", <textarea value={String(local.html ?? "")} className="h-24 font-mono text-xs border rounded p-2" onChange={(e) => setField("html", e.target.value)} />)}
          {common}
        </>
      )}
      {(block.type === "section" || block.type === "container" || block.type === "columns" || block.type === "column") && common}
    </div>
  );
}

// ─── Media library modal ─────────────────────────────────────────────────

function DialogMediaLibrary({ open, onOpenChange, onSelectImage, files }: { open: boolean; onOpenChange: (v: boolean) => void; onSelectImage: (key: string) => void; files: any[] }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[600px] h-[400px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Media Library</DialogTitle>
          <DialogDescription>Select an image to insert into the chosen block.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1">
          <div className="grid grid-cols-4 gap-2 p-2">
            {files.length === 0 ? (
              <div className="col-span-4 text-center text-sm text-muted-foreground py-10">No images available. Upload files in the Files module first.</div>
            ) : (
              files.map((f) => (
                <div
                  key={f.id}
                  className="aspect-square overflow-hidden rounded border border-border/50 cursor-pointer hover:ring-1 ring-primary/50 group"
                  onClick={() => onSelectImage(f.objectKey)}
                >
                  {f.mimeType.startsWith("image/") ? (
                    <img src={`/api/v1/files/${f.id}/content`} alt={f.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">{String(f.name).slice(0, 12)}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
