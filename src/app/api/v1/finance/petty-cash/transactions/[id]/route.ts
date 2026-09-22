// MOHD.HMS ENTERPRISE — Petty cash transaction detail (spec §34-§36).
//
//   GET   /api/v1/finance/petty-cash/transactions/{id} — full transaction (finance_read or creator)
//   PATCH /api/v1/finance/petty-cash/transactions/{id} — edit while PENDING (finance_manage)
//
// Only PENDING transactions are editable — once approved the money has moved
// and the record is immutable (corrections happen as new ADJUSTMENT entries).

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { toCents } from "@/lib/hms/format";
import { roleCan } from "@/lib/hms/rbac";

const TX_TYPES = ["CASH_IN", "CASH_OUT", "TOP_UP", "EXPENSE", "REIMBURSEMENT", "ADJUSTMENT"] as const;
const IN_TYPES = new Set<string>(["CASH_IN", "TOP_UP"]);

async function loadTx(id: string) {
  const tx = await db.pettyCashTransaction.findUnique({
    where: { id },
    include: { fund: { select: { id: true, code: true, name: true } } },
  });
  if (!tx) throw Errors.notFound("Petty cash transaction not found.");
  return tx;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const tx = await loadTx(id);
    // finance_read OR the transaction's own creator (a submitter can always
    // follow their submission even without a finance reader role).
    if (!roleCan(user.role, PERMISSIONS.finance_read) && tx.createdById !== user.id) {
      throw Errors.forbidden();
    }
    return ok(tx);
  }, { auth: true })(req);
}

const patchSchema = z.object({
  type: z.enum(TX_TYPES).optional(),
  amount: z.coerce.number().positive("Amount must be greater than 0").optional(),
  category: z.string().trim().max(80).optional(),
  description: z.string().trim().max(500).optional(),
  txDate: z.string().optional(),
  requesterId: z.string().trim().min(1).nullish(),
  reference: z.string().trim().max(120).optional(),
  direction: z.enum(["IN", "OUT"]).optional(), // only honored for ADJUSTMENT
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return handler(async ({ user }) => {
    const body = await parseBody(req, patchSchema);
    const tx = await loadTx(id);
    if (tx.status !== "PENDING") {
      throw Errors.invalidTransition(`Only pending transactions can be edited (current status: ${tx.status}).`);
    }
    if (body.direction && (body.type ?? tx.type) !== "ADJUSTMENT") {
      throw Errors.badRequest("Direction is only accepted for ADJUSTMENT transactions.");
    }

    const nextType = body.type ?? tx.type;
    const nextDirection =
      nextType === "ADJUSTMENT"
        ? (body.direction ?? tx.direction) === "IN" ? "IN" : "OUT"
        : IN_TYPES.has(nextType) ? "IN" : "OUT";

    const description = body.description !== undefined ? body.description : tx.description;
    if ((nextType === "EXPENSE" || nextType === "REIMBURSEMENT") && description.trim().length < 1) {
      throw Errors.badRequest("Description is required for EXPENSE and REIMBURSEMENT transactions.");
    }

    let requesterId = tx.requesterId;
    let requesterName = tx.requesterName;
    if (body.requesterId !== undefined) {
      if (body.requesterId) {
        const requester = await db.user.findUnique({ where: { id: body.requesterId }, select: { id: true, name: true } });
        if (!requester) throw Errors.badRequest("Requester not found.");
        requesterId = requester.id;
        requesterName = requester.name;
      } else {
        requesterId = null;
        requesterName = "";
      }
    }

    let amountCents = tx.amountCents;
    if (body.amount !== undefined) {
      amountCents = toCents(body.amount);
      if (amountCents <= 0) throw Errors.badRequest("Amount must be greater than 0.");
    }

    const updated = await db.pettyCashTransaction.update({
      where: { id: tx.id },
      data: {
        ...(body.type !== undefined ? { type: body.type } : {}),
        direction: nextDirection,
        amountCents,
        ...(body.category !== undefined ? { category: body.category || (nextType === "EXPENSE" || nextType === "REIMBURSEMENT" ? "GENERAL" : "CASH") } : {}),
        description,
        ...(body.txDate ? { txDate: new Date(body.txDate) } : {}),
        requesterId,
        requesterName,
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
      },
      include: { fund: { select: { id: true, code: true, name: true } } },
    });

    await audit({
      actorId: user.id, actorEmail: user.email, action: "PETTY_CASH_TX_UPDATED",
      resourceType: "PETTY_CASH_TRANSACTION", resourceId: tx.id,
      metadata: { code: tx.code, changes: { ...body } },
    });

    return ok(updated);
  }, { permission: PERMISSIONS.finance_manage })(req);
}
