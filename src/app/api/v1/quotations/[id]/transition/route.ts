// MOHD.HMS ENTERPRISE — Quotation workflow transitions: send | approve | reject | expire

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";

const bodySchema = z.object({
  action: z.enum(["send", "approve", "reject", "expire"]),
});

/** Allowed transitions: send DRAFT→SENT; approve/reject/expire SENT→… */
const TARGET: Record<string, string> = { send: "SENT", approve: "APPROVED", reject: "REJECTED", expire: "EXPIRED" };
const FROM: Record<string, string> = { send: "DRAFT", approve: "SENT", reject: "SENT", expire: "SENT" };
const ACTION_NAME: Record<string, string> = {
  send: "QUOTATION_SENT", approve: "QUOTATION_APPROVED", reject: "QUOTATION_REJECTED", expire: "QUOTATION_EXPIRED",
};

async function loadScoped(id: string, user: SessionUser) {
  const quotation = await db.quotation.findUnique({
    where: { id },
    include: { customer: { select: { id: true, code: true, companyName: true, portalUser: { select: { id: true } } } } },
  });
  if (!quotation) throw Errors.notFound("Quotation not found.");
  if (!isStaff(user.role) && quotation.customerId !== user.customerId) throw Errors.notFound("Quotation not found.");
  return quotation;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);
    const quotation = await loadScoped(id, user);

    if (quotation.status !== FROM[body.action]) {
      throw Errors.invalidTransition(`Cannot ${body.action} a quotation in status ${quotation.status}.`);
    }

    const updated = await db.quotation.update({ where: { id }, data: { status: TARGET[body.action] } });

    if (body.action === "send") {
      const portalUserId = quotation.customer.portalUser?.id;
      if (portalUserId) {
        await notify({
          userId: portalUserId,
          title: `Quotation ${quotation.code} sent`,
          message: `A new quotation ${quotation.code} for ${quotation.customer.companyName} is awaiting your review.`,
          type: "INFO",
          resourceType: "QUOTATION",
          resourceId: id,
        });
      }
      await notifyRole("FINANCE", {
        title: `Quotation ${quotation.code} sent`,
        message: `Quotation ${quotation.code} for ${quotation.customer.companyName} was sent to the customer.`,
        type: "INFO",
        resourceType: "QUOTATION",
        resourceId: id,
      });
    }

    await audit({
      actorId: user.id, actorEmail: user.email, action: ACTION_NAME[body.action],
      resourceType: "QUOTATION", resourceId: id,
      metadata: { code: quotation.code, from: quotation.status, to: TARGET[body.action] },
    });

    return ok(updated);
  }, { permission: PERMISSIONS.quotations_manage })(req);
}
