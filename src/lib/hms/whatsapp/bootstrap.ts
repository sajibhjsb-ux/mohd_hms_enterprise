// MOHD.HMS ENTERPRISE — WhatsApp workflow registration (§30) + bootstrap.
// Mirrors src/lib/hms/email/workflows.ts + bootstrap.ts: handlers on the
// SHARED outbox engine registry; idempotent seed of templates/automations
// invoked from startScheduler(). No second engine, no second scheduler.

import { db } from "@/lib/db";
import { registerWorkflow, type WorkflowResult } from "@/lib/hms/workflows/engine";
import { runWhatsAppAutomations, WHATSAPP_AUTOMATION_EVENTS } from "./automations";
import { TEMPLATE_CATALOG, AUTOMATION_SEEDS } from "./templates";

export function registerWhatsAppWorkflows(): void {
  for (const eventType of WHATSAPP_AUTOMATION_EVENTS) {
    registerWorkflow(eventType, "WHATSAPP_AUTOMATION", async (ctx): Promise<WorkflowResult> => {
      const { queued, skipped } = await runWhatsAppAutomations({
        eventId: ctx.eventId, eventType: ctx.eventType,
        resourceType: ctx.resourceType, resourceId: ctx.resourceId, payload: ctx.payload,
      });
      if (queued > 0) return { result: "SUCCESS", detail: `${queued} WhatsApp message(s) queued` };
      return { result: "SKIPPED", detail: skipped.join("; ") || "no messages" };
    });
  }
}

const g = globalThis as unknown as { __hmsWaBooted?: boolean };

/**
 * Idempotent WhatsApp bootstrap — templates/automations are created only when
 * missing; admin edits are never overwritten. Safe to call on every boot.
 */
export async function bootstrapWhatsAppSystem(): Promise<void> {
  registerWhatsAppWorkflows();
  if (g.__hmsWaBooted) return;
  g.__hmsWaBooted = true;

  try {
    // Templates: create only when the catalog key is missing.
    for (const t of TEMPLATE_CATALOG) {
      const existing = await db.whatsAppTemplate.findUnique({ where: { key: t.key } });
      if (existing) continue;
      await db.whatsAppTemplate.create({
        data: {
          key: t.key, name: t.name, category: t.category, description: t.description,
          body: t.body, variables: JSON.stringify(t.variables), isSystem: true, critical: !!t.critical,
        },
      });
    }
    // Automations: create only when `${eventType}::${name}` is missing.
    for (const a of AUTOMATION_SEEDS) {
      const existing = await db.whatsAppAutomation.findUnique({
        where: { eventType_name: { eventType: a.eventType, name: a.name } },
      });
      if (existing) continue;
      await db.whatsAppAutomation.create({
        data: {
          name: a.name, eventType: a.eventType, templateKey: a.templateKey,
          recipientRule: JSON.stringify(a.recipientRule),
          attachments: JSON.stringify(a.attachments ?? []),
          dedupeHours: a.dedupeHours ?? 0,
          enabled: a.enabled ?? true,
        },
      });
    }
  } catch {
    // Bootstrap must never break boot (email bootstrap has the same rule).
    g.__hmsWaBooted = false;
  }
}
