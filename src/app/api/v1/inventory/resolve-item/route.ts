// MOHD.HMS ENTERPRISE — THE controlled custom-item creation endpoint (Inventory spec §33/§60).
// POST /api/v1/inventory/resolve-item — one reusable flow for Quotations, Work
// Orders, Purchases, PM parts and the Inventory module:
//   normalize → search existing (§5) → 409 {matches} when soft matches exist and
//   confirmNew is not set → create canonical item → return inventory_item_id.
// Authorized creators: staff holding any of inventory_manage | quotations_manage |
// work_orders_update | purchases_manage | pm_manage (backend-enforced, §71).
import { z } from "zod";
import { NextResponse } from "next/server";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { resolveOrCreateItem } from "@/lib/hms/inventory";
import { db } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().min(1, "Item name is required").max(160),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().max(80).optional(),
  subcategory: z.string().trim().max(80).optional(),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(80).optional(),
  partNumber: z.string().trim().max(80).optional(),
  barcode: z.string().trim().max(80).optional(),
  itemType: z.string().trim().max(40).optional(),
  unit: z.string().trim().max(20).optional(),
  minStockQty: z.coerce.number().min(0).optional(),
  maxStockQty: z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  /** Cost of the new item — NOT the quotation selling rate (§38). */
  unitCostCents: z.coerce.number().int().min(0).optional(),
  supplierId: z.string().trim().nullable().optional(),
  supplierPartNumber: z.string().trim().max(80).optional(),
  storageLocation: z.string().trim().max(160).optional(),
  /** §34 — user explicitly chose [Create New Inventory Item] after seeing matches. */
  confirmNew: z.boolean().optional(),
  /** Opening stock — only honored for inventory_manage callers (§35). */
  initialStockQty: z.coerce.number().min(0).optional(),
});

/** Who may create canonical items from linked modules (§33 "one controlled process"). */
const CREATOR_PERMS = [
  PERMISSIONS.inventory_manage,
  PERMISSIONS.quotations_manage,
  PERMISSIONS.work_orders_update,
  PERMISSIONS.purchases_manage,
  PERMISSIONS.pm_manage,
] as const;

export const POST = handler(
  async ({ req, user }) => {
    const sUser = user as SessionUser;
    const allowed = CREATOR_PERMS.some((p) => roleCan(sUser.role, p));
    if (!allowed) throw Errors.forbidden("You do not have permission to create inventory items.");

    const body = await parseBody(req, schema);
    const canManage = roleCan(sUser.role, PERMISSIONS.inventory_manage);

    const outcome = await db.$transaction(async (tx) =>
      resolveOrCreateItem(
        {
          name: body.name,
          description: body.description,
          category: body.category,
          subcategory: body.subcategory,
          brand: body.brand,
          model: body.model,
          partNumber: body.partNumber,
          barcode: body.barcode,
          itemType: body.itemType,
          unit: body.unit,
          minStockQty: body.minStockQty,
          maxStockQty: body.maxStockQty,
          reorderLevel: body.reorderLevel,
          unitCostCents: body.unitCostCents ?? 0,
          supplierId: body.supplierId ?? null,
          supplierPartNumber: body.supplierPartNumber,
          storageLocation: body.storageLocation,
          initialStockQty: canManage ? body.initialStockQty ?? 0 : 0,
          forceNew: body.confirmNew === true,
        },
        { actorId: sUser.id, allowInitialStock: canManage, tx }
      ),
      { timeout: 20000, maxWait: 10000 }
    );

    if (outcome.status === "MATCHES") {
      // §34 — soft matches: let the caller choose [Use Existing] or [Create New].
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "ITEM_MATCHES",
            message: "Similar inventory items already exist. Use an existing item or confirm creating a new one.",
            matches: outcome.matches,
          },
        },
        { status: 409 }
      );
    }

    if (outcome.status === "CREATED") {
      await audit({
        actorId: sUser.id,
        actorEmail: sUser.email,
        action: "ITEM_CREATED_FROM_MODULE",
        resourceType: "INVENTORY_ITEM",
        resourceId: outcome.item.id,
        metadata: { sku: outcome.item.sku, name: outcome.item.name, via: "resolve-item" },
      });
      await emit({
        type: EVENT_TYPES.INVENTORY_ITEM_CREATED,
        resourceType: "INVENTORY_ITEM",
        resourceId: outcome.item.id,
        payload: { sku: outcome.item.sku, name: outcome.item.name, source: "LINKED_MODULE" },
        actorType: "USER",
        actorId: sUser.id,
      });
    }

    // 201 when a new canonical item was created; 200 with matchedBy when an
    // existing item was reused (§5 USE EXISTING rather than CREATE NEW).
    return ok(outcome, outcome.status === "CREATED" ? 201 : 200);
  },
  { auth: true }
);
