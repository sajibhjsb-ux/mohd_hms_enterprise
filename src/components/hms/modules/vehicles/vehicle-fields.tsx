"use client";

// MOHD.HMS ENTERPRISE — shared vehicle form fields renderer.
// Used by BOTH the dedicated Add Vehicle page and the Edit Vehicle page so the
// field definitions live in exactly one place (same labels, same selects).

import { humanize } from "@/lib/hms/constants";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const VEHICLE_TYPES = ["VAN", "TRUCK", "CAR", "PICKUP", "OTHER"];
export const VEHICLE_STATUSES = ["AVAILABLE", "IN_USE", "MAINTENANCE", "RETIRED"];

export type VehicleForm = {
  registrationNo: string;
  make: string;
  model: string;
  type: string;
  assignedTechnicianId: string;
  status: string;
  odometer: string;
  lastServiceDate: string;
  nextServiceDue: string;
  notes: string;
};

export const EMPTY_VEHICLE_FORM: VehicleForm = {
  registrationNo: "",
  make: "",
  model: "",
  type: "VAN",
  assignedTechnicianId: "",
  status: "AVAILABLE",
  odometer: "",
  lastServiceDate: "",
  nextServiceDue: "",
  notes: "",
};

export type TechOption = { id: string; label: string };

type Props = {
  form: VehicleForm;
  /** Partial update — marks the form dirty in the caller's ownership. */
  onChange: (patch: Partial<VehicleForm>) => void;
  /** null = technician list unavailable (403 for roles without users.read) → hide the select. */
  techOptions: TechOption[] | null;
  /** Edit mode additionally shows the status select. */
  isEdit: boolean;
};

export function VehicleFormFields({ form, onChange, techOptions, isEdit }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="veh-reg">Registration No *</Label>
        <Input
          id="veh-reg"
          value={form.registrationNo}
          onChange={(e) => onChange({ registrationNo: e.target.value })}
          placeholder="WXY 1234"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Type</Label>
        <Select value={form.type} onValueChange={(v) => onChange({ type: v })}>
          <SelectTrigger aria-label="Vehicle type"><SelectValue /></SelectTrigger>
          <SelectContent>
            {VEHICLE_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="veh-make">Make</Label>
        <Input id="veh-make" value={form.make} onChange={(e) => onChange({ make: e.target.value })} placeholder="Toyota" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="veh-model">Model</Label>
        <Input id="veh-model" value={form.model} onChange={(e) => onChange({ model: e.target.value })} placeholder="Hilux" />
      </div>

      {techOptions !== null ? (
        <div className="space-y-1.5">
          <Label>Assigned Technician</Label>
          <Select
            value={form.assignedTechnicianId || "NONE"}
            onValueChange={(v) => onChange({ assignedTechnicianId: v === "NONE" ? "" : v })}
          >
            <SelectTrigger aria-label="Assigned technician"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="NONE">Unassigned</SelectItem>
              {techOptions.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Assigning moves the technician off any other vehicle.</p>
        </div>
      ) : null}

      {isEdit ? (
        <div className="space-y-1.5">
          <Label>Status</Label>
          <Select value={form.status} onValueChange={(v) => onChange({ status: v })}>
            <SelectTrigger aria-label="Vehicle status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VEHICLE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="veh-odometer">Odometer (km)</Label>
        <Input
          id="veh-odometer"
          type="number"
          min={0}
          value={form.odometer}
          onChange={(e) => onChange({ odometer: e.target.value })}
          placeholder="0"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="veh-last-service">Last Service Date</Label>
        <Input
          id="veh-last-service"
          type="date"
          value={form.lastServiceDate}
          onChange={(e) => onChange({ lastServiceDate: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="veh-next-service">Next Service Due</Label>
        <Input
          id="veh-next-service"
          type="date"
          value={form.nextServiceDue}
          onChange={(e) => onChange({ nextServiceDue: e.target.value })}
        />
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="veh-notes">Notes</Label>
        <Textarea
          id="veh-notes"
          rows={3}
          value={form.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          placeholder="Service history, accessories, remarks…"
        />
      </div>
    </div>
  );
}
