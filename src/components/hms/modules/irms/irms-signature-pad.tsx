"use client";

// MOHD.HMS ENTERPRISE — IRMS signature capture (spec §9 / contract §9).
//
// Canvas signature pad driven by POINTER events (mouse + touch + stylus,
// pressure-agnostic smooth strokes), Clear/Undo (stroke stack), name input and
// role-aware save → POST /api/v1/irms/reports/{id}/signatures (multipart PNG).
// Existing signatures render as history (role badge, name, signedAt, image).
// Success feedback only after a real 2xx (§67 — no fake success).

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { fmtDateTime } from "@/lib/hms/format";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Eraser, Loader2, PenTool, Undo2 } from "lucide-react";
import { humanize, IRMS_SIGNATURE_ROLES } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";

export type IrmsSignature = {
  id: string;
  role: string;
  name: string;
  signedAt: string;
  revision?: number | null;
  url: string;
};

type Stroke = { points: { x: number; y: number }[] };

// ── Canvas pad ──

function SignatureCanvas({ strokesRef, onChange }: {
  strokesRef: React.RefObject<Stroke[]>;
  onChange: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const current = useRef<Stroke | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // guide line
    ctx.strokeStyle = "#d6d3d1";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(12, h - 28);
    ctx.lineTo(w - 12, h - 28);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const all = [...(strokesRef.current ?? []), ...(current.current ? [current.current] : [])];
    for (const stroke of all) {
      const pts = stroke.points;
      if (pts.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0].x * w, pts[0].y * h);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x * w + 0.6, pts[0].y * h + 0.6);
      }
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const pt = pts[i];
        const midX = ((prev.x + pt.x) / 2) * w;
        const midY = ((prev.y + pt.y) / 2) * h;
        ctx.quadraticCurveTo(prev.x * w, prev.y * h, midX, midY);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x * w, last.y * h);
      ctx.stroke();
    }
  }, [strokesRef]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const pos = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  return (
    <canvas
      ref={canvasRef}
      className="h-40 w-full touch-none rounded-lg border bg-white"
      aria-label="Signature drawing area"
      onPointerDown={(e) => {
        e.preventDefault();
        drawing.current = true;
        current.current = { points: [pos(e)] };
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        draw();
      }}
      onPointerMove={(e) => {
        if (!drawing.current || !current.current) return;
        e.preventDefault();
        const p = pos(e);
        const pts = current.current.points;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.002) {
          pts.push(p);
          draw();
        }
      }}
      onPointerUp={() => {
        if (current.current && current.current.points.length > 0) {
          strokesRef.current = [...(strokesRef.current ?? []), current.current];
          onChange();
        }
        current.current = null;
        drawing.current = false;
        draw();
      }}
      onPointerLeave={() => {
        if (drawing.current && current.current && current.current.points.length > 0) {
          strokesRef.current = [...(strokesRef.current ?? []), current.current];
          onChange();
          current.current = null;
        }
        drawing.current = false;
        draw();
      }}
    />
  );
}

// ── Panel: existing signatures + pad ──

export function IrmsSignaturePanel({
  reportId,
  canManage,
  isOwner,
}: {
  reportId: string;
  canManage: boolean;
  isOwner: boolean;
}) {
  const { toast } = useToast();
  const [signatures, setSignatures] = useState<IrmsSignature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // pad state
  const strokesRef = useRef<Stroke[]>([]);
  const [hasInk, setHasInk] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("INSPECTOR");
  const [saving, setSaving] = useState(false);

  const allowedRoles = IRMS_SIGNATURE_ROLES.filter((r) => {
    if (r === "INSPECTOR") return isOwner || canManage;
    return canManage; // SUPERVISOR / MANAGER require irms.manage
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<IrmsSignature[]>(`/api/v1/irms/reports/${reportId}/signatures`);
      setSignatures(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load signatures.");
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (allowedRoles.length > 0 && !allowedRoles.includes(role as (typeof IRMS_SIGNATURE_ROLES)[number])) {
      setRole(allowedRoles[0]);
    }
  }, [allowedRoles, role]);

  const canSign = allowedRoles.length > 0;

  async function save() {
    if (!hasInk) {
      toast({ title: "Signature is empty", description: "Draw a signature in the box first.", variant: "destructive" });
      return;
    }
    if (!name.trim()) {
      toast({ title: "Enter the signer's name", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const canvas = document.querySelector<HTMLCanvasElement>("canvas[aria-label='Signature drawing area']");
      if (!canvas) throw new Error("Signature canvas is unavailable.");
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
      if (!blob) throw new Error("Could not export the signature image.");
      const form = new FormData();
      form.set("role", role);
      form.set("name", name.trim());
      form.set("image", blob, "signature.png");
      const res = await fetch(`/api/v1/irms/reports/${reportId}/signatures`, {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      if (!res.ok) {
        let msg = `Upload failed (${res.status})`;
        try {
          const body = await res.json();
          if (body?.error?.message) msg = body.error.message;
        } catch { /* non-JSON */ }
        throw new Error(msg);
      }
      toast({ title: "Signature saved", description: `${name.trim()} signed as ${humanize(role)}.` });
      strokesRef.current = [];
      setHasInk(false);
      setName("");
      await load();
    } catch (e) {
      toast({ title: "Could not save signature", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Existing signatures */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Signatures</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingState label="Loading signatures…" rows={1} />
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : !signatures || signatures.length === 0 ? (
            <EmptyState title="No signatures yet" hint="Signed signatures appear here with their history." />
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {signatures.map((s) => (
                <li key={s.id} className="rounded-lg border p-3 bg-muted/20">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <Badge variant="outline" className="bg-primary/5 border-primary/30">{humanize(s.role)}</Badge>
                    <span className="text-xs text-muted-foreground">{fmtDateTime(s.signedAt)}</span>
                  </div>
                  { }
                  <img
                    src={s.url}
                    alt={`Signature of ${s.name}`}
                    className="h-16 w-full rounded border bg-white object-contain"
                    loading="lazy"
                  />
                  <p className="mt-2 text-sm font-medium">{s.name}</p>
                  {typeof s.revision === "number" ? (
                    <p className="text-xs text-muted-foreground">Rev {s.revision}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Signature pad */}
      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <PenTool className="h-4 w-4 text-primary" aria-hidden /> Add a signature
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!canSign ? (
            <p className="text-sm text-muted-foreground">
              You are not authorized to sign this report. The inspector (report owner) or a manager can sign here.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`sig-name-${reportId}`}>Signer name *</Label>
                  <Input
                    id={`sig-name-${reportId}`}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Signing as</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger aria-label="Signature role"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {allowedRoles.map((r) => (
                        <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <SignatureCanvas
                strokesRef={strokesRef}
                onChange={() => setHasInk((strokesRef.current ?? []).length > 0)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => { strokesRef.current = strokesRef.current?.slice(0, -1) ?? []; setHasInk((strokesRef.current ?? []).length > 0); }}
                  disabled={!hasInk || saving}
                  aria-label="Undo last stroke"
                >
                  <Undo2 className="h-4 w-4" /> Undo
                </Button>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => { strokesRef.current = []; setHasInk(false); }}
                  disabled={!hasInk || saving}
                  aria-label="Clear signature"
                >
                  <Eraser className="h-4 w-4" /> Clear
                </Button>
                <Button
                  type="button" size="sm" className={cn("ml-auto min-h-[44px] sm:min-h-0")}
                  onClick={() => void save()} disabled={saving || !hasInk}
                >
                  {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <PenTool className="h-4 w-4 mr-1.5" />}
                  {saving ? "Saving…" : "Save signature"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Works with mouse, touch and stylus. Each save is kept as history — signatures are never overwritten.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
