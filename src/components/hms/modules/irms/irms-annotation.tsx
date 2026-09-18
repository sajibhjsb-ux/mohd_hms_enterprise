"use client";

// MOHD.HMS ENTERPRISE — IRMS non-destructive photo annotation editor (spec §16).
//
// Annotations are shapes stored as normalized (0..1) JSON on the photo row —
// the ORIGINAL image bytes are NEVER modified. Shapes render in a pixel-accurate
// SVG overlay sized to the displayed image (measured via ResizeObserver), so
// arrows/text stay undistorted at any size.
//
// Exports:
//   IrmsAnnotationOverlay — read-only renderer (lightbox view mode, portal).
//   IrmsAnnotationEditor  — editable overlay + toolbar (draw/select/delete/save).
//
// Shape contract (docs/irms-contracts.md §8 PATCH photo.annotation):
//   [{ type: "arrow"|"circle"|"rect"|"highlight"|"text", x, y, w, h, color?, text? }]

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Check, Circle, Diamond, Eraser, MousePointer2, MoveUpLeft, Redo2, Square, Trash2, Type, Undo2,
} from "lucide-react";

export type IrmsAnnotationShape = {
  type: "arrow" | "circle" | "rect" | "highlight" | "text";
  x: number; // 0..1 normalized
  y: number;
  w: number;
  h: number;
  color?: string;
  text?: string;
};

export const IRMS_ANNOTATION_TOOLS = ["arrow", "circle", "rect", "highlight", "text"] as const;
export type IrmsAnnotationTool = (typeof IRMS_ANNOTATION_TOOLS)[number];
type EditorTool = IrmsAnnotationTool | "select";

const TOOL_COLORS: Record<IrmsAnnotationTool, string> = {
  arrow: "#dc2626",
  circle: "#dc2626",
  rect: "#dc2626",
  highlight: "#f59e0b",
  text: "#dc2626",
};

const PALETTE = ["#dc2626", "#16a34a", "#2563eb", "#d97706", "#111827"];

function parseShapes(raw: string | null | undefined): IrmsAnnotationShape[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is IrmsAnnotationShape =>
        !!s && typeof s === "object" && typeof s.x === "number" && typeof s.y === "number" &&
        IRMS_ANNOTATION_TOOLS.includes(s.type),
    );
  } catch {
    return [];
  }
}

/** Parse a stored annotation JSON string into shapes (safe). */
export function parseIrmsAnnotation(raw: string | null | undefined): IrmsAnnotationShape[] {
  return parseShapes(raw);
}

// ── SVG rendering (pixel space measured from the container) ──

type Pt = { x: number; y: number };

function normalizeBox(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function ShapeView({
  shape, size, selected, onSelect,
}: {
  shape: IrmsAnnotationShape;
  size: { w: number; h: number };
  selected?: boolean;
  onSelect?: () => void;
}) {
  const px = (n: number, dim: "w" | "h") => n * size[dim];
  const color = shape.color ?? "#dc2626";
  const common = {
    stroke: color,
    fill: "none",
    strokeWidth: 2.5,
    vectorEffect: "non-scaling-stroke" as const,
  };

  let body: React.ReactNode = null;
  if (shape.type === "arrow") {
    const x1 = px(shape.x, "w");
    const y1 = px(shape.y, "h");
    const x2 = px(shape.x + shape.w, "w");
    const y2 = px(shape.y + shape.h, "h");
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 11;
    const p1 = { x: x2 - head * Math.cos(angle - Math.PI / 7), y: y2 - head * Math.sin(angle - Math.PI / 7) };
    const p2 = { x: x2 - head * Math.cos(angle + Math.PI / 7), y: y2 - head * Math.sin(angle + Math.PI / 7) };
    body = (
      <g>
        <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />
        <polygon points={`${x2},${y2} ${p1.x},${p1.y} ${p2.x},${p2.y}`} fill={color} />
      </g>
    );
  } else if (shape.type === "circle") {
    const cx = px(shape.x + shape.w / 2, "w");
    const cy = px(shape.y + shape.h / 2, "h");
    body = <ellipse cx={cx} cy={cy} rx={Math.max(px(shape.w, "w") / 2, 1)} ry={Math.max(px(shape.h, "h") / 2, 1)} {...common} />;
  } else if (shape.type === "rect") {
    body = <rect x={px(shape.x, "w")} y={px(shape.y, "h")} width={Math.max(px(shape.w, "w"), 1)} height={Math.max(px(shape.h, "h"), 1)} {...common} />;
  } else if (shape.type === "highlight") {
    body = (
      <rect
        x={px(shape.x, "w")} y={px(shape.y, "h")}
        width={Math.max(px(shape.w, "w"), 1)} height={Math.max(px(shape.h, "h"), 1)}
        fill={color} fillOpacity={0.32} stroke={color} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
      />
    );
  } else if (shape.type === "text") {
    body = (
      <text
        x={px(shape.x, "w")}
        y={px(shape.y + shape.h, "h")}
        fontSize={14}
        fontWeight={600}
        fill={color}
        stroke="#ffffff"
        strokeWidth={3}
        paintOrder="stroke"
        style={{ maxWidth: 240 }}
      >
        {shape.text ?? ""}
      </text>
    );
  }

  const hit =
    shape.type === "text" ? null : (
      <rect
        x={px(Math.min(shape.x, shape.x + shape.w), "w")}
        y={px(Math.min(shape.y, shape.y + shape.h), "h")}
        width={Math.max(Math.abs(px(shape.w, "w")), 8)}
        height={Math.max(Math.abs(px(shape.h, "h")), 8)}
        fill="transparent"
        className={onSelect ? "cursor-pointer" : undefined}
        onClick={onSelect}
      />
    );

  return (
    <g>
      {body}
      {selected ? (
        <rect
          x={px(Math.min(shape.x, shape.x + shape.w), "w") - 3}
          y={px(Math.min(shape.y, shape.y + shape.h), "h") - 3}
          width={Math.max(Math.abs(px(shape.w, "w")), 8) + 6}
          height={Math.max(Math.abs(px(shape.h, "h")), 8) + 6}
          fill="none"
          stroke="#0ea5e9"
          strokeWidth={1.5}
          strokeDasharray="5 3"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      ) : null}
      {hit}
    </g>
  );
}

function AnnotationSvg({
  shapes, size, selectedIndex, onSelectShape,
}: {
  shapes: IrmsAnnotationShape[];
  size: { w: number; h: number };
  selectedIndex?: number | null;
  onSelectShape?: (idx: number) => void;
}) {
  if (size.w === 0 || size.h === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={size.w}
      height={size.h}
      viewBox={`0 0 ${size.w} ${size.h}`}
      aria-hidden
    >
      {shapes.map((s, i) => (
        <g key={i} className={onSelectShape ? "pointer-events-auto" : undefined}>
          <ShapeView shape={s} size={size} selected={selectedIndex === i} onSelect={onSelectShape ? () => onSelectShape(i) : undefined} />
        </g>
      ))}
    </svg>
  );
}

/** Read-only annotation renderer — overlay sized to its parent (position: relative). */
export function IrmsAnnotationOverlay({ annotation }: { annotation: string | null | undefined }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const shapes = parseShapes(annotation);
  if (shapes.length === 0) return null;

  return (
    <OverlayMeasure refCb={ref} size={size} setSize={setSize}>
      <AnnotationSvg shapes={shapes} size={size} />
    </OverlayMeasure>
  );
}

// Shared measuring wrapper: absolute inset-0 div whose size tracks the parent.
function OverlayMeasure({
  refCb, size, setSize, children,
}: {
  refCb: React.RefObject<HTMLDivElement | null>;
  size: { w: number; h: number };
  setSize: (s: { w: number; h: number }) => void;
  children: React.ReactNode;
}) {
  useLayoutEffect(() => {
    const el = refCb.current;
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const update = () => setSize({ w: parent.clientWidth, h: parent.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [refCb, setSize]);
  return (
    <div ref={refCb} className="absolute inset-0" style={{ width: size.w || "100%", height: size.h || "100%" }}>
      {children}
    </div>
  );
}

// ── Editor ──

export function IrmsAnnotationEditor({
  src,
  alt,
  annotation,
  onSave,
  className,
}: {
  src: string;
  alt: string;
  /** Current stored annotation JSON (source of truth for Cancel/revert). */
  annotation: string | null | undefined;
  /** Persist the shapes (parent PATCHes the photo). Return value awaited. */
  onSave: (shapes: IrmsAnnotationShape[]) => Promise<void>;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [shapes, setShapes] = useState<IrmsAnnotationShape[]>(() => parseShapes(annotation));
  const [dirty, setDirty] = useState(false);
  const [tool, setTool] = useState<EditorTool>("arrow");
  const [color, setColor] = useState<string>(TOOL_COLORS.arrow);
  const [draft, setDraft] = useState<IrmsAnnotationShape | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [textAt, setTextAt] = useState<Pt | null>(null);
  const [textValue, setTextValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const undoStack = useRef<IrmsAnnotationShape[][]>([]);
  const startPt = useRef<Pt | null>(null);

  // Re-sync when a different photo (or freshly saved annotation) arrives.
  useEffect(() => {
    setShapes(parseShapes(annotation));
    setDirty(false);
    setSelected(null);
    setDraft(null);
    undoStack.current = [];
  }, [src, annotation]);

  const toNorm = useCallback((e: React.PointerEvent): Pt => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  const pushUndo = (prev: IrmsAnnotationShape[]) => {
    undoStack.current = [...undoStack.current.slice(-19), prev];
    setCanUndo(true);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (tool === "select") return;
    if (tool === "text") {
      const p = toNorm(e);
      setTextAt(p);
      setTextValue("");
      return;
    }
    const p = toNorm(e);
    startPt.current = p;
    setSelected(null);
    setDraft({ type: tool, x: p.x, y: p.y, w: 0, h: 0, color: tool === "highlight" ? TOOL_COLORS.highlight : color });
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!startPt.current || !draft) return;
    const p = toNorm(e);
    const box = normalizeBox(startPt.current, p);
    if (draft.type === "arrow") {
      // keep the drag direction (w/h may be negative for arrows)
      setDraft({ ...draft, w: p.x - startPt.current.x, h: p.y - startPt.current.y });
    } else {
      setDraft({ ...draft, ...box });
    }
  };

  const onPointerUp = () => {
    if (!draft || !startPt.current) return;
    const minSize = 0.01;
    const isDrag = Math.abs(draft.w) >= minSize || Math.abs(draft.h) >= minSize;
    startPt.current = null;
    if (!isDrag) {
      setDraft(null);
      return;
    }
    pushUndo(shapes);
    const next = [...shapes, draft];
    setShapes(next);
    setDraft(null);
    setDirty(true);
  };

  const commitText = () => {
    if (textAt && textValue.trim()) {
      pushUndo(shapes);
      setShapes([...shapes, { type: "text", x: textAt.x, y: textAt.y, w: 0.24, h: 0.035, color, text: textValue.trim() }]);
      setDirty(true);
    }
    setTextAt(null);
    setTextValue("");
  };

  const undo = () => {
    const prev = undoStack.current.pop();
    if (prev) {
      setShapes(prev);
      setDirty(true);
      setSelected(null);
    }
    setCanUndo(undoStack.current.length > 0);
  };

  const deleteSelected = () => {
    if (selected === null) return;
    pushUndo(shapes);
    setShapes(shapes.filter((_, i) => i !== selected));
    setSelected(null);
    setDirty(true);
  };

  const clearAll = () => {
    if (shapes.length === 0) return;
    pushUndo(shapes);
    setShapes([]);
    setSelected(null);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(shapes);
      setDirty(false);
      undoStack.current = [];
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save annotations.");
    } finally {
      setSaving(false);
    }
  };

  const toolBtn = (t: EditorTool, label: string, icon: React.ReactNode) => (
    <button
      key={t}
      type="button"
      onClick={() => { setTool(t); setSelected(null); }}
      aria-pressed={tool === t}
      aria-label={`${label} tool`}
      title={label}
      className={cn(
        "inline-flex h-9 min-w-9 items-center justify-center rounded-md border px-2 text-sm transition-colors",
        tool === t ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {icon}
    </button>
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div
        ref={wrapRef}
        className="relative inline-block max-w-full select-none"
        style={{ touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        { }
        <img src={src} alt={alt} className="max-h-[58vh] max-w-full rounded-md object-contain" draggable={false} />
        <AnnotationSvg
          shapes={draft ? [...shapes, draft] : shapes}
          size={size}
          selectedIndex={selected}
          onSelectShape={(i) => { setSelected(i); setTool("select"); }}
        />
        {textAt ? (
          <div
            className="absolute z-10 flex items-center gap-1 rounded-md border bg-background p-1 shadow-md"
            style={{ left: `${textAt.x * 100}%`, top: `${textAt.y * 100}%` }}
          >
            <Input
              autoFocus
              value={textValue}
              onChange={(e) => setTextValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitText();
                if (e.key === "Escape") { setTextAt(null); setTextValue(""); }
              }}
              placeholder="Annotation text…"
              className="h-8 w-44 text-sm"
              aria-label="Annotation text"
            />
            <Button type="button" size="sm" className="h-8 px-2" onClick={commitText} aria-label="Add text annotation">
              <Check className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-2">
        {toolBtn("select", "Select", <MousePointer2 className="h-4 w-4" />)}
        {toolBtn("arrow", "Arrow", <MoveUpLeft className="h-4 w-4 rotate-45" />)}
        {toolBtn("circle", "Circle", <Circle className="h-4 w-4" />)}
        {toolBtn("rect", "Rectangle", <Square className="h-4 w-4" />)}
        {toolBtn("highlight", "Highlight", <Diamond className="h-4 w-4" />)}
        {toolBtn("text", "Text", <Type className="h-4 w-4" />)}

        <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />

        <div className="flex items-center gap-1" role="group" aria-label="Annotation color">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-pressed={color === c}
              aria-label={`Color ${c}`}
              className={cn(
                "h-6 w-6 rounded-full border-2",
                color === c ? "border-foreground" : "border-transparent",
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden />

        <Button type="button" variant="outline" size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo last annotation">
          <Undo2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={deleteSelected} disabled={selected === null} aria-label="Delete selected annotation">
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={clearAll} disabled={shapes.length === 0} aria-label="Clear all annotations">
          <Eraser className="h-4 w-4" /> Clear
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button" variant="ghost" size="sm"
            onClick={() => { setShapes(parseShapes(annotation)); setDirty(false); setSelected(null); undoStack.current = []; setCanUndo(false); }}
            disabled={!dirty || saving}
          >
            <Redo2 className="h-4 w-4 rotate-180" /> Revert
          </Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save annotations"}
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {error ? (
          <span className="text-destructive">{error}</span>
        ) : (
          "Draw directly on the photo. Annotations are stored separately — the original image is never modified."
        )}
      </p>
    </div>
  );
}
