// MOHD.HMS ENTERPRISE — Stock count transitions (Inventory spec §31).
// POST /api/v1/inventory/stock-counts/[id]/transition {action: submit|approve|cancel}
// Flow: DRAFT → SUBMITTED → APPROVED (adjustment movements written) | CANCELLED.
// Approve requires inventory_adjust (admins) — §31 "Require appropriate
// authorization. Do not allow ordinary users to silently modify stock balances."
// On approve, every non-zero variance writes one STOCK_COUNT movement through
// the central stock engine; the count sheet then freezes as historical record.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { parseBody } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { applyStockMovement } from "@/lib/hms/inventory";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const schema = z.object({ action: z.enum(["submit", "approve", "cancel"]) });

export const POST = withId(PERMISSIONS.inventory_manage, async (id, { req, user }) => {
  const body = await parseBody(req, schema);
  const count = await db.stockCount.findUnique({ where: { id }, include: { lines: true } });
  if (!count) throw Errors.notFound("Stock count not found.");

  if (body.action === "submit") {
    if (count.status !== "DRAFT") throw Errors.invalidTransition("Only DRAFT counts can be submitted.");
    const updated = await db.stockCount.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } });
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "STOCK_COUNT_SUBMITTED", resourceType: "STOCK_COUNT", resourceId: id,
      metadata: { code: count.code, lines: count.lines.length },
    });
    return ok(updated);
  }

  if (body.action === "cancel") {
    if (count.status === "APPROVED") throw Errors.invalidTransition("Approved counts cannot be cancelled.");
    const updated = await db.stockCount.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit({
      actorId: user.id, actorEmail: user.email,
      action: "STOCK_COUNT_CANCELLED", resourceType: "STOCK_COUNT", resourceId: id,
      metadata: { code: count.code },
    });
    return ok(updated);
  }

  // approve — inventory_adjust authority enforced on top of inventory_manage.
  const { roleCan } = await import("@/lib/hms/rbac");
  if (!roleCan(user.role, PERMISSIONS.inventory_adjust)) {
    throw Errors.forbidden("Only administrators can approve stock count adjustments.");
  }
  if (count.status !== "SUBMITTED") throw Errors.invalidTransition("Only SUBMITTED counts can be approved.");

  const adjustments: Array<{ itemId: string; variance: number }> = [];
  await db.$transaction(async (tx) => {
    for (const line of count.lines) {
      if (Math.abs(line.variance) < 1e-9) continue;
      await applyStockMovement(tx, {
        itemId: line.itemId,
        type: "STOCK_COUNT",
        signedQuantity: line.variance,
        warehouseId: count.warehouseId ?? undefined,
        referenceType: "STOCK_COUNT",
        referenceId: count.id,
        note: `Stock count ${count.code}${line.note ? ` — ${line.note}` : ""}`,
        createdById: user.id,
      });
      adjustments.push({ itemId: line.itemId, variance: line.variance });
    }
    await tx.stockCount.update({
      where: { id },
      data: { status: "APPROVED", approvedById: user.id, approvedAt: new Date() },
    });
  }, { timeout: 20000, maxWait: 10000 });

  await audit({
    actorId: user.id, actorEmail: user.email,
    action: "STOCK_COUNT_APPROVED", resourceType: "STOCK_COUNT", resourceId: id,
    metadata: { code: count.code, adjustments },
  });
  await emit({
    type: EVENT_TYPES.INVENTORY_ADJUSTED,
    resourceType: "STOCK_COUNT",
    resourceId: id,
    payload: { code: count.code, adjustments },
    actorType: "USER",
    actorId: user.id,
  });

  return ok(await db.stockCount.findUnique({ where: { id }, include: { lines: true } }));
});
