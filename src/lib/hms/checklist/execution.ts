// MOHD.HMS ENTERPRISE — Pure checklist execution rules.
// No database, no side effects except explicit authorization throws. Used by
// Work Order item routes, the transition route, and tests.

import "server-only";
import { Errors } from "@/lib/hms/api";

export type ChecklistExecutionItem = {
  id: string;
  label: string;
  status: string;
  statusReason: string;
  done: boolean;
  doneAt?: Date | null;
  completedById?: string | null;
  required: boolean;
  responseType: string;
  response: string;
  notes: string;
  requiresPhoto: boolean;
  failRequiresFinding: boolean;
  safetyCritical?: boolean;
  group?: string;
  priority?: string;
  expectedResult?: string;
  unit?: string;
  removedAt?: Date | string | null;
};

export type ChecklistPhotoCounts = Record<string, number>;

export type ChecklistItemUpdatePatch = {
  label?: string;
  group?: string;
  priority?: string;
  expectedResult?: string;
  unit?: string;
  notes?: string;
  response?: string;
  status?: string;
  statusReason?: string;
  done?: boolean;
  required?: boolean;
  safetyCritical?: boolean;
  responseType?: string;
};

export type ChecklistItemUpdateResult = {
  data: Record<string, unknown>;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
};

const VALID_STATUSES = ["PENDING", "IN_PROGRESS", "COMPLETED", "NOT_APPLICABLE", "BLOCKED"];
const SUPERVISOR_ONLY_FIELDS = ["required", "safetyCritical", "responseType"] as const;

function isRemoved(item: ChecklistExecutionItem): boolean {
  return !!item.removedAt;
}

function isSatisfied(item: ChecklistExecutionItem): boolean {
  if (item.status === "COMPLETED" || item.status === "NOT_APPLICABLE") return true;
  if (item.done === true && item.status !== "COMPLETED") return true; // legacy mirror
  return false;
}

function labelFor(item: ChecklistExecutionItem): string {
  return item.label || item.id;
}

export function validateChecklistForSubmission(
  items: ChecklistExecutionItem[],
  photoCounts: ChecklistPhotoCounts,
  mode: "START" | "SUBMIT",
): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const now = Date.now();

  for (const item of items.filter((it) => !isRemoved(it))) {
    const satisfied = isSatisfied(item);

    if (mode === "SUBMIT") {
      if (item.status === "NOT_APPLICABLE" || item.status === "BLOCKED") {
        if (!item.statusReason || !item.statusReason.trim()) {
          missing.push(`${labelFor(item)}: reason required`);
        }
      }
      if (item.failRequiresFinding && (item.response === "FAIL" || item.response === "NO") && !item.notes.trim()) {
        missing.push(`Finding note: ${labelFor(item)}`);
      }
      if (item.requiresPhoto && satisfied && (photoCounts[item.id] ?? 0) < 1) {
        missing.push(`Photo evidence: ${labelFor(item)}`);
      }
    }

    if (item.required && !satisfied) {
      missing.push(`Task result: ${labelFor(item)}`);
      continue;
    }

    if (mode === "SUBMIT" && item.required && !satisfied && item.responseType !== "CHECKBOX" && !item.response.trim()) {
      missing.push(`Task result: ${labelFor(item)}`);
    }
  }

  if (mode === "SUBMIT") {
    for (const item of items.filter((it) => !isRemoved(it) && it.requiresPhoto && isSatisfied(it))) {
      if ((photoCounts[item.id] ?? 0) < 1) {
        missing.push(`Photo evidence: ${labelFor(item)}`);
      }
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function snapshot(item: ChecklistExecutionItem, patch: ChecklistItemUpdatePatch): { previous: Record<string, unknown>; next: Record<string, unknown> } {
  const base: Record<string, unknown> = {
    id: item.id, label: item.label, status: item.status, statusReason: item.statusReason,
    done: item.done, required: item.required, responseType: item.responseType, response: item.response,
    notes: item.notes, requiresPhoto: item.requiresPhoto, failRequiresFinding: item.failRequiresFinding,
    safetyCritical: item.safetyCritical ?? false, group: item.group ?? "",
    priority: item.priority ?? "", expectedResult: item.expectedResult ?? "", unit: item.unit ?? "",
  };
  // `next` starts as a copy of the CURRENT state — it must not be pre-merged
  // with the patch. setField() compares against it to decide what actually
  // changed; pre-merging made every patched field look "already applied", so
  // status/response edits were silently dropped.
  const next: Record<string, unknown> = { ...base };
  return { previous: base, next };
}

export function resolveChecklistItemUpdate(input: {
  current: ChecklistExecutionItem & { priority?: string; expectedResult?: string; unit?: string; group?: string };
  patch: ChecklistItemUpdatePatch;
  actorId: string;
  isSupervisor: boolean;
  now: Date;
}): ChecklistItemUpdateResult {
  const { current, patch, actorId, isSupervisor, now: stamp } = input;
  const { previous, next } = snapshot(current, patch);
  const data: Record<string, unknown> = {};
  let status = current.status;

  const setField = (k: string, v: unknown) => {
    if (next[k] !== v) {
      data[k] = v;
      next[k] = v;
    }
  };

  for (const field of SUPERVISOR_ONLY_FIELDS) {
    if (patch[field] !== undefined && !isSupervisor) {
      throw Errors.forbidden(`Changing ${field} requires supervisor authorization.`);
    }
  }

  if (patch.status !== undefined) {
    const requested = String(patch.status).toUpperCase();
    if (!VALID_STATUSES.includes(requested)) {
      throw Errors.badRequest(`Invalid checklist item status: ${requested}`);
    }
    if (requested === "COMPLETED") {
      status = "COMPLETED";
      setField("done", true);
      setField("doneAt", stamp);
      setField("completedById", actorId);
    } else if (requested === "IN_PROGRESS") {
      if (current.status === "COMPLETED" && !isSupervisor) {
        throw Errors.forbidden("Reopening a completed checklist item requires supervisor authorization.");
      }
      status = "IN_PROGRESS";
      setField("done", false);
      setField("doneAt", null);
      setField("completedById", null);
    } else if (requested === "NOT_APPLICABLE" || requested === "BLOCKED") {
      if (!patch.statusReason || !patch.statusReason.trim()) {
        throw Errors.badRequest(`${requested} requires a reason.`);
      }
      status = requested;
      setField("done", false);
      setField("doneAt", null);
      setField("completedById", null);
      setField("statusReason", patch.statusReason);
    } else {
      // PENDING
      status = "PENDING";
      setField("done", false);
      setField("doneAt", null);
      setField("completedById", null);
      setField("statusReason", "");
    }
    setField("status", status);
  } else if (patch.done !== undefined) {
    setField("status", patch.done ? "COMPLETED" : "PENDING");
    if (!patch.done && current.status === "COMPLETED" && !isSupervisor) {
      throw Errors.forbidden("Reopening a completed checklist item requires supervisor authorization.");
    }
    setField("done", patch.done);
    if (patch.done) {
      setField("doneAt", stamp);
      setField("completedById", actorId);
    } else {
      setField("doneAt", null);
      setField("completedById", null);
    }
  }

  // Response/notes edits only advance PENDING -> IN_PROGRESS; never auto-complete.
  if ((patch.response !== undefined || patch.notes !== undefined) && status === "PENDING") {
    setField("status", "IN_PROGRESS");
    setField("done", false);
    setField("doneAt", null);
    setField("completedById", null);
  }

  for (const k of ["label", "group", "priority", "expectedResult", "unit", "notes", "response", "statusReason"]) {
    if (patch[k] !== undefined && patch[k] !== current[k]) {
      setField(k, patch[k]);
    }
  }

  return { data, previous, next };
}

export function canRemoveChecklistItem(item: ChecklistExecutionItem, isSupervisor: boolean): boolean {
  if (isRemoved(item)) return false;
  if (isSupervisor) return true;
  return !item.required && !item.safetyCritical && item.status !== "COMPLETED";
}
