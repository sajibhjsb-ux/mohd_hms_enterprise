import "server-only";

// MOHD.HMS ENTERPRISE — per-user notification preferences (spec §19).
// Categories mirror the business domains. Storage: the NotificationPreference
// row (JSON `channels` map category → { push, email, whatsapp }). Legacy boolean
// values in the same map (`{ "<CATEGORY>": true }`) still read as push-only.
// Absent category or row ⇒ all channels enabled (opt-out model, matching the
// existing notification UX).
//
// In-app is always created (it is the application's own record). The channel
// preferences here govern the PUSH / EMAIL / WHATSAPP outbound channels.

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

// ---- per-channel preferences (push / email / whatsapp) ---------------------

export type ChannelPref = {
  push: boolean;
  email: boolean;
  whatsapp: boolean;
};

/** Partial per-channel map (only categories present in the payload/row). */
export type ChannelPrefMap = Partial<Record<PushCategory, ChannelPref>>;

export type EffectiveChannelPrefs = Record<PushCategory, ChannelPref>;

function parseChannelMap(raw: string): ChannelPrefMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ChannelPrefMap = {};
    for (const cat of PUSH_CATEGORIES) {
      const v = parsed[cat];
      if (typeof v === "boolean") {
        out[cat] = { push: v, email: true, whatsapp: true };
      } else if (v && typeof v === "object") {
        const cv = v as { push?: unknown; email?: unknown; whatsapp?: unknown };
        out[cat] = {
          push: typeof cv.push === "boolean" ? cv.push : true,
          email: typeof cv.email === "boolean" ? cv.email : true,
          whatsapp: typeof cv.whatsapp === "boolean" ? cv.whatsapp : true,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Effective per-channel preferences for every category (default: all enabled). */
export async function getEffectiveChannelPrefs(userId: string): Promise<EffectiveChannelPrefs> {
  const defaults = {} as EffectiveChannelPrefs;
  for (const cat of PUSH_CATEGORIES) defaults[cat] = { push: true, email: true, whatsapp: true };
  try {
    const row = await db.notificationPreference.findUnique({ where: { userId }, select: { channels: true } });
    if (row) {
      const map = parseChannelMap(row.channels);
      for (const cat of PUSH_CATEGORIES) {
        const p = map[cat];
        if (p) defaults[cat] = p;
      }
    }
  } catch {
    /* defaults */
  }
  return defaults;
}

/** Validate + normalize a client-supplied per-channel preference payload. */
export function sanitizeChannelPrefInput(input: unknown): ChannelPrefMap {
  const out: ChannelPrefMap = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(PUSH_CATEGORIES as readonly string[]).includes(k)) continue;
    const cat = k as PushCategory;
    if (typeof v === "boolean") {
      out[cat] = { push: v, email: true, whatsapp: true };
      continue;
    }
    if (v && typeof v === "object") {
      const cv = v as { push?: unknown; email?: unknown; whatsapp?: unknown };
      if (typeof cv.push === "boolean" || typeof cv.email === "boolean" || typeof cv.whatsapp === "boolean") {
        out[cat] = {
          push: typeof cv.push === "boolean" ? cv.push : true,
          email: typeof cv.email === "boolean" ? cv.email : true,
          whatsapp: typeof cv.whatsapp === "boolean" ? cv.whatsapp : true,
        };
      }
    }
  }
  return out;
}

/** Merge + persist per-channel preferences (keeps the existing boolean format readable). */
export async function saveChannelPrefs(userId: string, prefs: ChannelPrefMap): Promise<void> {
  const existing = await db.notificationPreference.findUnique({ where: { userId }, select: { channels: true } });
  const merged: Record<string, ChannelPref> = { ...parseChannelMap(existing?.channels ?? "") };
  for (const [k, p] of Object.entries(prefs)) merged[k] = p as ChannelPref;
  await db.notificationPreference.upsert({
    where: { userId },
    create: { userId, channels: JSON.stringify(merged) },
    update: { channels: JSON.stringify(merged) },
  });
}
