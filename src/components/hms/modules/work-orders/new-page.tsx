"use client";

// MOHD.HMS ENTERPRISE — dedicated Work Order Entry page (work-orders/new view).
// Replaces the former "New Work Order" modal. Same API (POST /api/v1/work-orders),
// same draft protection (formKey "workorder.create"), same validation and
// materials/checklist input — no popup, no duplicate APIs, no mock data.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS, PRIORITIES, humanize } from "@/lib/hms/constants";
import { fmtDateTime, money, toCents } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, Loader2, Plus, Trash2, Wrench } from "lucide-react";

// ── Types ──

type TechOpt = { id: string; employeeNo?: string; specialty?: string; user?: { name?: string } | null };
type CustomerOpt = { id: string; companyName?: string; name?: string };
type EquipmentOpt = { id: string; name?: string; assetTag?: string };
type ComplaintOpt = { id: string; code: string; title: string; customer?: { id: string; companyName?: string } | null };

type WOMaterialForm = { name: string; qty: string; cost: string };
type WOCreateForm = {
  title: string;
  description: string;
  customerId: string;
  equipmentId: string;
  complaintId: string;
  technicianId: string;
  priority: string;
  scheduledDate: string;
  checklistText: string;
  materials: WOMaterialForm[];
};

const EMPTY_CREATE: WOCreateForm = {
  title: "", description: "", customerId: "", equipmentId: "", complaintId: "",
  technicianId: "", priority: "MEDIUM", scheduledDate: "", checklistText: "", materials: [],
};

// ── Page ──

export function WorkOrderNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canCreate = hasPerm(user, PERMISSIONS.work_orders_create);

  const draft = useDraft<WOCreateForm>({ formKey: "workorder.create", initial: EMPTY_CREATE });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Reference data — loaded on page mount (formerly on dialog open) ──
  const [customers, setCustomers] = useState<CustomerOpt[]>([]);
  const [techs, setTechs] = useState<TechOpt[]>([]);
  const [openComplaints, setOpenComplaints] = useState<ComplaintOpt[]>([]);
  const [refsLoading, setRefsLoading] = useState(true);

  useEffect(() => {
    if (!canCreate) return;
    let alive = true;
    Promise.all([
      api.get<CustomerOpt[]>(`/api/v1/customers${qs({ pageSize: 200 })}`).catch(() => null),
      api.get<TechOpt[]>(`/api/v1/technicians${qs({ pageSize: 200 })}`).catch(() => null),
      api.get<ComplaintOpt[]>(`/api/v1/complaints${qs({ status: "IN_PROGRESS", pageSize: 200 })}`).catch(() => null),
    ]).then(([c, t, cmp]) => {
      if (!alive) return;
      setCustomers(c && Array.isArray(c.data) ? c.data : []);
      setTechs(t && Array.isArray(t.data) ? t.data : []);
      setOpenComplaints(cmp && Array.isArray(cmp.data) ? cmp.data : []);
      setRefsLoading(false);
    });
    return () => { alive = false; };
  }, [canCreate]);

  // ── Equipment follows the selected customer (server-filtered) ──
  const [equipment, setEquipment] = useState<EquipmentOpt[]>([]);
  const [equipLoading, setEquipLoading] = useState(false);
  const [equipLoaded, setEquipLoaded] = useState(false);

  useEffect(() => {
    if (!canCreate) return;
    if (!draft.value.customerId) { setEquipment([]); setEquipLoaded(true); return; }
    let alive = true;
    setEquipLoading(true);
    setEquipLoaded(false);
    api.get<EquipmentOpt[]>(`/api/v1/equipment${qs({ customerId: draft.value.customerId, pageSize: 200 })}`)
      .then((r) => { if (alive) setEquipment(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setEquipment([]); })
      .finally(() => { if (alive) { setEquipLoading(false); setEquipLoaded(true); } });
    return () => { alive = false; };
  }, [canCreate, draft.value.customerId]);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  function goBackToList() {
    draft.saveNow(); // silent protection — never lose typed data when leaving via Back
    navigateTo("work-orders");
  }

  const updateMaterialRow = useCallback((index: number, patch: Partial<WOMaterialForm>) => {
    draft.setValue({
      materials: draft.value.materials.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    });
  }, [draft]);

  const complaintOptions = useMemo(
    () => openComplaints.filter(
      (c) => !draft.value.customerId || c.customer?.id === draft.value.customerId
    ),
    [openComplaints, draft.value.customerId]
  );

  const estimatedMaterialsCents = useMemo(
    () => draft.value.materials.reduce(
      (s, m) => s + (Number(m.qty) > 0 ? Math.round(Number(m.qty) * toCents(m.cost || "0")) : 0),
      0
    ),
    [draft.value.materials]
  );

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const t = draft.value.title.trim();
    if (!t) errs.title = "Title is required.";
    else if (t.length < 3) errs.title = "Title must be at least 3 characters.";
    if (!draft.value.customerId) errs.customerId = "Please select a customer.";
    return errs;
  }

  async function submitCreate() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the form", description: Object.values(errs)[0], variant: "destructive" });
      return;
    }
    const v = draft.value;
    const materials = v.materials
      .filter((m) => m.name.trim() && Number(m.qty) > 0)
      .map((m) => ({ name: m.name.trim(), quantity: Number(m.qty), unitCostCents: toCents(m.cost || "0") }));
    const checklist = v.checklistText.split("\n").map((s) => s.trim()).filter(Boolean);

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ id: string; code: string }>("/api/v1/work-orders", {
        title: v.title.trim(),
        description: v.description.trim() || undefined,
        customerId: v.customerId,
        equipmentId: v.equipmentId || undefined,
        complaintId: v.complaintId || undefined,
        technicianId: v.technicianId || undefined,
        priority: v.priority,
        scheduledDate: v.scheduledDate || undefined,
        checklist,
        materials,
      });
      toast({ title: "Work order created", description: `${res.data.code} created successfully.` });
      draft.reset(EMPTY_CREATE);
      setPageDirty(false);
      // Continue the workflow on the work order's dedicated detail page.
      navigateTo("work-orders", [res.data.id]);
    } catch (e) {
      // CRITICAL: keep every user-entered value on failure — show the error and allow retry.
      const msg = e instanceof Error ? e.message : "Could not create the work order. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create work order", description: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  if (!canCreate) {
    return (
      <EmptyState
        title="You don't have permission to create work orders"
        hint="Work order creation is limited to authorized roles. Contact your administrator if you believe this is a mistake."
      />
    );
  }

  const createDisabled = submitting || draft.value.title.trim().length < 3 || !draft.value.customerId;

  const actions = (
    <Button onClick={submitCreate} disabled={createDisabled}>
      {submitting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wrench className="h-4 w-4 mr-1.5" />}
      {submitting ? "Creating…" : "Create Work Order"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Work Orders"
      backHref="#/work-orders"
      crumbs={[{ label: "Work Orders", href: "#/work-orders" }, { label: "New Work Order" }]}
      title="New Work Order"
      description="Dispatch a job to a technician. Checklist lines and materials can also be added later."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      {/* Recoverable draft banner */}
      {draft.draftExists ? (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-sm">
          <span className="text-muted-foreground">
            Unsubmitted draft saved {draft.lastSavedAt ? fmtDateTime(draft.lastSavedAt) : "earlier"} — restore it to continue where you left off.
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={draft.restore}>Restore</Button>
            <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
          </div>
        </div>
      ) : null}

      {submitError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">The work order could not be created.</p>
            <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-5 pt-1">
        {/* ── Job information (main column) ── */}
        <Card className="xl:col-span-3 shadow-sm h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Job Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="wo-title">Title *</Label>
              <Input
                id="wo-title"
                value={draft.value.title}
                onChange={(e) => { draft.setValue({ title: e.target.value }); setErrors((p) => ({ ...p, title: "" })); }}
                placeholder="What needs to be done"
                maxLength={200}
                aria-invalid={!!errors.title}
                aria-describedby={errors.title ? "wo-title-err" : undefined}
              />
              {errors.title ? <p id="wo-title-err" className="text-xs text-destructive">{errors.title}</p> : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wo-desc">Description</Label>
              <Textarea
                id="wo-desc"
                value={draft.value.description}
                onChange={(e) => draft.setValue({ description: e.target.value })}
                placeholder="Scope, access notes, safety requirements…"
                rows={4}
                maxLength={5000}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Customer *</Label>
                <Select
                  value={draft.value.customerId}
                  onValueChange={(v) => { draft.setValue({ customerId: v, equipmentId: "", complaintId: "" }); setErrors((p) => ({ ...p, customerId: "" })); }}
                >
                  <SelectTrigger aria-label="Customer" aria-invalid={!!errors.customerId}>
                    <SelectValue placeholder={refsLoading ? "Loading customers…" : "Select customer…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => <SelectItem key={c.id} value={c.id}>{c.companyName ?? c.name ?? c.id}</SelectItem>)}
                  </SelectContent>
                </Select>
                {errors.customerId ? <p className="text-xs text-destructive">{errors.customerId}</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label>Equipment</Label>
                <Select value={draft.value.equipmentId} onValueChange={(v) => draft.setValue({ equipmentId: v })}>
                  <SelectTrigger aria-label="Equipment">
                    <SelectValue placeholder={
                      draft.value.customerId
                        ? equipLoading
                          ? "Loading equipment…"
                          : equipLoaded && equipment.length === 0
                            ? "No equipment available"
                            : "Optional…"
                        : "Select a customer first…"
                    } />
                  </SelectTrigger>
                  <SelectContent>
                    {equipment.map((e) => <SelectItem key={e.id} value={e.id}>{e.name ?? e.id}{e.assetTag ? ` (${e.assetTag})` : ""}</SelectItem>)}
                  </SelectContent>
                </Select>
                {draft.value.customerId && equipLoading ? (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading equipment…</p>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Linked complaint</Label>
              <Select value={draft.value.complaintId} onValueChange={(v) => draft.setValue({ complaintId: v })}>
                <SelectTrigger aria-label="Linked complaint">
                  <SelectValue placeholder={openComplaints.length ? "Optional — link an open complaint…" : "No in-progress complaints"} />
                </SelectTrigger>
                <SelectContent>
                  {complaintOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.code} — {c.title}{c.customer?.companyName ? ` (${c.customer.companyName})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Only IN_PROGRESS complaints are offered{draft.value.customerId ? ", filtered to the selected customer" : ""}.</p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Technician</Label>
                <Select value={draft.value.technicianId} onValueChange={(v) => draft.setValue({ technicianId: v })}>
                  <SelectTrigger aria-label="Technician">
                    <SelectValue placeholder={techs.length ? "Optional — assign now…" : refsLoading ? "Loading technicians…" : "No technicians available"} />
                  </SelectTrigger>
                  <SelectContent>
                    {techs.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.user?.name ?? t.employeeNo ?? t.id}{t.specialty ? ` — ${humanize(t.specialty)}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Priority</Label>
                <Select value={draft.value.priority} onValueChange={(v) => draft.setValue({ priority: v })}>
                  <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{humanize(p)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5 sm:max-w-xs">
              <Label htmlFor="wo-scheduled">Scheduled date</Label>
              <Input id="wo-scheduled" type="date" value={draft.value.scheduledDate} onChange={(e) => draft.setValue({ scheduledDate: e.target.value })} />
            </div>
          </CardContent>
        </Card>

        {/* ── Side column: checklist + materials ── */}
        <div className="xl:col-span-2 space-y-4">
          <Card className="shadow-sm h-fit">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Checklist</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              <Label htmlFor="wo-checklist">One item per line</Label>
              <Textarea
                id="wo-checklist"
                value={draft.value.checklistText}
                onChange={(e) => draft.setValue({ checklistText: e.target.value })}
                placeholder={"Isolate & secure work area\nDiagnose fault\nFunction test"}
                rows={5}
              />
              <p className="text-[11px] text-muted-foreground">
                {draft.value.checklistText.split("\n").map((s) => s.trim()).filter(Boolean).length} item(s) will be created.
              </p>
            </CardContent>
          </Card>

          <Card className="shadow-sm h-fit">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Materials</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">Parts that will be consumed (cost in BND).</p>
                <Button
                  type="button" size="sm" variant="outline"
                  onClick={() => draft.setValue({ materials: [...draft.value.materials, { name: "", qty: "1", cost: "0" }] })}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add row
                </Button>
              </div>
              {draft.value.materials.length === 0 ? (
                <p className="text-xs text-muted-foreground rounded-lg border border-dashed p-3">No materials yet — add rows for parts that will be consumed.</p>
              ) : (
                <div className="space-y-2">
                  {draft.value.materials.map((m, i) => (
                    <div key={i} className="grid grid-cols-[1fr_72px_96px_40px] gap-2 items-center">
                      <Input value={m.name} onChange={(e) => updateMaterialRow(i, { name: e.target.value })} placeholder="Material name" maxLength={200} aria-label="Material name" />
                      <Input value={m.qty} onChange={(e) => updateMaterialRow(i, { qty: e.target.value })} placeholder="Qty" inputMode="decimal" aria-label="Quantity" />
                      <Input value={m.cost} onChange={(e) => updateMaterialRow(i, { cost: e.target.value })} placeholder="BND" inputMode="decimal" aria-label="Unit cost in BND" />
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => draft.setValue({ materials: draft.value.materials.filter((_, j) => j !== i) })} aria-label="Remove material row">
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    Estimated materials total: <span className="tabular-nums font-medium">{money(estimatedMaterialsCents)}</span>
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-sm bg-muted/20">
            <CardContent className="p-4 text-xs text-muted-foreground space-y-1.5">
              <p className="font-medium text-foreground text-sm">What happens next?</p>
              <p>On creation the work order gets a unique number (WO-…) and enters the standard workflow: <span className="font-medium">Pending → Accepted → In Progress → Completed</span> (with On Hold / Cancelled side states).</p>
              <p>Checklist, materials and labour can be maintained on the work order details while work progresses.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Autosave hint */}
      <p className="mt-3 text-xs text-muted-foreground">
        {draft.dirty
          ? "Draft auto-saves as you type — safe to leave and restore later."
          : draft.lastSavedAt
            ? `Draft saved at ${fmtDateTime(draft.lastSavedAt)}.`
            : "Tip: your entries auto-save as a draft while you type."}
      </p>

      {/* Sticky mobile action bar */}
      <div className="sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print">
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button variant="outline" className="flex-1" onClick={goBackToList} disabled={submitting}>Cancel</Button>
          <Button className="flex-1" onClick={submitCreate} disabled={createDisabled}>
            {submitting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Wrench className="h-4 w-4 mr-1.5" />}
            {submitting ? "Creating…" : "Create Work Order"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
