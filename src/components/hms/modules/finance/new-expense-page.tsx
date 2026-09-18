"use client";

// MOHD.HMS ENTERPRISE — dedicated "Add Expense" page (finance/expenses/new view).
// Replaces the old add-expense dialog. Draft protection (useDraft) kept with the
// same formKey so in-flight entries survive interruptions. No new APIs.

import { useEffect, useState } from "react";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { PERMISSIONS } from "@/lib/hms/constants";
import { toDateInput } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { AlertCircle, BadgeDollarSign, Loader2, Plus, Save } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

type EForm = { category: string; description: string; amount: string; expenseDate: string; receiptNo: string };

const CATEGORIES = ["MATERIALS", "FUEL", "RENT", "UTILITIES", "SALARIES", "EQUIPMENT", "TRANSPORT", "MAINTENANCE", "SUBCONTRACT", "GENERAL", "OTHER"];

const emptyExpenseForm = (): EForm => ({
  category: "MATERIALS", description: "", amount: "", expenseDate: toDateInput(new Date()), receiptNo: "",
});

// ── Page ──

export function FinanceNewExpensePage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const canManage = hasPerm(user, PERMISSIONS.finance_manage);

  const form = useDraft<EForm>({ formKey: "finance.expense.create", initial: emptyExpenseForm() });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Dirty-state wiring (central router guard + data protection) ──
  useEffect(() => {
    setPageDirty(form.dirty);
    return () => { setPageDirty(false); };
  }, [form.dirty, setPageDirty]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const amount = parseFloat(form.value.amount);
    if (!form.value.description.trim()) errs.description = "Describe what was purchased.";
    if (!form.value.amount.trim() || !isFinite(amount) || amount <= 0) errs.amount = "Enter a positive amount in BND.";
    return errs;
  }

  async function createExpense() {
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the highlighted fields", variant: "destructive" });
      return;
    }
    setSaving(true);
    setSubmitError(null);
    try {
      const res = await api.post<{ id: string; code: string }>("/api/v1/finance/expenses", {
        category: form.value.category,
        description: form.value.description.trim(),
        amount: parseFloat(form.value.amount),
        expenseDate: form.value.expenseDate || undefined,
        receiptNo: form.value.receiptNo || undefined,
      });
      toast({ title: `Expense ${res.data.code} submitted`, description: "Pending approval by finance." });
      form.reset(emptyExpenseForm());
      setPageDirty(false);
      navigateTo("finance", ["expenses"]);
    } catch (e) {
      // CRITICAL: keep every user-entered value on failure — show the error and allow retry.
      const msg = e instanceof ClientApiError ? e.message : "Could not create the expense. Please try again.";
      setSubmitError(msg);
      toast({ title: "Could not create expense", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageShell backLabel="Back to Finance" backHref="/finance" title="Add Expense">
        <EmptyState
          title="You don't have permission to record expenses"
          hint="Expense submission is limited to finance managers, admins and super admins. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const actions = (
    <Button onClick={() => void createExpense()} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
      {saving ? "Saving…" : "Submit expense"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Finance"
      backHref="/finance"
      crumbs={[{ label: "Finance", href: "/finance" }, { label: "Expenses", href: "/finance/expenses" }, { label: "New Expense" }]}
      title="Add Expense"
      description="Submitted expenses start as PENDING until a finance manager approves them."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{actions}</div>}
    >
      {submitError ? (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">The expense could not be submitted.</p>
            <p className="mt-0.5">{submitError} Your entries are preserved — you can retry.</p>
          </div>
        </div>
      ) : null}

      <Card className="shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Expense details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Category *</Label>
              <Select value={form.value.category} onValueChange={(v) => form.setValue({ category: v })}>
                <SelectTrigger aria-label="Category"><SelectValue /></SelectTrigger>
                <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fe-amount">Amount (BND) *</Label>
              <Input
                id="fe-amount"
                inputMode="decimal"
                value={form.value.amount}
                onChange={(e) => { form.setValue({ amount: e.target.value }); setErrors((p) => ({ ...p, amount: "" })); }}
                placeholder="0.00"
                aria-invalid={!!errors.amount}
                aria-describedby={errors.amount ? "fe-amount-err" : undefined}
              />
              {errors.amount ? <p id="fe-amount-err" className="text-xs text-destructive">{errors.amount}</p> : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fe-description">Description *</Label>
            <Input
              id="fe-description"
              value={form.value.description}
              onChange={(e) => { form.setValue({ description: e.target.value }); setErrors((p) => ({ ...p, description: "" })); }}
              placeholder="What was purchased?"
              aria-invalid={!!errors.description}
              aria-describedby={errors.description ? "fe-description-err" : undefined}
            />
            {errors.description ? <p id="fe-description-err" className="text-xs text-destructive">{errors.description}</p> : null}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="fe-date">Expense date</Label>
              <Input id="fe-date" type="date" value={form.value.expenseDate} onChange={(e) => form.setValue({ expenseDate: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fe-receipt">Receipt no.</Label>
              <Input id="fe-receipt" value={form.value.receiptNo} onChange={(e) => form.setValue({ receiptNo: e.target.value })} placeholder="Optional" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Draft hint */}
      <p className="mt-3 text-xs text-muted-foreground">
        {form.dirty
          ? "Draft auto-saved locally — safe to leave this page and restore the draft later."
          : "Tip: your entries auto-save as a draft while you type."}
      </p>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-2 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3 flex items-center gap-2">
          <Button
            variant="outline" className="flex-1"
            onClick={() => { form.saveNow(); toast({ title: "Draft saved successfully", description: "You can safely leave this page and restore the draft later." }); }}
            disabled={saving}
          >
            <Save className="h-4 w-4 mr-1.5" /> Save Draft
          </Button>
          <Button className="flex-1" onClick={() => void createExpense()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <BadgeDollarSign className="h-4 w-4 mr-1.5" />}
            {saving ? "Saving…" : "Submit expense"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
