// MOHD.HMS ENTERPRISE — Statutory payroll rules (spec §18/§19). Configurable
// and versioned by effective dates — legal rates are DATA, never hard-coded.
// EMPLOYEE rows deduct from net; EMPLOYER rows are cost-only.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

export const GET = handler(async ({ req }) => {
  const url = new URL(req.url);
  const payer = url.searchParams.get("payer");
  const active = url.searchParams.get("active");
  const where = {
    ...(payer ? { payer } : {}),
    ...(active === "true" ? { active: true } : active === "false" ? { active: false } : {}),
  };
  const rules = await db.statutoryRule.findMany({
    where,
    orderBy: [{ active: "desc" }, { calcOrder: "asc" }, { effectiveFrom: "desc" }],
  });
  return ok(rules);
}, { permission: PERMISSIONS.payroll_read });

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  jurisdiction: z.string().trim().max(60).optional(),
  category: z.enum(["SOCIAL", "TAX", "OTHER"]).optional(),
  payer: z.enum(["EMPLOYEE", "EMPLOYER"]),
  employeeCategory: z.enum(["ALL", "CITIZEN_PR", "FOREIGN"]).optional(),
  calcType: z.enum(["PERCENTAGE", "FIXED"]),
  rateBps: z.coerce.number().int().min(0).max(10000).optional(),
  amount: z.union([z.coerce.number(), z.string()]).optional(),
  appliesTo: z.enum(["GROSS", "BASIC"]).optional(),
  threshold: z.union([z.coerce.number(), z.string()]).optional(),
  effectiveFrom: z.string().min(10),
  effectiveTo: z.string().optional(),
  calcOrder: z.coerce.number().int().min(1).max(999).optional(),
  reference: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(300).optional(),
});

export const POST = handler(async ({ req, user }) => {
  const body = await parseBody(req, createSchema);
  if (body.calcType === "PERCENTAGE" && (body.rateBps == null || body.rateBps <= 0)) {
    throw Errors.badRequest("Percentage rules require rateBps (500 = 5%).");
  }
  if (body.calcType === "FIXED" && body.amount == null) {
    throw Errors.badRequest("Fixed rules require an amount.");
  }
  const rule = await db.statutoryRule.create({
    data: {
      name: body.name,
      jurisdiction: body.jurisdiction ?? "BN",
      category: body.category ?? "SOCIAL",
      payer: body.payer,
      employeeCategory: body.employeeCategory ?? "ALL",
      calcType: body.calcType,
      rateBps: body.rateBps ?? 0,
      amountCents: body.amount != null ? Math.round(Number(body.amount) * 100) : 0,
      appliesTo: body.appliesTo ?? "GROSS",
      thresholdCents: body.threshold != null ? Math.round(Number(body.threshold) * 100) : 0,
      effectiveFrom: new Date(body.effectiveFrom),
      effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
      calcOrder: body.calcOrder ?? 100,
      reference: body.reference ?? "",
      notes: body.notes ?? "",
      createdById: user.id,
    },
  });
  await audit({
    actorId: user.id, actorEmail: user.email, action: "STATUTORY_RULE_CREATED",
    resourceType: "STATUTORY_RULE", resourceId: rule.id,
    metadata: { name: rule.name, payer: rule.payer, calcType: rule.calcType, rateBps: rule.rateBps, effectiveFrom: rule.effectiveFrom },
  });
  return ok(rule, 201);
}, { permission: PERMISSIONS.payroll_manage });
