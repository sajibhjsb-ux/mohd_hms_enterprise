"use client";

// MOHD.HMS ENTERPRISE — Preventive Maintenance shared pieces.
// Types + label maps + frequency description + reference-data hook +
// checklist/required-parts editors reused by the plan create page, the plan
// quick-edit dialog and the template editor. No mock data anywhere.

import { useEffect, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import {
  PM_CHECKLIST_RESPONSE_TYPES, PM_FREQUENCIES, PM_PLAN_TYPES, PM_PRIORITIES, humanize,
} from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types (mirror the frozen API contract) ──

export type CustomerRef = { id: string; companyName: string | null; contactPerson?: string | null };
export type EquipmentRef = {
  id: string; name: string; assetTag: string;
  criticality?: string | null; category?: string | null;
  customer?: CustomerRef | null;
};
export type TechnicianRef = { id: string; employeeNo: string; user: { id: string; name: string } | null };

export type ChecklistItemDef = { label: string; required: boolean; responseType: string };
export type RequiredPart = { inventoryItemId?: string | null; name: string; quantity: number; unit: string };

export type PmPlanRow = {
  id: string; code: string; name: string; description?: string;
  planType: string; frequency: string; priority: string | null;
  active: boolean; nextDueDate: string | null; lastCompletedAt: string | null;
  startDate?: string | null; endDate?: string | null;
  estimatedMinutes?: number | null;
  equipment: EquipmentRef | null;
  assignedTechnician: TechnicianRef | null;
  meter?: { id: string; name: string; unit: string; currentReading: number } | null;
  template?: { id: string; name: string } | null;
  _count?: { tasks: number };
};

export type PmTaskRow = {
  id: string; code: string; dueDate: string; status: string; priority: string | null;
  notes?: string | null; completedAt?: string | null;
  plan: { id: string; name: string; code: string; planType?: string; priority?: string | null } | null;
  equipment: (EquipmentRef & { location?: { id: string; name: string } | null }) | null;
  technician: TechnicianRef | null;
  workOrder?: { id: string; code: string; status: string; priority: string } | null;
};

export const OPEN_TASK_STATUSES = ["SCHEDULED", "OVERDUE", "IN_PROGRESS"];

// ── Label maps & helpers ──

export const PLAN_TYPE_HINTS: Record<string, string> = {
  CALENDAR: "Fixed calendar cadence (weekly, monthly, quarterly…)",
  METER: "Triggered by an equipment meter threshold",
  USAGE: "Triggered by usage meter readings",
  RUNTIME: "Triggered by runtime hours",
  CONDITION: "Calendar cadence with a condition-oriented checklist",
  SEASONAL: "Calendar cadence for seasonal servicing",
  INSPECTION: "Calendar cadence for periodic inspections",
};

export const WEEKDAY_OPTIONS = [
  { value: "0", label: "Sunday" }, { value: "1", label: "Monday" }, { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" }, { value: "4", label: "Thursday" }, { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

export const MONTHLY_OCCURRENCES = ["FIRST", "SECOND", "THIRD", "FOURTH", "LAST"] as const;
export const INTERVAL_UNITS = ["DAYS", "WEEKS", "MONTHS", "YEARS"] as const;

/** Human description of a plan's cadence (frequency + every-N + monthly recurrence). */
export function frequencyDescription(p: {
  frequency: string; customIntervalDays?: number | null; intervalUnits?: number | null;
  intervalUnit?: string | null; monthlyOccurrence?: string | null; monthlyWeekday?: number | null;
}): string {
  if (p.monthlyOccurrence && p.monthlyWeekday !== null && p.monthlyWeekday !== undefined) {
    const wd = WEEKDAY_OPTIONS[p.monthlyWeekday]?.label ?? "day";
    return `${humanize(p.monthlyOccurrence)} ${wd} of month`;
  }
  if (p.intervalUnits && p.intervalUnit) {
    return `Every ${p.intervalUnits} ${humanize(p.intervalUnit).toLowerCase()}`;
  }
  if (p.frequency === "CUSTOM" && p.customIntervalDays) {
    return `Every ${p.customIntervalDays} days`;
  }
  return humanize(p.frequency);
}

export function daysOverdue(dueDate: string | null | undefined): number {
  if (!dueDate) return 0;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const midnight = new Date(due);
  midnight.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - midnight.getTime()) / 86400000);
}

export const isTaskOpen = (status: string) => OPEN_TASK_STATUSES.includes(status);

// ── Reference data (equipment + technicians) ──

export type EquipmentOption = { id: string; label: string; criticality: string | null; hasMeters?: boolean };
export type TechnicianOption = { id: string; label: string };

export function usePmReferenceData(enabled = true) {
  const [equipment, setEquipment] = useState<EquipmentOption[] | null>(null);
  const [technicians, setTechnicians] = useState<TechnicianOption[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    (async () => {
      const [eq, tech] = await Promise.allSettled([
        api.get<EquipmentRef[]>(`/api/v1/equipment${qs({ pageSize: "200" })}`),
        api.get<TechnicianRef[]>(`/api/v1/technicians${qs({ pageSize: "200" })}`),
      ]);
      if (!alive) return;
      setEquipment(eq.status === "fulfilled" ? (eq.value.data ?? []).map((e) => ({ id: e.id, label: `${e.name} (${e.assetTag})`, criticality: e.criticality ?? null })) : null);
      setTechnicians(tech.status === "fulfilled" ? (tech.value.data ?? []).map((t) => ({ id: t.id, label: t.user?.name ? `${t.user.name} (${t.employeeNo})` : t.employeeNo })) : null);
    })();
    return () => { alive = false; };
  }, [enabled]);

  return { equipment, technicians };
}

// ── Checklist editor (plan create / template editor / template dialogs) ──

export function ChecklistEditor({
  items, onChange, disabled,
}: {
  items: ChecklistItemDef[];
  onChange: (items: ChecklistItemDef[]) => void;
  disabled?: boolean;
}) {
  const update = (i: number, patch: Partial<ChecklistItemDef>) => {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No checklist items yet — add the checks a technician must perform.</p>
      ) : null}
      {items.map((it, i) => (
        <div key={i} className={cn("rounded-lg border p-2.5", disabled && "bg-muted/30")}>
          <div className="flex items-center gap-2">
            <span className="hidden sm:flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">{i + 1}</span>
            <Input
              value={it.label}
              disabled={disabled}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="e.g. Inspect air filter condition"
              aria-label={`Checklist item ${i + 1} label`}
              className="min-h-[44px]"
            />
            {!disabled ? (
              <div className="flex items-center gap-0.5 shrink-0">
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move item ${i + 1} up`}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move item ${i + 1} down`}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => onChange(items.filter((_, idx) => idx !== i))} aria-label={`Remove item ${i + 1}`}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-0 sm:pl-8">
            <label className="flex items-center gap-1.5 text-xs font-medium cursor-pointer">
              <Checkbox checked={it.required} disabled={disabled} onCheckedChange={(v) => update(i, { required: v === true })} aria-label={`Item ${i + 1} required`} />
              Required
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Response:</span>
              <Select value={it.responseType} disabled={disabled} onValueChange={(v) => update(i, { responseType: v })}>
                <SelectTrigger className="h-8 w-[140px]" aria-label={`Item ${i + 1} response type`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PM_CHECKLIST_RESPONSE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t === "CHECKBOX" ? "Tick box" : humanize(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ))}
      {!disabled ? (
        <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => onChange([...items, { label: "", required: false, responseType: "CHECKBOX" }])}>
          <Plus className="h-4 w-4 mr-1.5" /> Add item
        </Button>
      ) : null}
    </div>
  );
}

// ── Required parts editor (plan create) ──

export type InventoryOption = { id: string; label: string; unit?: string | null };

export function useInventoryOptions() {
  const [items, setItems] = useState<InventoryOption[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.get<{ id: string; name: string; unit?: string | null }[]>(`/api/v1/inventory${qs({ pageSize: "200" })}`)
      .then((res) => { if (alive) setItems((res.data ?? []).map((i) => ({ id: i.id, label: i.name, unit: i.unit ?? null }))); })
      .catch(() => { if (alive) setItems(null); });
    return () => { alive = false; };
  }, []);
  return items;
}

export function RequiredPartsEditor({
  parts, onChange,
}: {
  parts: RequiredPart[];
  onChange: (parts: RequiredPart[]) => void;
}) {
  const inventory = useInventoryOptions();
  const update = (i: number, patch: Partial<RequiredPart>) => {
    onChange(parts.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  return (
    <div className="space-y-2">
      {parts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No required parts — add spares technicians should carry for this service.</p>
      ) : null}
      {parts.map((p, i) => (
        <div key={i} className="rounded-lg border p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <span className="hidden sm:flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums">{i + 1}</span>
            <Input
              value={p.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="Part name (e.g. Air filter 24x24)"
              aria-label={`Part ${i + 1} name`}
              className="min-h-[44px]"
            />
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-destructive hover:text-destructive" onClick={() => onChange(parts.filter((_, idx) => idx !== i))} aria-label={`Remove part ${i + 1}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-0 sm:pl-8">
            <div className="w-24">
              <Input
                inputMode="decimal"
                value={p.quantity === 0 ? "" : String(p.quantity)}
                onChange={(e) => update(i, { quantity: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })}
                placeholder="Qty"
                aria-label={`Part ${i + 1} quantity`}
                className="min-h-[44px]"
              />
            </div>
            <div className="w-24">
              <Input value={p.unit} onChange={(e) => update(i, { unit: e.target.value })} placeholder="Unit" aria-label={`Part ${i + 1} unit`} className="min-h-[44px]" />
            </div>
            <div className="flex-1 min-w-[200px]">
              <Select
                value={p.inventoryItemId || "none"}
                onValueChange={(v) => {
                  if (v === "none") { update(i, { inventoryItemId: null }); return; }
                  const inv = (inventory ?? []).find((x) => x.id === v);
                  update(i, { inventoryItemId: v, ...(inv?.unit ? { unit: inv.unit } : {}), ...(inv && !p.name ? { name: inv.label } : {}) });
                }}
              >
                <SelectTrigger aria-label={`Part ${i + 1} stock item`}>
                  <SelectValue placeholder={inventory === null ? "Stock link unavailable" : "Link stock item (optional)"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No stock link (free text)</SelectItem>
                  {(inventory ?? []).map((inv) => (
                    <SelectItem key={inv.id} value={inv.id}>{inv.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="min-h-[44px]" onClick={() => onChange([...parts, { name: "", quantity: 1, unit: "pcs", inventoryItemId: null }])}>
        <Plus className="h-4 w-4 mr-1.5" /> Add part
      </Button>
    </div>
  );
}

// ── Small shared bits ──

export function LabelValue({ label, value, className }: { label: string; value?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm font-medium truncate">{value ?? "—"}</div>
    </div>
  );
}

export const PLAN_TYPE_OPTIONS = PM_PLAN_TYPES.map((t) => ({ value: t, label: humanize(t) }));
export const FREQUENCY_OPTIONS = PM_FREQUENCIES.map((f) => ({ value: f, label: humanize(f) }));
export const PRIORITY_OPTIONS = PM_PRIORITIES.map((p) => ({ value: p, label: humanize(p) }));

export { Label };
