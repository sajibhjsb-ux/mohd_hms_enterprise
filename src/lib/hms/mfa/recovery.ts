import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/hms/auth";

type Client = Prisma.TransactionClient;

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < 10) {
    const hex = randomBytes(5).toString("hex").toUpperCase();
    codes.add(`${hex.slice(0, 5)}-${hex.slice(5)}`);
  }
  return [...codes];
}

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function replaceRecoveryCodes(userId: string, codes: string[], tx?: Client): Promise<void> {
  const c = tx ?? db;
  await c.mfaRecoveryCode.deleteMany({ where: { userId } });
  const rows = await Promise.all(codes.map(async (code) => ({ userId, codeHash: await hashPassword(normalize(code)) })));
  await c.mfaRecoveryCode.createMany({ data: rows });
}

export async function consumeRecoveryCode(userId: string, code: string, ip?: string, tx?: Client): Promise<boolean> {
  const c = tx ?? db;
  const normalized = normalize(code);
  if (!normalized) return false;
  const rows = await c.mfaRecoveryCode.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } });
  for (const row of rows) {
    if (!(await verifyPassword(normalized, row.codeHash))) continue;
    const result = await c.mfaRecoveryCode.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date(), usedIp: ip ?? null },
    });
    return result.count === 1;
  }
  return false;
}

export async function countUnusedRecoveryCodes(userId: string, tx?: Client): Promise<number> {
  const c = tx ?? db;
  return c.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
}
