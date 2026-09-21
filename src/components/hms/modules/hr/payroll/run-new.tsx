"use client";

// HR ▸ Payroll ▸ New run page (spec §8/§10). Creates a DRAFT run for one
// period; the server rejects duplicates (§55).

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { toDateInput } from "@/lib/hms/format";
import { navigateTo } from "@/lib/hms/router";
import { useUi } from "@/lib/hms/ui-store";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type NewRunResponse = { id: string; code: string };

export function PayrollRunNewPage() {
  const setPageDirty = useUi((s) => s.setPageDirty);
  const { toast } = useToast();

  const now = new Date();
  const [period, setPeriod] = useState(`${now.getUTCFullYear()}-${`${now.getUTCMonth() + 1}`.padStart(2, "0")}`);
  const [name, setName] = useState("");
  const [payDate, setPayDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => setPageDirty(false);
  }, [setPageDirty]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await api.post<NewRunResponse>("/api/v1/hr/payroll/runs", {
        period,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(payDate ? { payDate: new Date(`${payDate}T00:00:00.000Z`).toISOString() } : {}),
      });
      toast({ title: "Payroll run created", description: `${res.data.code} is ready to calculate.` });
      setPageDirty(false);
      navigateTo("hr", ["payroll", res.data.id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create the payroll run.";
      setError(message);
      setPageDirty(true);
    } finally {
      setSaving(false);
    }
  }, [period, name, payDate, setPageDirty, toast]);

  return (
    <PageShell
      backLabel="Back to HR"
      backHref="/hr"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Payroll" }, { label: "New Run" }]}
      title="New Payroll Run"
      description="Choose a payroll period. Eligible employees are selected automatically when you calculate (§9)."
    >
      <Card className="max-w-xl">
        <CardContent className="p-6">
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="pay-period">Payroll period (month)</Label>
              <Input
                id="pay-period"
                type="month"
                value={period}
                onChange={(e) => { setPeriod(e.target.value); setPageDirty(true); }}
                required
                data-testid="run-period"
              />
              <p className="text-xs text-muted-foreground">The period runs from the 1st to the last day of the month.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-name">Name (optional)</Label>
              <Input
                id="pay-name"
                placeholder="e.g. September 2026 Payroll"
                value={name}
                onChange={(e) => { setName(e.target.value); setPageDirty(true); }}
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-date">Planned pay date (optional)</Label>
              <Input
                id="pay-date"
                type="date"
                value={payDate}
                min={toDateInput(new Date())}
                onChange={(e) => { setPayDate(e.target.value); setPageDirty(true); }}
              />
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={saving || !period} data-testid="run-create-submit">
                {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Create draft run
              </Button>
              <Button type="button" variant="outline" onClick={() => navigateTo("hr", [])}>Cancel</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </PageShell>
  );
}
