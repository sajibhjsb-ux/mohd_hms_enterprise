// MOHD.HMS ENTERPRISE — AI checklist regeneration (spec §26/§27).
// POST /api/v1/checklists/[id]/regenerate — replaces the DRAFT with a fresh AI
// generation. The current draft is versioned first — nothing is silently
// destroyed (confirmation UX is the caller's responsibility per §26).
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { audit } from "@/lib/hms/services";
import { generateChecklistDraft } from "@/lib/hms/checklist/engine";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const POST = withId(
  async (id, { user }) => {
    const instance = await db.checklistInstance.findUnique({ where: { id } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    if (!["DRAFT", "PENDING_APPROVAL", "REJECTED"].includes(instance.status)) {
      throw Errors.invalidTransition("Only drafts awaiting review can be regenerated — an active checklist is a frozen snapshot (spec §27).");
    }
    await db.checklistInstance.update({ where: { id }, data: { status: "DRAFT" } });
    const result = await generateChecklistDraft({
      actorId: user.id,
      actorEmail: user.email,
      sourceType: instance.sourceType as "COMPLAINT" | "WORK_ORDER" | "PM" | "IRMS",
      sourceId: instance.sourceId,
      mode: "AI_ASSIST",
      templateId: instance.templateId ?? undefined,
    });
    await audit({
      actorId: user.id, actorEmail: user.email, action: "CHECKLIST_REGENERATED",
      resourceType: "CHECKLIST_INSTANCE", resourceId: result.instanceId,
      metadata: { code: result.code, previousVersion: instance.version },
    });
    await emit({
      type: EVENT_TYPES.CHECKLIST_UPDATED,
      resourceType: "CHECKLIST_INSTANCE",
      resourceId: result.instanceId,
      payload: { code: result.code, status: result.status, regenerated: true },
      actorType: "USER",
      actorId: user.id,
    });
    return ok(result);
  },
  { permission: PERMISSIONS.checklist_generate }
);
