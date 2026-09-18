// MOHD.HMS ENTERPRISE — Automation settings (§36/§37/§103).
// Single source of truth for every configurable automation. Stored in the existing
// `Setting` table (PostgreSQL-authoritative in production); values are cached
// in-memory for 60s and invalidated after each write. Every automation can be
// turned ON/OFF (§37) and thresholds/intervals are configurable (§36) — nothing
// is hardcoded that administrators may need to tune.

import "server-only";
import { db } from "@/lib/db";

export const AUTOMATION_SETTING_DEFAULTS = {
  /** §68: complaint confirmed → create ONE draft invoice for finance review. */
  auto_invoice_on_confirm: "on",
  /** §68: standalone billable work order completed → draft invoice (no linked complaint). */
  auto_invoice_on_wo_complete: "on",
  /** §13: technician acceptance of a complaint without a work order → auto-create WO. */
  auto_work_order_on_accept: "on",
  /** §20: scheduler generates PM tasks from due plans automatically. */
  auto_pm_task_generation: "on",
  /** §17: low-stock alerts to inventory/procurement users. */
  low_stock_alerts: "on",
  /** §34/§62: escalation engine (unaccepted complaints, overdue WOs, stuck flows). */
  escalation_engine: "on",
  /** §59: SLA response-target tracking per complaint priority. */
  sla_engine: "on",
  /** §22: mark SENT invoices OVERDUE past due date + notify finance. */
  invoice_overdue_automation: "on",
  /** §30: email queue (logged deliveries; provider integration point). */
  email_notifications: "off",
  /** §31/§32: outbound channels — enabled only when a provider is configured. */
  whatsapp_notifications: "off",
  push_notifications: "off",
  /** §21: PM reminder days before due date (comma separated). */
  pm_reminder_days: "30,14,7,1",
  /** §34: hours a complaint may sit ASSIGNED before supervisor escalation. */
  complaint_accept_escalation_hours: "4",
  /** §34: days a work order may stay IN_PROGRESS before supervisor escalation. */
  wo_overdue_escalation_days: "2",
  /** §59: SLA response targets (hours) per priority, JSON object. */
  sla_targets_hours: '{"URGENT":2,"HIGH":8,"MEDIUM":24,"LOW":72}',
} as const;

export type AutomationSettingKey = keyof typeof AUTOMATION_SETTING_DEFAULTS;

const CACHE_TTL_MS = 60_000;
let cache: { at: number; values: Record<string, string> } | null = null;

export async function getAutomationSettings(): Promise<Record<string, string>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.values;
  const rows = await db.setting.findMany({ where: { key: { startsWith: "automation." } } });
  const values: Record<string, string> = { ...AUTOMATION_SETTING_DEFAULTS };
  for (const row of rows) {
    const shortKey = row.key.replace("automation.", "");
    if (shortKey in AUTOMATION_SETTING_DEFAULTS && row.value !== "") values[shortKey] = row.value;
  }
  cache = { at: Date.now(), values };
  return values;
}

export async function getAutomationSetting(key: AutomationSettingKey): Promise<string> {
  const all = await getAutomationSettings();
  return all[key] ?? AUTOMATION_SETTING_DEFAULTS[key];
}

export async function isAutomationEnabled(key: AutomationSettingKey): Promise<boolean> {
  return (await getAutomationSetting(key)) === "on";
}

export async function updateAutomationSettings(updates: Record<string, string>): Promise<Record<string, string>> {
  const valid = new Set(Object.keys(AUTOMATION_SETTING_DEFAULTS));
  const entries = Object.entries(updates).filter(([k, v]) => valid.has(k) && typeof v === "string" && v.length <= 500);
  for (const [key, value] of entries) {
    await db.setting.upsert({
      where: { key: `automation.${key}` },
      update: { value },
      create: { key: `automation.${key}`, value },
    });
  }
  cache = null;
  return getAutomationSettings();
}

/** Numeric helper with safe fallback. */
export async function automationNumber(key: AutomationSettingKey, fallback: number): Promise<number> {
  const raw = await getAutomationSetting(key);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parsed PM reminder days helper (§21). */
export async function pmReminderDays(): Promise<number[]> {
  const raw = await getAutomationSetting("pm_reminder_days");
  const days = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return days.length ? [...new Set(days)].sort((a, b) => b - a) : [30, 14, 7, 1];
}

/** SLA target map helper (§59). */
export async function slaTargetsHours(): Promise<Record<string, number>> {
  const raw = await getAutomationSetting("sla_targets_hours");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      }
      return out;
    }
  } catch {
    // fall through to default
  }
  return { URGENT: 2, HIGH: 8, MEDIUM: 24, LOW: 72 };
}
