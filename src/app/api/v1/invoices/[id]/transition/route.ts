// MOHD.HMS ENTERPRISE — Invoice workflow transitions: send | cancel

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit, notify, notifyRole } from "@/lib/hms/services";
import { isStaff } from "@/lib/hms/rbac";
import type { SessionUser } from "@/lib/hms/auth";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";

const bodySchema = z.object({
  action: z.enum(["send", "cancel"]),
});

const ALLOWED_FROM: Record<string, string[]> = {
  send: ["DRAFT"],
  cancel: ["DRAFT", "SENT", "OVERDUE"],
};
const TARGET: Record<string, string> = { send: "SENT", cancel: "CANCELLED" };
const ACTION_NAME: Record<string, string> = { send: "INVOICE_SENT", cancel: "INVOICE_CANCELLED" };

async function loadScoped(id: string, user: SessionUser) {
  const invoice = await db.invoice.findUnique({
    where: { id },
    include: { customer: { select: { id: true, code: true, companyName: true, portalUser: { select: { id: true } } } } },
  });
  if (!invoice) throw Errors.notFound("Invoice not found.");
  if (!isStaff(user.role) && invoice.customerId !== user.customerId) throw Errors.notFound("Invoice not found.");
  return invoice;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, bodySchema);
    const invoice = await loadScoped(id, user);

    if (!ALLOWED_FROM[body.action].includes(invoice.status)) {
      throw Errors.invalidTransition(`Cannot ${body.action} an invoice in status ${invoice.status}.`);
    }

    const updated = await db.invoice.update({
      where: { id },
      data: {
        status: TARGET[body.action],
        ...(body.action === "send" ? { sentAt: new Date() } : {}),
      },
    });

    if (body.action === "send") {
      const portalUserId = invoice.customer.portalUser?.id;
      if (portalUserId) {
        await notify({
          userId: portalUserId,
          title: `Invoice ${invoice.code} sent`,
          message: `Invoice ${invoice.code} for ${invoice.customer.companyName} is now available. Amount due: RM ${(invoice.totalCents / 100).toFixed(2)}.`,
          type: "INFO",
          resourceType: "INVOICE",
          resourceId: id,
        });
      }
      await notifyRole("FINANCE", {
        title: `Invoice ${invoice.code} sent`,
        message: `Invoice ${invoice.code} for ${invoice.customer.companyName} was sent to the customer.`,
        type: "INFO",
        resourceType: "INVOICE",
        resourceId: id,
      });
      // Outbox (§26/§30): invoice-sent event + queued email to the customer.
      await emit({ type: EVENT_TYPES.INVOICE_SENT, resourceType: "INVOICE", resourceId: id, payload: { code: invoice.code, totalCents: invoice.totalCents }, actorType: "USER", actorId: user.id });
      if (portalUserId) {
        await emit({ type: EVENT_TYPES.EMAIL_SEND, resourceType: "INVOICE", resourceId: id, payload: { userId: portalUserId, title: `Invoice ${invoice.code} sent`, message: `Invoice ${invoice.code} is now available. Amount due: RM ${(invoice.totalCents / 100).toFixed(2)}.` }, actorType: "USER", actorId: user.id });
      }
    }

    await audit({
      actorId: user.id, actorEmail: user.email, action: ACTION_NAME[body.action],
      resourceType: "INVOICE", resourceId: id,
      metadata: { code: invoice.code, from: invoice.status, to: TARGET[body.action] },
    });

    return ok(updated);
  }, { permission: PERMISSIONS.invoices_manage })(req);
}
