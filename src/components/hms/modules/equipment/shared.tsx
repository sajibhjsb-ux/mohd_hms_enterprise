"use client";

// MOHD.HMS ENTERPRISE — Equipment module shared pieces.
// Extracted from the former monolithic index so the dedicated pages
// (new / edit / detail / label) and the list can reuse them without
// circular imports:
//   • row/detail/QR types
//   • shared create-edit form field renderer (payloadFor + validation mapping)
//   • maintenance-history section (moved from the old detail dialog)

import type { ReactNode } from "react";
import { ClientApiError } from "@/lib/hms/api-client";
import { customerLabel } from "@/lib/hms/format";
import { StatusBadge } from "@/components/hms/shared/ui-bits";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ── Types ──

export type EquipmentCore = {
  id: string; assetTag: string; name: string; serialNumber: string;
  manufacturer: string; model: string; category: string; status: string;
  installationDate: string | null; warrantyExpiry: string | null;
  pmFrequencyDays: number; qrToken: string; notes: string; createdAt: string;
  customerId: string | null;
  location: { id: string; name: string; code: string } | null;
  customer: { id: string; companyName: string; code: string; contactPerson?: string } | null;
};

/** Row shape returned by GET /api/v1/equipment (list). */
export type EquipmentRow = EquipmentCore & {
  _count: { complaints: number; workOrders: number; pmTasks: number };
};

/** Detail shape returned by GET /api/v1/equipment/{id} — includes history. */
export type EquipmentDetail = EquipmentCore & {
  history: {
    complaints: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
    workOrders: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
    pmTasks: { id: string; code: string; dueDate: string; status: string; completedAt: string | null }[];
    inspections: { id: string; code: string; title: string; type: string; status: string; overallCondition: string; inspectionDate: string }[];
  };
};

export type QrData = { equipmentId: string; assetTag: string; name: string; url: string; dataUrl: string };

export type CustomerOption = { id: string; companyName: string; code: string; contactPerson?: string };
export type LocationOption = { id: string; name: string; code: string };

export type FormState = {
  name: string; serialNumber: string; manufacturer: string; model: string; category: string;
  customerId: string; locationId: string; installationDate: string; warrantyExpiry: string;
  pmFrequencyDays: string; notes: string;
};

export const EMPTY_FORM: FormState = {
  name: "", serialNumber: "", manufacturer: "", model: "", category: "",
  customerId: "", locationId: "", installationDate: "", warrantyExpiry: "",
  pmFrequencyDays: "90", notes: "",
};

export const CATEGORIES = ["HVAC", "ELECTRICAL", "PLUMBING", "LIFT", "FIRE_SAFETY", "SECURITY", "GENERAL"];

/** Build the create/update payload from the shared form state. */
export function payloadFor(f: FormState) {
  return {
    name: f.name,
    serialNumber: f.serialNumber || undefined,
    manufacturer: f.manufacturer || undefined,
    model: f.model || undefined,
    category: f.category || undefined,
    customerId: f.customerId || null,
    locationId: f.locationId || null,
    installationDate: f.installationDate || undefined,
    warrantyExpiry: f.warrantyExpiry || undefined,
    pmFrequencyDays: f.pmFrequencyDays === "" ? undefined : Number(f.pmFrequencyDays),
    notes: f.notes || undefined,
  };
}

// ── Server zod error mapping (kept from the popup implementation) ──

export type FieldErrors = Record<string, string>;

export function extractFieldErrors(e: unknown): FieldErrors {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: FieldErrors = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}

export function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

// ── Shared create/edit field renderer (identical fields in both pages) ──

type FieldsProps = {
  f: FormState;
  set: (patch: Partial<FormState>) => void;
  errs: FieldErrors;
  idp: string;
  customers: CustomerOption[];
  locations: LocationOption[];
  locationsAvailable: boolean | null;
};

export function EquipmentFormFields({ f, set, errs, idp, customers, locations, locationsAvailable }: FieldsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="sm:col-span-2">
        <Label htmlFor={`${idp}-name`}>Equipment name *</Label>
        <Input id={`${idp}-name`} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Chiller #1 — Level 3 Plant Room" />
        <FieldError msg={errs.name} />
      </div>
      <div>
        <Label htmlFor={`${idp}-serial`}>Serial number</Label>
        <Input id={`${idp}-serial`} value={f.serialNumber} onChange={(e) => set({ serialNumber: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-category`}>Category</Label>
        <Select value={f.category || "GENERAL"} onValueChange={(v) => set({ category: v })}>
          <SelectTrigger id={`${idp}-category`}><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idp}-manu`}>Manufacturer</Label>
        <Input id={`${idp}-manu`} value={f.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-model`}>Model</Label>
        <Input id={`${idp}-model`} value={f.model} onChange={(e) => set({ model: e.target.value })} />
      </div>
      <div>
        <Label htmlFor={`${idp}-cust`}>Customer</Label>
        <Select value={f.customerId || "none"} onValueChange={(v) => set({ customerId: v === "none" ? "" : v })}>
          <SelectTrigger id={`${idp}-cust`}><SelectValue placeholder="Unassigned" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— Unassigned —</SelectItem>
            {customers.map((c) => <SelectItem key={c.id} value={c.id}>{customerLabel(c)}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldError msg={errs.customerId} />
      </div>
      <div>
        <Label htmlFor={`${idp}-loc`}>Location</Label>
        {locationsAvailable === false ? (
          <p className="text-sm text-muted-foreground pt-2">Locations module not available yet.</p>
        ) : (
          <Select value={f.locationId || "none"} onValueChange={(v) => set({ locationId: v === "none" ? "" : v })}>
            <SelectTrigger id={`${idp}-loc`}><SelectValue placeholder="No location" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— No location —</SelectItem>
              {locations.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <FieldError msg={errs.locationId} />
      </div>
      <div>
        <Label htmlFor={`${idp}-inst`}>Installation date</Label>
        <Input id={`${idp}-inst`} type="date" value={f.installationDate} onChange={(e) => set({ installationDate: e.target.value })} />
        <FieldError msg={errs.installationDate} />
      </div>
      <div>
        <Label htmlFor={`${idp}-warr`}>Warranty expiry</Label>
        <Input id={`${idp}-warr`} type="date" value={f.warrantyExpiry} onChange={(e) => set({ warrantyExpiry: e.target.value })} />
        <FieldError msg={errs.warrantyExpiry} />
      </div>
      <div>
        <Label htmlFor={`${idp}-pm`}>PM cycle (days)</Label>
        <Input id={`${idp}-pm`} inputMode="numeric" value={f.pmFrequencyDays} onChange={(e) => set({ pmFrequencyDays: e.target.value.replace(/\D/g, "") })} />
        <FieldError msg={errs.pmFrequencyDays} />
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor={`${idp}-notes`}>Notes</Label>
        <Textarea id={`${idp}-notes`} rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="Capacity, access notes…" />
      </div>
    </div>
  );
}

// ── Maintenance history section (moved from the old detail dialog) ──

export type HistoryItem = {
  id: string; code: string; primary: string; badge: string; secondary: string; badge2?: string;
  /** When set, the row renders as a link to the item's dedicated detail page. */
  href?: string;
};

export function HistorySection({ icon, title, items, empty }: { icon: ReactNode; title: string; items: HistoryItem[]; empty: string }) {
  return (
    <div>
      <p className="text-sm font-medium mb-2 flex items-center gap-1.5">{icon} {title} <span className="text-muted-foreground font-normal">({items.length})</span></p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {items.map((it) => {
            const row = (
              <>
                <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{it.code}</span>
                <span className="flex-1 min-w-0 truncate text-sm">{it.primary}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:block">{it.secondary}</span>
                {it.badge2 ? <StatusBadge status={it.badge2} /> : null}
                <StatusBadge status={it.badge} />
              </>
            );
            const rowClass = "flex items-center gap-3 px-3 py-2 min-w-0";
            return it.href ? (
              <a key={it.id} href={it.href} className={`${rowClass} hover:bg-accent/60 focus:bg-accent focus:outline-none transition-colors`}>
                {row}
              </a>
            ) : (
              <div key={it.id} className={rowClass}>{row}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
