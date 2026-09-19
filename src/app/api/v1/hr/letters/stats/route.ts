// MOHD.HMS ENTERPRISE — Letter dashboard quick stats (§51).
//
//   GET /api/v1/hr/letters/stats
//
//   { thisMonth, drafts, pendingApproval, approved, sent, templates }
//   Each KPI maps to the history page with a status filter (drill-down).

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { ensureLetterTemplatesBootstrapped } from "@/lib/hms/letters/bootstrap";

export const GET = handler(
  async () => {
    await ensureLetterTemplatesBootstrapped();

    // KPI window = this calendar month on the business clock (Asia/Brunei).
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const [thisMonth, drafts, pendingApproval, approved, sent, templates] = await Promise.all([
      db.letter.count({ where: { createdAt: { gte: monthStart } } }),
      db.letter.count({ where: { status: { in: ["DRAFT", "AI_GENERATED", "REJECTED"] } } }),
      db.letter.count({ where: { status: "UNDER_REVIEW" } }),
      db.letter.count({ where: { status: { in: ["APPROVED", "FINALIZED"] } } }),
      db.letter.count({ where: { status: "SENT" } }),
      db.letterTemplate.count({ where: { status: "ACTIVE" } }),
    ]);

    const byType = await db.letter.groupBy({ by: ["letterType"], _count: { _all: true } });

    return ok({
      thisMonth,
      drafts,
      pendingApproval,
      approved,
      sent,
      templates,
      byType: byType.map((t) => ({ letterType: t.letterType, count: t._count._all })),
    });
  },
  { permission: PERMISSIONS.letters_view }
);
