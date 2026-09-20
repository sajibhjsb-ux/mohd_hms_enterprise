// MOHD.HMS ENTERPRISE — AI summary from REAL recorded results (spec §30/§63).
// POST /api/v1/checklists/[id]/ai-summary — summarizes ONLY the recorded
// checklist results; the result is stored on the instance and labelled as an
// AI-assisted suggestion in the UI. Never presented as an engineering conclusion.
import type { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/lib/hms/auth";
import { summarizeChecklistResults } from "@/lib/hms/checklist/engine";

type Ctx = { req: NextRequest; user: SessionUser };

function withId(fn: (id: string, ctx: Ctx) => Promise<NextResponse>, opts?: Parameters<typeof handler>[1]) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), opts)(req);
  };
}

export const POST = withId(
  async (id, { user }) => {
    const instance = await db.checklistInstance.findUnique({ where: { id }, select: { id: true } });
    if (!instance) throw Errors.notFound("Checklist not found.");
    const summary = await summarizeChecklistResults({ actorId: user.id, actorEmail: user.email, instanceId: id });
    return ok({ summary, aiAssisted: true });
  },
  { permission: PERMISSIONS.checklist_view }
);
