// MOHD.HMS ENTERPRISE — Email system bootstrap (idempotent seeding).
// Creates the canonical template catalog + default automations ONCE — only rows
// that are missing are created; admin edits are NEVER overwritten. Runs at
// server start (instrumentation → scheduler boot), guarded against races.

import "server-only";
import { db } from "@/lib/db";
import { AUTOMATION_SEEDS, TEMPLATE_CATALOG } from "./catalog";
import { registerEmailWorkflows } from "./workflows";

const g = globalThis as unknown as { __hmsEmailBooted?: boolean };

export async function bootstrapEmailSystem(): Promise<void> {
  registerEmailWorkflows(); // engine handlers — always (cheap, registry on globalThis)
  if (g.__hmsEmailBooted) return;
  g.__hmsEmailBooted = true;
  try {
    // ── Templates ──
    const existing = await db.emailTemplate.findMany({ select: { key: true } });
    const have = new Set(existing.map((t) => t.key));
    for (const seed of TEMPLATE_CATALOG) {
      if (have.has(seed.key)) continue;
      await db.emailTemplate.create({
        data: {
          key: seed.key, name: seed.name, category: seed.category, description: seed.description,
          subject: seed.subject, bodyHtml: seed.bodyHtml, variables: JSON.stringify(seed.variables),
          isSystem: true, critical: seed.critical ?? false, isActive: true,
        },
      });
    }
    // ── Automations ──
    const existingAuto = await db.emailAutomation.findMany({ select: { eventType: true, name: true } });
    const haveAuto = new Set(existingAuto.map((a) => `${a.eventType}::${a.name}`));
    for (const seed of AUTOMATION_SEEDS) {
      if (haveAuto.has(`${seed.eventType}::${seed.name}`)) continue;
      await db.emailAutomation.create({
        data: {
          name: seed.name,
          eventType: seed.eventType,
          templateKey: seed.templateKey,
          recipientRule: JSON.stringify(seed.recipientRule),
          attachments: JSON.stringify((seed.attachments ?? []).map((kind) => ({ kind }))),
          conditions: JSON.stringify(seed.conditions ?? []),
          enabled: seed.enabled,
          critical: seed.critical ?? false,
          maxAttempts: 3,
        },
      });
    }
  } catch (e) {
    console.error("email-bootstrap-failed", e);
  }
}
