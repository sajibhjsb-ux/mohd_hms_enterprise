"use client";

// HR ▸ Payroll ▸ Setup (spec §6/§7/§17/§18/§19): salary components catalog,
// effective-dated salary structures (history) and statutory rule management.
// All changes are audited server-side.

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { fmtDate, money, toDateInput } from "@/lib/hms/format";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageShell } from "@/components/hms/shared/page-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/hms/shared/ui-bits";

type Component = { id: string; name: string; type: string; category: string; description: string; system: boolean; active: boolean; usageCount: number };
type Structure = {
  id: string; employeeId: string; employeeNo: string; employeeName: string;
  componentId: string; componentName: string; componentCategory: string; componentType: string;
  amountCents: number; percentBps: number | null; effectiveFrom: string; effectiveTo: string | null; note: string;
};
type Rule = {
  id: string; name: string; payer: string; employeeCategory: string; calcType: string;
  rateBps: number; amountCents: number; appliesTo: string; thresholdCents: number;
  effectiveFrom: string; effectiveTo: string | null; calcOrder: number; active: boolean; reference: string;
};

export function PayrollSetupPage() {
  const { user } = useSession();
  const canManage = hasPerm(user, PERMISSIONS.payroll_manage);
  return (
    <PageShell
      backLabel="Back to HR" backHref="/hr"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Payroll", href: "/hr?tab=payroll" }, { label: "Setup" }]}
      title="Payroll Setup"
      description="Salary components, employee salary structures (effective-dated history) and statutory rules — all configurable, all audited."
    >
      <Tabs defaultValue="components" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="components">Components</TabsTrigger>
          <TabsTrigger value="salaries">Salary Structures</TabsTrigger>
          <TabsTrigger value="statutory">Statutory Rules</TabsTrigger>
        </TabsList>
        <TabsContent value="components"><ComponentsSection canManage={canManage} /></TabsContent>
        <TabsContent value="salaries"><SalariesSection canManage={canManage} /></TabsContent>
        <TabsContent value="statutory"><StatutorySection canManage={canManage} /></TabsContent>
      </Tabs>
    </PageShell>
  );
}

// ── Components ──────────────────────────────────────────────────────────────

function ComponentsSection({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Component[] | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", type: "EARNING", category: "ALLOWANCE", description: "" });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<Component[]>("/api/v1/hr/payroll/components");
    setRows(res.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setSaving(true);
    try {
      await api.post("/api/v1/hr/payroll/components", form);
      toast({ title: "Component created" });
      setOpen(false);
      setForm({ name: "", type: "EARNING", category: "ALLOWANCE", description: "" });
      await load();
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const cols: Column<Component>[] = [
    { key: "name", header: "Component", sortable: true, value: (r) => r.name, render: (r) => <span className="font-medium">{r.name}{r.system ? <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] uppercase">system</span> : null}</span> },
    { key: "type", header: "Type", value: (r) => r.type, render: (r) => humanize(r.type) },
    { key: "category", header: "Category", value: (r) => r.category, render: (r) => humanize(r.category) },
    { key: "usage", header: "In Use", value: (r) => r.usageCount, render: (r) => `${r.usageCount}` },
    { key: "active", header: "Status", render: (r) => <StatusBadge status={r.active ? "ACTIVE" : "INACTIVE"} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {canManage ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" />New Component</Button> : null}
      </div>
      {rows ? (
        <DataTable<Component> columns={cols} rows={rows} rowKey={(r) => r.id} searchPlaceholder="Search components…" exportName="salary-components" />
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New salary component</DialogTitle>
            <DialogDescription>Components are configurable building blocks of the calculation engine (§6).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Site Allowance" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v, category: v === "DEDUCTION" ? "OTHER" : "ALLOWANCE" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="EARNING">Earning</SelectItem>
                    <SelectItem value="DEDUCTION">Deduction</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(form.type === "EARNING" ? ["ALLOWANCE", "BONUS", "COMMISSION", "REIMBURSEMENT", "OTHER"] : ["LOAN", "ABSENCE", "OTHER"]).map((c) => (
                      <SelectItem key={c} value={c}>{humanize(c)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What is this component for?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={saving || form.name.trim().length < 2}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Salary structures (effective-dated history, §7) ─────────────────────────

function SalariesSection({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Structure[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [employees, setEmployees] = useState<{ id: string; label: string }[]>([]);
  const [components, setComponents] = useState<Component[]>([]);
  const [form, setForm] = useState({ employeeId: "", componentId: "", amount: "", effectiveFrom: toDateInput(new Date()), note: "" });

  const load = useCallback(async () => {
    const res = await api.get<Structure[]>("/api/v1/hr/payroll/salaries");
    setRows(res.data);
  }, []);
  useEffect(() => {
    void load();
    void (async () => {
      const [e, c] = await Promise.all([
        api.get<{ id: string; employeeNo: string; firstName: string; lastName: string; status: string }[]>(`/api/v1/employees${qs({ pageSize: 200 })}`),
        api.get<Component[]>("/api/v1/hr/payroll/components"),
      ]);
      setEmployees(e.data.map((x) => ({ id: x.id, label: `${x.employeeNo} ${x.firstName} ${x.lastName}` })));
      setComponents(c.data);
    })();
  }, [load]);

  const create = async () => {
    setSaving(true);
    try {
      await api.post("/api/v1/hr/payroll/salaries", {
        employeeId: form.employeeId, componentId: form.componentId,
        ...(form.amount ? { amount: form.amount } : {}),
        effectiveFrom: new Date(`${form.effectiveFrom}T00:00:00.000Z`).toISOString(),
        ...(form.note ? { note: form.note } : {}),
      });
      toast({ title: "Salary structure updated", description: "Previous version ended — history preserved (§7)." });
      setOpen(false);
      setForm({ employeeId: "", componentId: "", amount: "", effectiveFrom: toDateInput(new Date()), note: "" });
      await load();
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const cols: Column<Structure>[] = [
    {
      key: "employee", header: "Employee", sortable: true, value: (r) => r.employeeName,
      render: (r) => <div><div className="font-medium">{r.employeeName}</div><div className="text-xs text-muted-foreground">{r.employeeNo}</div></div>,
    },
    { key: "component", header: "Component", value: (r) => r.componentName, render: (r) => r.componentName },
    { key: "amount", header: "Amount", sortable: true, value: (r) => r.amountCents, render: (r) => (r.percentBps ? `${(r.percentBps / 100).toFixed(2)}% of basic` : money(r.amountCents)) },
    {
      key: "effective", header: "Effective", value: (r) => r.effectiveFrom,
      render: (r) => (
        <div className="text-xs">
          {fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">current</span>}
        </div>
      ),
    },
    { key: "note", header: "Note", value: (r) => r.note, hideOnMobile: true },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">Every change creates a new effective-dated version — salary history is never overwritten (§7).</p>
        {canManage ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" />Assign / Change</Button> : null}
      </div>
      {rows ? (
        <DataTable<Structure> columns={cols} rows={rows} rowKey={(r) => r.id} searchPlaceholder="Search employee or component…" exportName="salary-structures" />
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign salary component</DialogTitle>
            <DialogDescription>Creates a new version effective from the chosen date; any current version of the same component ends the day before.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <Select value={form.employeeId} onValueChange={(v) => setForm({ ...form, employeeId: v })}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>{employees.map((e) => <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Component</Label>
              <Select value={form.componentId} onValueChange={(v) => setForm({ ...form, componentId: v })}>
                <SelectTrigger><SelectValue placeholder="Select component" /></SelectTrigger>
                <SelectContent>{components.filter((c) => c.active).map((c) => <SelectItem key={c.id} value={c.id}>{c.name} ({humanize(c.type)})</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Monthly amount (BND)</Label>
                <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="4500.00" />
              </div>
              <div className="space-y-1.5">
                <Label>Effective from</Label>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Note</Label>
              <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. Annual increment" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={saving || !form.employeeId || !form.componentId || !form.amount}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Statutory rules (§18/§19) ───────────────────────────────────────────────

function StatutorySection({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Rule[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    name: "", payer: "EMPLOYEE", employeeCategory: "ALL", calcType: "PERCENTAGE",
    rateBps: "", amount: "", appliesTo: "GROSS", threshold: "", effectiveFrom: toDateInput(new Date()), reference: "", notes: "",
  });

  const load = useCallback(async () => {
    const res = await api.get<Rule[]>("/api/v1/hr/payroll/statutory");
    setRows(res.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setSaving(true);
    try {
      await api.post("/api/v1/hr/payroll/statutory", {
        name: form.name, payer: form.payer, employeeCategory: form.employeeCategory,
        calcType: form.calcType, appliesTo: form.appliesTo,
        ...(form.calcType === "PERCENTAGE" ? { rateBps: Math.round(Number(form.rateBps) * 100) } : { amount: form.amount }),
        ...(form.threshold ? { threshold: form.threshold } : {}),
        effectiveFrom: new Date(`${form.effectiveFrom}T00:00:00.000Z`).toISOString(),
        ...(form.reference ? { reference: form.reference } : {}),
        ...(form.notes ? { notes: form.notes } : {}),
      });
      toast({ title: "Statutory rule created", description: "Versioned by effective date (§18)." });
      setOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const cols: Column<Rule>[] = [
    {
      key: "name", header: "Rule", sortable: true, value: (r) => r.name,
      render: (r) => (
        <div>
          <div className="font-medium">{r.name}</div>
          <div className="text-xs text-muted-foreground">{humanize(r.employeeCategory)} · order {r.calcOrder}</div>
        </div>
      ),
    },
    { key: "payer", header: "Payer", value: (r) => r.payer, render: (r) => <span className={r.payer === "EMPLOYER" ? "text-sky-700 dark:text-sky-400" : ""}>{humanize(r.payer)}{r.payer === "EMPLOYER" ? " (cost only)" : ""}</span> },
    {
      key: "calc", header: "Calculation", value: (r) => r.rateBps,
      render: (r) => r.calcType === "PERCENTAGE" ? `${(r.rateBps / 100).toFixed(2)}% of ${r.appliesTo.toLowerCase()}` : `${money(r.amountCents)} fixed`,
    },
    {
      key: "effective", header: "Effective", value: (r) => r.effectiveFrom,
      render: (r) => <span className="text-xs">{fmtDate(r.effectiveFrom)} → {r.effectiveTo ? fmtDate(r.effectiveTo) : "—"}</span>,
    },
    { key: "active", header: "Status", render: (r) => <StatusBadge status={r.active ? "ACTIVE" : "INACTIVE"} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center gap-4">
        <p className="text-xs text-muted-foreground">Legal rates are configurable, versioned data — never hard-coded (§18). Rate changes: create a new dated version; deactivate the old row.</p>
        {canManage ? <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" />New Rule / Version</Button> : null}
      </div>
      {rows ? (
        <DataTable<Rule> columns={cols} rows={rows} rowKey={(r) => r.id} searchPlaceholder="Search rules…" exportName="statutory-rules" />
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New statutory rule</DialogTitle>
            <DialogDescription>EMPLOYEE rows deduct from net pay; EMPLOYER rows are company cost only (§19).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Rule name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. TAP — Employee (5%)" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Payer</Label>
                <Select value={form.payer} onValueChange={(v) => setForm({ ...form, payer: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="EMPLOYEE">Employee (deduction)</SelectItem><SelectItem value="EMPLOYER">Employer (cost)</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Applies to</Label>
                <Select value={form.employeeCategory} onValueChange={(v) => setForm({ ...form, employeeCategory: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All employees</SelectItem>
                    <SelectItem value="CITIZEN_PR">Citizens &amp; PR</SelectItem>
                    <SelectItem value="FOREIGN">Foreign</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.calcType} onValueChange={(v) => setForm({ ...form, calcType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="PERCENTAGE">Percentage</SelectItem><SelectItem value="FIXED">Fixed amount</SelectItem></SelectContent>
                </Select>
              </div>
              {form.calcType === "PERCENTAGE" ? (
                <div className="space-y-1.5">
                  <Label>Rate (%)</Label>
                  <Input type="number" step="0.01" min="0" value={form.rateBps} onChange={(e) => setForm({ ...form, rateBps: e.target.value })} placeholder="5.00" />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Amount (BND)</Label>
                  <Input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Base</Label>
                <Select value={form.appliesTo} onValueChange={(v) => setForm({ ...form, appliesTo: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="GROSS">Gross pay</SelectItem><SelectItem value="BASIC">Basic salary</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Effective from</Label>
                <Input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Reference / source</Label>
              <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} placeholder="e.g. TAP Act (Cap. 84) — verify before production" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={saving || form.name.trim().length < 2 || (form.calcType === "PERCENTAGE" ? !form.rateBps : !form.amount)}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
