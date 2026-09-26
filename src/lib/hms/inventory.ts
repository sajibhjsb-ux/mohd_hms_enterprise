import "server-only";
// MOHD.HMS ENTERPRISE — Central Inventory Service (Inventory spec §2/§5/§13/§19/§33/§60).
//
// ONE canonical item system + ONE stock engine. Every stock write in the
// application (manual movements, purchase receiving, work-order issue/return,
// stock counts, transfers, opening balances) MUST go through
// `applyStockMovement` so that item.stockQty, per-warehouse WarehouseStock rows
// and the immutable StockMovement ledger always agree (§19: never silently
// change stock without a transaction).
//
// `resolveOrCreateItem` is the single controlled custom-item creation flow used
// by Quotations, Work Orders, Purchases, PM parts and the Inventory module
// itself (§33/§60): normalize → duplicate search → confirm-or-create → return
// the canonical InventoryItem.id. No module keeps its own item catalog.

import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { nextNumber } from "@/lib/hms/services";

type PrismaTx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
type Db = PrismaTx | typeof db;

// ─────────────────────────── normalization / duplicate detection ───────────────────────────

/** Normalize an item name for duplicate detection (§33 step 1). */
export function normalizeItemName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ItemMatchCriteria = {
  name?: string;
  brand?: string;
  model?: string;
  partNumber?: string;
  barcode?: string;
  category?: string;
};

export type ItemMatch = {
  id: string;
  sku: string;
  name: string;
  category: string;
  brand: string;
  model: string;
  partNumber: string;
  unit: string;
  stockQty: number;
  reservedQty: number;
  unitCostCents: number;
  status: string;
  matchedBy: string[];
  score: number;
};

/**
 * Search existing inventory for potential duplicates of a custom item
 * (§5/§34). Matches on barcode / part number / normalized name / brand+model.
 * Returns best matches first — the UI shows these with [Use Existing].
 */
export async function findItemMatches(criteria: ItemMatchCriteria, client: Db = db): Promise<ItemMatch[]> {
  const name = normalizeItemName(criteria.name ?? "");
  const part = (criteria.partNumber ?? "").trim().toLowerCase();
  const barcode = (criteria.barcode ?? "").trim().toLowerCase();
  const brand = (criteria.brand ?? "").trim().toLowerCase();
  const model = (criteria.model ?? "").trim().toLowerCase();

  const ors: Array<Record<string, unknown>> = [];
  if (barcode) ors.push({ barcode: { equals: criteria.barcode!.trim(), mode: undefined } });
  if (part) ors.push({ partNumber: criteria.partNumber!.trim() });
  if (name) ors.push({ nameNorm: { contains: name } });
  if (name) {
    // token-wise containment catches "Copper Pipe" vs "Pipe 3/8 Copper"
    const tokens = name.split(" ").filter((t) => t.length >= 3);
    if (tokens.length) ors.push({ AND: tokens.slice(0, 4).map((t) => ({ nameNorm: { contains: t } })) });
  }
  if (brand && model) ors.push({ AND: [{ brand: { contains: brand } }, { model: { contains: model } }] });
  if (!ors.length) return [];

  // SQLite ignores mode — strip `mode` keys defensively.
  const where = { OR: JSON.parse(JSON.stringify(ors)) };
  const rows = await client.inventoryItem.findMany({
    where,
    take: 12,
    orderBy: { updatedAt: "desc" },
  });

  const scored: ItemMatch[] = rows.map((r) => {
    const matchedBy: string[] = [];
    let score = 0;
    const rNorm = normalizeItemName(r.name);
    if (barcode && r.barcode.trim().toLowerCase() === barcode) {
      matchedBy.push("BARCODE");
      score += 100;
    }
    if (part && r.partNumber.trim().toLowerCase() === part) {
      matchedBy.push("PART_NUMBER");
      score += 90;
    }
    if (name && rNorm === name) {
      matchedBy.push("NAME_EXACT");
      score += 80;
    } else if (name && (rNorm.includes(name) || name.includes(rNorm)) && rNorm.length > 0) {
      matchedBy.push("NAME_PARTIAL");
      score += 50;
    } else if (name) {
      const tokens = name.split(" ").filter((t) => t.length >= 3);
      const hits = tokens.filter((t) => rNorm.includes(t)).length;
      if (hits > 0) {
        matchedBy.push("NAME_TOKENS");
        score += Math.min(40, hits * 12);
      }
    }
    if (brand && model && r.brand.trim().toLowerCase() === brand && r.model.trim().toLowerCase() === model) {
      matchedBy.push("BRAND_MODEL");
      score += 30;
    }
    return {
      id: r.id,
      sku: r.sku,
      name: r.name,
      category: r.category,
      brand: r.brand,
      model: r.model,
      partNumber: r.partNumber,
      unit: r.unit,
      stockQty: r.stockQty,
      reservedQty: r.reservedQty,
      unitCostCents: r.unitCostCents,
      status: r.status,
      matchedBy,
      score,
    };
  });

  return scored.filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
}

export type ResolveOrCreateInput = {
  name: string;
  category?: string;
  subcategory?: string;
  unit?: string;
  brand?: string;
  model?: string;
  partNumber?: string;
  barcode?: string;
  description?: string;
  itemType?: string;
  minStockQty?: number;
  maxStockQty?: number;
  reorderLevel?: number;
  sellingPriceCents?: number;
  unitCostCents?: number;
  supplierId?: string | null;
  supplierPartNumber?: string;
  storageLocation?: string;
  /** Initial stock — only applied when the caller is authorized (§35). */
  initialStockQty?: number;
  /** Skip the duplicate check after the caller explicitly confirmed "Create new" (§34). */
  forceNew?: boolean;
};

export type ResolveOutcome =
  | { status: "CREATED"; item: { id: string; sku: string; name: string; category: string; unit: string; stockQty: number } }
  | { status: "EXISTING"; item: { id: string; sku: string; name: string; category: string; unit: string; stockQty: number }; matchedBy: string[] }
  | { status: "MATCHES"; matches: ItemMatch[] };

/**
 * THE one reusable item creation flow (§33):
 * normalize → search existing → (exact match? return it) → (soft matches?
 * surface them for the caller's [Use Existing]/[Create New] decision) →
 * create → return id. Concurrency-safe (§64): a unique-violation race on
 * sku/nameNorm re-reads and returns the winner instead of a duplicate.
 */
export async function resolveOrCreateItem(
  input: ResolveOrCreateInput,
  ctx: { actorId?: string; allowInitialStock?: boolean; tx?: PrismaTx }
): Promise<ResolveOutcome> {
  const client = ctx.tx ?? db;
  const name = (input.name ?? "").trim();
  if (!name) throw Errors.badRequest("Item name is required.");

  // 1/2. Normalize + search existing inventory.
  if (!input.forceNew) {
    const matches = await findItemMatches(
      { name, brand: input.brand, model: input.model, partNumber: input.partNumber, barcode: input.barcode, category: input.category },
      client
    );
    // Authoritative match only when identity fields align exactly — otherwise
    // the caller decides (UI shows matches + [Use Existing]/[Create New]).
    const exact = matches.find(
      (m) =>
        (input.barcode && m.matchedBy.includes("BARCODE")) ||
        (input.partNumber && m.matchedBy.includes("PART_NUMBER")) ||
        m.matchedBy.includes("NAME_EXACT")
    );
    if (exact) {
      return {
        status: "EXISTING",
        item: { id: exact.id, sku: exact.sku, name: exact.name, category: exact.category, unit: exact.unit, stockQty: exact.stockQty },
        matchedBy: exact.matchedBy,
      };
    }
    if (matches.length) {
      // Soft matches: surface to the caller, never silently pick one.
      return { status: "MATCHES", matches };
    }
  }

  // 3. Create the canonical item (sku from the shared Counter — existing convention).
  // NOTE: nextNumber runs on the transaction client — the global pool would
  // deadlock against the open interactive transaction on SQLite.
  const itemType = input.itemType ?? "STOCK";
  const stockType = ["SERVICE", "NON_STOCK"].includes(itemType) ? "NON_STOCK" : "STOCKED";
  const sku = await nextNumber("ITM", client as never);
  try {
    const item = await client.inventoryItem.create({
      data: {
        sku,
        name,
        nameNorm: normalizeItemName(name),
        description: input.description ?? "",
        category: input.category?.trim() || "GENERAL",
        subcategory: input.subcategory?.trim() ?? "",
        brand: input.brand?.trim() ?? "",
        model: input.model?.trim() ?? "",
        partNumber: input.partNumber?.trim() ?? "",
        barcode: input.barcode?.trim() ?? "",
        itemType,
        stockType,
        unit: input.unit?.trim() || "pcs",
        minStockQty: input.minStockQty ?? 0,
        maxStockQty: input.maxStockQty ?? 0,
        reorderLevel: input.reorderLevel ?? 0,
        unitCostCents: Math.round(input.unitCostCents ?? 0),
        avgCostCents: Math.round(input.unitCostCents ?? 0),
        sellingPriceCents: Math.round(input.sellingPriceCents ?? 0),
        supplierId: input.supplierId || null,
        supplierPartNumber: input.supplierPartNumber?.trim() ?? "",
        storageLocation: input.storageLocation?.trim() ?? "",
        createdById: ctx.actorId ?? null,
      },
    });

    // Initial stock only for stocked items AND explicitly authorized callers (§35).
    const initial = input.initialStockQty ?? 0;
    if (initial > 0 && stockType === "STOCKED" && ctx.allowInitialStock) {
      await applyStockMovement(client, {
        itemId: item.id,
        type: "OPENING",
        signedQuantity: initial,
        referenceType: "ITEM",
        referenceId: item.id,
        note: "Opening stock at item creation",
        createdById: ctx.actorId,
        unitCostCents: Math.round(input.unitCostCents ?? 0),
      });
    }

    const fresh = (await client.inventoryItem.findUnique({ where: { id: item.id } }))!;
    return {
      status: "CREATED" as const,
      item: { id: fresh.id, sku: fresh.sku, name: fresh.name, category: fresh.category, unit: fresh.unit, stockQty: fresh.stockQty },
    };
  } catch (e: unknown) {
    // §64 — two users creating the same item simultaneously: the unique
    // constraint picks a winner; return the existing canonical row.
    const code = (e as { code?: string })?.code;
    if (code === "P2002") {
      const existing = await client.inventoryItem.findFirst({
        where: { OR: [{ sku }, { nameNorm: normalizeItemName(name) }] },
      });
      if (existing) {
        return {
          status: "EXISTING" as const,
          item: { id: existing.id, sku: existing.sku, name: existing.name, category: existing.category, unit: existing.unit, stockQty: existing.stockQty },
          matchedBy: ["CONCURRENT"],
        };
      }
    }
    throw e;
  }
}

// ─────────────────────────── stock engine (§19/§20 — one write path) ───────────────────────────

export type StockMovementType =
  | "OPENING"
  | "RECEIVE"
  | "ISSUE"
  | "RETURN"
  | "ADJUST"
  | "TRANSFER_OUT"
  | "TRANSFER_IN"
  | "DAMAGE"
  | "LOSS"
  | "STOCK_COUNT";

export type ApplyMovementInput = {
  itemId: string;
  type: StockMovementType;
  /** Signed delta: positive = stock in, negative = stock out (ADJUST/STOCK_COUNT may be either). */
  signedQuantity: number;
  warehouseId?: string | null;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  createdById?: string;
  /** Provided on inbound receipts to maintain the moving average + last cost (§25). */
  unitCostCents?: number;
};

export type ApplyMovementResult = {
  movementId: string;
  balanceAfter: number;
  warehouseId: string | null;
  warehouseQtyAfter: number | null;
  lowStock: boolean;
  outOfStock: boolean;
};

async function allowNegativeStock(client: Db): Promise<boolean> {
  const s = await client.setting.findUnique({ where: { key: "inventory_negative_stock" } });
  return s?.value === "true";
}

async function defaultWarehouseId(client: Db, itemWarehouseId: string | null): Promise<string | null> {
  if (itemWarehouseId) return itemWarehouseId;
  const main = await client.warehouse.findUnique({ where: { code: "MAIN" } });
  return main?.id ?? null;
}

/**
 * THE stock write path (§19). Runs atomically even when the caller passes the
 * global pool client; callers that already pass an open transaction run inside
 * their own transaction. Guards: rejects stock writes on NON_STOCK items (§3),
 * rejects negative balances unless `inventory_negative_stock=true` (§70),
 * maintains item.stockQty + per-warehouse WarehouseStock (§21) + immutable
 * ledger row and evaluates low/out-of-stock flags (§16/§44) for the caller.
 */
export async function applyStockMovement(client: Db, input: ApplyMovementInput): Promise<ApplyMovementResult> {
  const poolClient =
    typeof (client as { $transaction?: unknown }).$transaction === "function" ? (client as typeof db) : null;
  if (poolClient) {
    return poolClient.$transaction((tx) => applyStockMovementTx(tx, input));
  }
  return applyStockMovementTx(client as PrismaTx, input);
}

async function applyStockMovementTx(client: PrismaTx, input: ApplyMovementInput): Promise<ApplyMovementResult> {
  const item = await client.inventoryItem.findUnique({ where: { id: input.itemId } });
  if (!item) throw Errors.notFound("Inventory item not found.");
  if (item.stockType === "NON_STOCK" || ["SERVICE", "NON_STOCK"].includes(item.itemType)) {
    throw Errors.badRequest("Non-stock items do not hold inventory quantities.");
  }
  if (!isFinite(input.signedQuantity) || input.signedQuantity === 0) {
    throw Errors.badRequest("Movement quantity cannot be zero.");
  }

  const balanceAfter = item.stockQty + input.signedQuantity;
  if (balanceAfter < -1e-9 && !(await allowNegativeStock(client))) {
    throw Errors.badRequest(
      `Insufficient stock for ${item.sku}. On hand ${round2(item.stockQty)} ${item.unit}, requested ${round2(-input.signedQuantity)} ${item.unit}.`
    );
  }

  // Moving average cost maintenance on stock-in with a known unit cost (§25/§51).
  let avgCostCents = item.avgCostCents;
  let unitCostCents = item.unitCostCents;
  let lastPurchaseAt = item.lastPurchaseAt;
  if (input.signedQuantity > 0 && typeof input.unitCostCents === "number" && input.unitCostCents > 0) {
    const baseQty = Math.max(0, item.stockQty);
    const totalCents = baseQty * item.avgCostCents + input.signedQuantity * Math.round(input.unitCostCents);
    avgCostCents = Math.round(totalCents / (baseQty + input.signedQuantity));
    unitCostCents = Math.round(input.unitCostCents);
    lastPurchaseAt = new Date();
  }

  const warehouseId = input.warehouseId ? input.warehouseId : await defaultWarehouseId(client, item.warehouseId);

  const movement = await client.stockMovement.create({
    data: {
      itemId: item.id,
      type: input.type,
      quantity: round2(input.signedQuantity),
      balanceAfter: round2(balanceAfter),
      referenceType: input.referenceType ?? "MANUAL",
      referenceId: input.referenceId ?? "",
      note: input.note ?? "",
      warehouseId: warehouseId ?? null,
      createdById: input.createdById ?? null,
    },
  });

  await client.inventoryItem.update({
    where: { id: item.id },
    data: { stockQty: round2(balanceAfter), avgCostCents, unitCostCents, lastPurchaseAt },
  });

  // Per-warehouse quantity is a DELTA on the specific warehouse row
  // (qty += signedQuantity) — never clobbered with the company-wide
  // balanceAfter. An optimistic guard aborts if another movement raced us.
  let warehouseQtyAfter: number | null = null;
  if (warehouseId) {
    const existing = await client.warehouseStock.findUnique({
      where: { itemId_warehouseId: { itemId: item.id, warehouseId } },
    });
    if (existing) {
      const newQty = round2(existing.qty + input.signedQuantity);
      const claimed = await client.warehouseStock.updateMany({
        where: { id: existing.id, qty: existing.qty },
        data: { qty: newQty },
      });
      if (claimed.count !== 1) {
        throw Errors.conflict("Stock changed concurrently in this warehouse — please review and retry.");
      }
      warehouseQtyAfter = newQty;
    } else {
      try {
        await client.warehouseStock.create({ data: { itemId: item.id, warehouseId, qty: round2(input.signedQuantity) } });
        warehouseQtyAfter = round2(input.signedQuantity);
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e;
        // A concurrent movement created the row first — apply our delta to it.
        const fresh = await client.warehouseStock.findUnique({
          where: { itemId_warehouseId: { itemId: item.id, warehouseId } },
        });
        if (!fresh) throw e;
        const newQty = round2(fresh.qty + input.signedQuantity);
        const claimed = await client.warehouseStock.updateMany({
          where: { id: fresh.id, qty: fresh.qty },
          data: { qty: newQty },
        });
        if (claimed.count !== 1) {
          throw Errors.conflict("Stock changed concurrently in this warehouse — please review and retry.");
        }
        warehouseQtyAfter = newQty;
      }
    }

    // F-16 soft invariant canary: warehouse rows must never exceed the
    // company-wide balance (they may lag below it only while some stock is
    // not yet tracked per warehouse). Loudly flag any drift.
    const agg = await client.warehouseStock.aggregate({ _sum: { qty: true }, where: { itemId: item.id } });
    const warehoused = round2(agg._sum.qty ?? 0);
    if (warehoused > round2(balanceAfter) + 1e-9) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "stock-invariant-broken", itemId: item.id, sku: item.sku, warehoused, companyBalance: round2(balanceAfter) }));
    }
  }

  const reorderPoint = item.reorderLevel > 0 ? item.reorderLevel : item.minStockQty;
  return {
    movementId: movement.id,
    balanceAfter: round2(balanceAfter),
    warehouseId: warehouseId ?? null,
    warehouseQtyAfter,
    lowStock: balanceAfter <= reorderPoint && reorderPoint > 0,
    outOfStock: balanceAfter <= 0,
  };
}

// ─────────────────────────── reservations (§13/§15) ───────────────────────────

export async function stockSummary(client: Db, itemId: string): Promise<{
  onHand: number;
  reserved: number;
  available: number;
  onOrder: number;
}> {
  const item = await client.inventoryItem.findUnique({ where: { id: itemId } });
  if (!item) throw Errors.notFound("Inventory item not found.");
  const onOrderAgg = await client.purchaseItem.aggregate({
    _sum: { quantity: true, receivedQty: true },
    where: { itemId, po: { status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } },
  });
  const ordered = (onOrderAgg._sum.quantity ?? 0) - (onOrderAgg._sum.receivedQty ?? 0);
  const onHand = item.stockQty;
  const reserved = item.reservedQty;
  return {
    onHand: round2(onHand),
    reserved: round2(reserved),
    available: round2(onHand - reserved),
    onOrder: round2(Math.max(0, ordered)),
  };
}

export type CreateReservationInput = {
  itemId: string;
  quantity: number;
  workOrderId?: string | null;
  quotationId?: string | null;
  note?: string;
};

/** Reserve available stock (§13). Reserved stock is NOT available stock. */
export async function createReservation(input: CreateReservationInput, ctx: { actorId?: string; tx?: PrismaTx } = {}) {
  const client = ctx.tx ?? db;
  const item = await client.inventoryItem.findUnique({ where: { id: input.itemId } });
  if (!item) throw Errors.notFound("Inventory item not found.");
  if (item.stockType === "NON_STOCK") throw Errors.badRequest("Non-stock items cannot be reserved.");
  const qty = round2(input.quantity);
  if (!(qty > 0)) throw Errors.badRequest("Reservation quantity must be positive.");

  const available = round2(item.stockQty - item.reservedQty);
  if (qty > available + 1e-9) {
    throw Errors.badRequest(
      `Insufficient available stock for ${item.sku}. Available ${available} ${item.unit}, requested ${qty} ${item.unit}.`
    );
  }
  const reservation = await client.stockReservation.create({
    data: {
      itemId: input.itemId,
      quantity: qty,
      workOrderId: input.workOrderId ?? null,
      quotationId: input.quotationId ?? null,
      note: input.note ?? "",
      createdById: ctx.actorId ?? null,
    },
  });
  await client.inventoryItem.update({ where: { id: input.itemId }, data: { reservedQty: { increment: qty } } });
  return reservation;
}

/** Release a reservation back to available stock. */
export async function releaseReservation(reservationId: string, status: "RELEASED" | "CANCELLED" = "RELEASED", tx?: PrismaTx) {
  const client = tx ?? db;
  const r = await client.stockReservation.findUnique({ where: { id: reservationId } });
  if (!r) throw Errors.notFound("Reservation not found.");
  if (r.status !== "ACTIVE") throw Errors.invalidTransition("Reservation is not active.");
  await client.stockReservation.update({ where: { id: r.id }, data: { status, releasedAt: new Date() } });
  await client.inventoryItem.update({ where: { id: r.itemId }, data: { reservedQty: { decrement: r.quantity } } });
  return r;
}

/** Mark a reservation CONSUMED when its quantity is actually issued from stock. */
export async function consumeReservation(itemId: string, quantity: number, workOrderId: string | null, tx?: PrismaTx) {
  const client = tx ?? db;
  const qty = round2(quantity);
  const actives = await client.stockReservation.findMany({
    where: { itemId, status: "ACTIVE", ...(workOrderId ? { workOrderId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  let remaining = qty;
  for (const r of actives) {
    if (remaining <= 1e-9) break;
    const take = Math.min(r.quantity, remaining);
    if (take >= r.quantity - 1e-9) {
      await client.stockReservation.update({ where: { id: r.id }, data: { status: "CONSUMED" } });
      await client.inventoryItem.update({ where: { id: itemId }, data: { reservedQty: { decrement: r.quantity } } });
      remaining = round2(remaining - r.quantity);
    } else {
      // Partially consumed: shrink the active reservation.
      await client.stockReservation.update({ where: { id: r.id }, data: { quantity: round2(r.quantity - take) } });
      await client.inventoryItem.update({ where: { id: itemId }, data: { reservedQty: { decrement: take } } });
      remaining = 0;
    }
  }
}

/** Quotation approval → optional reservation (§15) — governed by a Setting key. */
export async function reservationOnQuotationApproval(): Promise<boolean> {
  const s = await db.setting.findUnique({ where: { key: "inventory_reservation_on_quotation_approval" } });
  return s?.value === "true";
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
