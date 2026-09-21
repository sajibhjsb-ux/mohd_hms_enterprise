"use client";

// Profile ▸ My Payslips (payroll spec §51 — employee self-service).
// Employees see THEIR OWN payslips, salary history and deductions only; the
// server enforces ownership (spec §30) — this card renders the same
// session-scoped data for display convenience.

import { useCallback, useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { fmtDate, money } from "@/lib/hms/format";
import { humanize } from "@/lib/hms/constants";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { PayrollLine } from "@/lib/hms/payroll/config";

type MyPayslip = {
  id: string;
  runCode: string;
  runName: string;
  periodStart: string;
  periodEnd: string;
  periodStatus: string;
  payDate: string | null;
  paymentRef: string;
  status: string;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  hasPayslipPdf: boolean;
  payslipGeneratedAt: string | null;
  lines: PayrollLine[];
};

type MyPayroll = {
  hasEmployeeRecord: boolean;
  employee?: { employeeNo: string; name: string; position: string; currentBasicCents: number };
  payslips: MyPayslip[];
  salary: { id: string; component: string; category: string; type: string; amountCents: number; percentBps: number | null; effectiveFrom: string; effectiveTo: string | null; note: string }[];
};

export function MyPayslipsCard() {
  const { toast } = useToast();
  const [data, setData] = useState<MyPayroll | null>(null);
  const [selected, setSelected] = useState<MyPayslip | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<MyPayroll>("/api/v1/hr/payroll/my");
      setData(res.data);
    } catch {
      // Self-service is silent-fail: the card simply doesn't render.
      setData(null);
    }
  }, []);
  useEffect(() => {
    // rAF off-path (house pattern) — see payroll-tab.
    const raf = requestAnimationFrame(() => { void load(); });
    return () => cancelAnimationFrame(raf);
  }, [load]);

  if (!data?.hasEmployeeRecord) return null;

  const current = data.payslips[0] ?? null;

  return (
    <Card data-testid="my-payslips">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">My Payslips</CardTitle>
        <CardDescription>
          {data.employee ? `${data.employee.employeeNo} · ${data.employee.position || "Staff"}` : ""} — your payroll information is confidential and visible only to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.payslips.length === 0 ? (
          <p className="text-sm text-muted-foreground">No payslips yet. Your first payslip appears after your employer runs payroll.</p>
        ) : (
          <>
            {current ? (
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{current.runName}</div>
                    <div className="text-xs text-muted-foreground">
                      Pay period {fmtDate(current.periodStart)} – {fmtDate(current.periodEnd)}
                      {current.payDate ? ` · paid ${fmtDate(current.payDate)}` : " · pay date pending"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-bold tabular-nums">{money(current.netCents)}</div>
                    <div className="text-[11px] text-muted-foreground">net pay · {humanize(current.periodStatus)}</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => setSelected(current)} data-testid="view-latest-payslip">
                    <FileText className="h-3.5 w-3.5 mr-1.5" />Details
                  </Button>
                  {current.hasPayslipPdf ? (
                    <a href={`/api/v1/hr/payroll/items/${current.id}/payslip`} target="_blank" rel="noreferrer" data-testid="download-latest-payslip">
                      <Button size="sm" variant="outline"><Download className="h-3.5 w-3.5 mr-1.5" />Payslip PDF</Button>
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}

            {data.payslips.length > 1 ? (
              <div className="space-y-1.5">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Previous payslips</h4>
                {data.payslips.slice(1, 7).map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <div>
                      <span className="font-medium">{p.runName}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{fmtDate(p.periodEnd)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">{money(p.netCents)}</span>
                      {p.hasPayslipPdf ? (
                        <a href={`/api/v1/hr/payroll/items/${p.id}/payslip`} target="_blank" rel="noreferrer" aria-label={`Open ${p.runName} payslip`}>
                          <Button size="sm" variant="ghost" className="h-7 px-2"><FileText className="h-3.5 w-3.5" /></Button>
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}

        {/* §51 — salary history where company policy allows (own record) */}
        {data.salary.length > 0 ? (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">My salary history</h4>
            <div className="space-y-1">
              {data.salary.slice(0, 6).map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>{s.component}{s.note ? <span className="ml-1.5 text-xs text-muted-foreground">{s.note}</span> : null}</span>
                  <span className="flex items-center gap-2 tabular-nums">
                    <Badge variant="outline" className={s.effectiveTo ? "" : "border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400"}>
                      {s.effectiveTo ? `${fmtDate(s.effectiveFrom)} → ${fmtDate(s.effectiveTo)}` : "current"}
                    </Badge>
                    {s.percentBps ? `${(s.percentBps / 100).toFixed(2)}%` : money(s.amountCents)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="sm:max-w-lg p-0">
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle>{selected?.runName}</DialogTitle>
            <DialogDescription>Pay period {selected ? `${fmtDate(selected.periodStart)} – ${fmtDate(selected.periodEnd)}` : ""}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[55vh] px-6 pb-6">
            {selected ? (
              <div className="space-y-3 text-sm">
                <LineBlock title="Earnings" rows={selected.lines.filter((l) => l.kind === "EARNING")} />
                <LineBlock title="Deductions" rows={selected.lines.filter((l) => l.kind === "DEDUCTION")} />
                <div className="rounded-lg border bg-muted/40 p-3">
                  <div className="flex justify-between py-0.5"><span>Gross Pay</span><span className="tabular-nums">{money(selected.grossCents)}</span></div>
                  <div className="flex justify-between py-0.5"><span>Total Deductions</span><span className="tabular-nums">− {money(selected.deductionsCents)}</span></div>
                  <div className="flex justify-between border-t pt-1.5 mt-1.5 font-semibold"><span>Net Pay</span><span className="tabular-nums">{money(selected.netCents)}</span></div>
                </div>
              </div>
            ) : null}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function LineBlock({ title, rows }: { title: string; rows: PayrollLine[] }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <tbody>
              {rows.map((l) => (
                <tr key={l.code + l.label} className="border-b last:border-b-0">
                  <td className="px-3 py-1.5">
                    <span className="font-medium">{l.label}</span>
                    {l.detail ? <span className="block text-xs text-muted-foreground">{l.detail}</span> : null}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{money(l.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
