import "server-only";

// MOHD.HMS ENTERPRISE — per-user push notification preferences (spec §19).
// Categories mirror the business domains. Storage: the NotificationPreference
// row (JSON `channels` map category → { push: boolean }). Absent category or
// row ⇒ push enabled (opt-out model, matching the existing notification UX).
//
// Scope: preferences gate the PUSH channel only. In-app is always created (it
// is the application's own record), and Email/WhatsApp remain governed by the
// existing business rules + automation toggles — nothing existing is bypassed.

import { db } from "@/lib/db";

export const PUSH_CATEGORIES = [
  "COMPLAINTS",
  "WORK_ORDERS",
  "PM",
  "INVOICES",
  "QUOTATIONS",
  "PAYMENTS",
  "EQUIPMENT",
  "IRMS",
  "HR",
  "SYSTEM_ALERTS",
] as const;

export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export const PUSH_CATEGORY_LABELS: Record<PushCategory, string> = {
  COMPLAINTS: "Complaints",
  WORK_ORDERS: "Work Orders",
  PM: "Preventive Maintenance",
  INVOICES: "Invoices",
  QUOTATIONS: "Quotations",
  PAYMENTS: "Payments",
  EQUIPMENT: "Equipment",
  IRMS: "IRMS Inspections",
  HR: "HR & Letters",
  SYSTEM_ALERTS: "System Alerts",
};

/** resourceType (Notification.resourceType) → preference category. */
export function resolvePushCategory(resourceType: string): PushCategory {
  switch (resourceType) {
    case "COMPLAINT": return "COMPLAINTS";
    case "WORK_ORDER": return "WORK_ORDERS";
    case "PM_PLAN":
    case "PM_TASK":
    case "PM_METER":
      return "PM";
    case "INVOICE": return "INVOICES";
    case "QUOTATION": return "QUOTATIONS";
    case "PAYMENT": return "PAYMENTS";
    case "EQUIPMENT": return "EQUIPMENT";
    case "INSPECTION_REPORT":
    case "IRMS_PROJECT":
      return "IRMS";
    case "EMPLOYEE":
    case "HR_LEAVE":
    case "HR_LETTER":
      return "HR";
    default: return "SYSTEM_ALERTS";
  }
}

export type PushPrefMap = Partial<Record<PushCategory, boolean>>;

function parsePrefMap(raw: string): PushPrefMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: PushPrefMap = {};
    for (const cat of PUSH_CATEGORIES) {
      const v = parsed[cat];
      if (typeof v === "boolean") out[cat] = v;
      else if (v && typeof v === "object" && typeof (v as { push?: unknown }).push === "boolean") {
        out[cat] = (v as { push: boolean }).push;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Effective push preference for a category (default: enabled). */
export async function pushPrefEnabled(userId: string, category: PushCategory): Promise<boolean> {
  try {
    const row = await db.notificationPreference.findUnique({ where: { userId }, select: { channels: true } });
    if (!row) return true;
    const map = parsePrefMap(row.channels);
    return map[category] !== false;
  } catch {
    return true; // preference lookup must never block a notification
  }
}

/** Full effective map for settings UI (all categories present). */
export async function getEffectivePrefs(userId: string): Promise<Record<PushCategory, boolean>> {
  const out = {} as Record<PushCategory, boolean>;
  for (const cat of PUSH_CATEGORIES) out[cat] = true;
  try {
    const row = await db.notificationPreference.findUnique({ where: { userId }, select: { channels: true } });
    if (row) {
      const map = parsePrefMap(row.channels);
      for (const cat of PUSH_CATEGORIES) if (map[cat] === false) out[cat] = false;
    }
  } catch { /* defaults */ }
  return out;
}

/** Validate + normalize a client-supplied preference payload. */
export function sanitizePrefInput(input: unknown): PushPrefMap {
  const out: PushPrefMap = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(PUSH_CATEGORIES as readonly string[]).includes(k)) continue;
    if (typeof v === "boolean") out[k as PushCategory] = v;
    else if (v && typeof v === "object" && typeof (v as { push?: unknown }).push === "boolean") {
      out[k as PushCategory] = (v as { push: boolean }).push;
    }
  }
  return out;
}

export async function savePrefs(userId: string, prefs: PushPrefMap): Promise<void> {
  // Merge into the existing row so unknown future categories are preserved.
  const existing = await db.notificationPreference.findUnique({ where: { userId }, select: { channels: true } });
  const merged = { ...parsePrefMap(existing?.channels ?? ""), ...prefs };
  await db.notificationPreference.upsert({
    where: { userId },
    create: { userId, channels: JSON.stringify(merged) },
    update: { channels: JSON.stringify(merged) },
  });
}
