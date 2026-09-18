// MOHD.HMS ENTERPRISE — Reports CSV export.
// GET /api/v1/reports/export?type=...&from=...&to=... (same contract as /api/v1/reports)
// Streams the aggregated rows as a downloadable CSV (BOM-prefixed for Excel).

import { NextRequest, NextResponse } from "next/server";
import { handler } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
// Reuse the aggregation pipeline from the reports collection endpoint (same
// query params, same permission checks — export additionally requires reports.export).
import { GET as fetchReport } from "../route";

type Row = Record<string, unknown>;

function csvEscape(value: unknown): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// Money columns (integer cents) export as plain 2dp decimal numbers — the
// currency is declared once in the report header line (BND).
function csvCell(key: string, value: unknown): string {
  if (/cents$/i.test(key)) {
    const n = Number(value ?? 0) / 100;
    return csvEscape(n.toFixed(2));
  }
  return csvEscape(value);
}

export const GET = handler(
  async ({ req }) => {
    // Run the standard report pipeline (validates params + permissions).
    const res = await fetchReport(req as NextRequest);
    const body = (await res.json()) as
      | { ok: true; data: { type?: string; from?: string; to?: string; rows?: Row[] } }
      | { ok: false; error: { code: string; message: string } };

    if (!body.ok) {
      return NextResponse.json(body, { status: res.status });
    }

    const rows = Array.isArray(body.data.rows) ? body.data.rows : [];
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    // §37 — the report must clearly identify its currency (BND, Brunei Darussalam).
    const lines: string[] = [
      csvEscape(`MOHD.HMS ENTERPRISE — Currency: BND (Brunei Darussalam)`),
      headers.map(csvEscape).join(","),
    ];
    for (const row of rows) {
      lines.push(headers.map((h) => csvCell(h, row[h])).join(","));
    }
    // \uFEFF BOM so Excel opens UTF-8 correctly.
    const csv = "\uFEFF" + lines.join("\r\n");

    const type = body.data.type ?? "report";
    const from = body.data.from ?? "";
    const to = body.data.to ?? "";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="report-${type}-${from}-to-${to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  },
  { permission: PERMISSIONS.reports_export }
);
