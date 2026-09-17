"use client";

// MOHD.HMS ENTERPRISE — Customers module.
// List + stat cards + create (draft-protected) / edit / detail / soft-delete.
// Portal account is provisioned inline during creation.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import type { Permission } from "@/lib/hms/constants";
import { fmtDate, money } from "@/lib/hms/format";
import { Building2, ClipboardList, KeyRound, Pencil, Plus, Receipt, RotateCcw, Trash2, Users, Wifi } from "lucide-react";

type CustomerRow = {
  id: string; code: string; companyName: string; contactPerson: string;
  email: string; phone: string; address: string; city: string; status: string; notes: string;
  createdAt: string;
  portalUser: { id: string; email: string; name: string; status: string } | null;
  _count: { equipment: number; complaints: number; invoices: number };
};

type CustomerDetail = CustomerRow & {
  _count: { equipment: number; complaints: number; invoices: number; workOrders: number; quotations: number; payments: number };
  complaints: { id: string; code: string; title: string; status: string; priority: string; createdAt: string }[];
  invoices: { id: string; code: string; totalCents: number; paidCents: number; status: string; invoiceDate: string }[];
};

// The DRAFT never stores secrets (see use-draft contract) — portalPassword is
// kept in transient state outside the persisted draft.
type FormState = {
  companyName: string; contactPerson: string; email: string; phone: string;
  address: string; city: string; notes: string; portalEmail: string;
};

const EMPTY_FORM: FormState = {
  companyName: "", contactPerson: "", email: "", phone: "",
  address: "", city: "", notes: "", portalEmail: "",
};

type FieldErrors = Record<string, string>;

function extractFieldErrors(e: unknown): FieldErrors {
  if (e instanceof ClientApiError && Array.isArray(e.details)) {
    const out: FieldErrors = {};
    for (const d of e.details as { path?: string; message?: string }[]) {
      if (d?.path && d?.message) out[d.path] = d.message;
    }
    return out;
  }
  return {};
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

export function CustomersModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog + draft protection
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [portalPassword, setPortalPassword] = useState(""); // transient, never drafted
  const draft = useDraft<FormState>({ formKey: "customer.create", initial: EMPTY_FORM });

  // Edit dialog
  const [editRow, setEditRow] = useState<CustomerRow | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  // Detail dialog
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Delete confirm
  const [deleteRow, setDeleteRow] = useState<CustomerRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<CustomerRow[]>(`/api/v1/customers${qs({ pageSize: 200 })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => {
    setFieldErrors({});
    setPortalPassword("");
    setCreateOpen(true);
  };

  const openEdit = (row: CustomerRow) => {
    setFieldErrors({});
    setEditRow(row);
    setEditForm({
      companyName: row.companyName, contactPerson: row.contactPerson, email: row.email,
      phone: row.phone, address: row.address, city: row.city, notes: row.notes,
      portalEmail: "",
    });
  };

  const openDetail = (row: CustomerRow) => {
    setDetailId(row.id);
    setDetail(null);
    setDetailLoading(true);
    api.get<CustomerDetail>(`/api/v1/customers/${row.id}`)
      .then((res) => setDetail(res.data))
      .catch((e) => toast({ title: "Could not load customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" }))
      .finally(() => setDetailLoading(false));
  };

  async function submitCreate() {
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<CustomerRow>("/api/v1/customers", {
        companyName: draft.value.companyName,
        contactPerson: draft.value.contactPerson,
        email: draft.value.email,
        phone: draft.value.phone,
        address: draft.value.address || undefined,
        city: draft.value.city || undefined,
        notes: draft.value.notes || undefined,
        portalEmail: draft.value.portalEmail || undefined,
        portalPassword: portalPassword || undefined,
      });
      toast({
        title: "Customer created",
        description: `${res.data.companyName} (${res.data.code})${res.data.portalUser ? " — portal account ready" : ""}.`,
      });
      draft.reset(EMPTY_FORM);
      setPortalPassword("");
      setCreateOpen(false);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not create customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editRow) return;
    setSaving(true);
    setFieldErrors({});
    try {
      await api.patch(`/api/v1/customers/${editRow.id}`, {
        companyName: editForm.companyName,
        contactPerson: editForm.contactPerson,
        email: editForm.email,
        phone: editForm.phone,
        address: editForm.address || undefined,
        city: editForm.city || undefined,
        notes: editForm.notes || undefined,
      });
      toast({ title: "Customer updated", description: `${editForm.companyName} saved.` });
      setEditRow(null);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not update customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitDelete() {
    if (!deleteRow) return;
    setDeleting(true);
    try {
      const res = await api.del<{ deleted?: boolean; softDeleted?: boolean }>(`/api/v1/customers/${deleteRow.id}`);
      toast({
        title: res.data.softDeleted ? "Customer deactivated" : "Customer deleted",
        description: res.data.softDeleted
          ? "The customer has linked records, so it was set to INACTIVE instead of removed."
          : `${deleteRow.companyName} removed.`,
      });
      setDeleteRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not delete customer", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  const totalEquipment = rows.reduce((s, r) => s + r._count.equipment, 0);
  const portalCount = rows.filter((r) => r.portalUser).length;
  const activeCount = rows.filter((r) => r.status === "ACTIVE").length;

  const columns: Column<CustomerRow>[] = [
    { key: "code", header: "Code", value: (r) => r.code, className: "font-mono text-xs whitespace-nowrap" },
    {
      key: "companyName", header: "Company", value: (r) => r.companyName,
      render: (r) => (
        <div className="min-w-[160px]">
          <div className="font-medium truncate">{r.companyName}</div>
          <div className="text-xs text-muted-foreground truncate">{r.contactPerson}</div>
        </div>
      ),
    },
    {
      key: "email", header: "Contact", value: (r) => `${r.email} ${r.phone}`,
      render: (r) => (
        <div className="min-w-[150px]">
          <div className="text-sm truncate">{r.email}</div>
          <div className="text-xs text-muted-foreground">{r.phone}</div>
        </div>
      ),
      hideOnMobile: true,
    },
    { key: "city", header: "City", value: (r) => r.city, render: (r) => r.city || "—", hideOnMobile: true },
    { key: "equipment", header: "Equipment", value: (r) => r._count.equipment, render: (r) => r._count.equipment },
    { key: "complaints", header: "Complaints", value: (r) => r._count.complaints, render: (r) => r._count.complaints, hideOnMobile: true },
    { key: "invoices", header: "Invoices", value: (r) => r._count.invoices, render: (r) => r._count.invoices, hideOnMobile: true },
    {
      key: "portal", header: "Portal", value: (r) => (r.portalUser ? "yes" : "no"),
      render: (r) =>
        r.portalUser ? (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-100 rounded-full px-2 py-0.5">
            <Wifi className="h-3 w-3" /> {r.portalUser.email}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
      hideOnMobile: true,
    },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", header: "", sortable: false,
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openDetail(r)} aria-label={`View ${r.companyName}`}>
            <Users className="h-4 w-4" />
          </Button>
          {can("customers.update") ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)} aria-label={`Edit ${r.companyName}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {can("customers.delete") ? (
            <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setDeleteRow(r)} aria-label={`Delete ${r.companyName}`}>
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
      className: "w-4",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Customers"
        subtitle="Corporate accounts, portal access and engagement overview"
        actions={
          can("customers.create") ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> New Customer
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <StatCard title="Customers" value={rows.length} icon={<Building2 className="h-5 w-5" />} loading={loading} />
        <StatCard title="Active" value={activeCount} icon={<ClipboardList className="h-5 w-5" />} tone="success" loading={loading} />
        <StatCard title="Portal accounts" value={portalCount} icon={<KeyRound className="h-5 w-5" />} loading={loading} />
        <StatCard title="Equipment units" value={totalEquipment} icon={<Receipt className="h-5 w-5" />} loading={loading} />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading customers…" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={openDetail}
          searchPlaceholder="Search company, contact, email, code…"
          filters={[
            {
              key: "status", label: "Status",
              options: [{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }],
              match: (r, v) => r.status === v,
            },
          ]}
          emptyTitle="No customers yet"
          emptyHint={can("customers.create") ? "Create your first customer to start tracking equipment and service." : "Customers will appear here once created."}
          exportName="customers"
        />
      )}

      {/* Create dialog (draft-protected) */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New customer</DialogTitle>
            <DialogDescription>Code is generated automatically. Optionally provision a portal login.</DialogDescription>
          </DialogHeader>

          {draft.draftExists ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
              <span className="flex-1 min-w-[140px]">You have an unsent draft from a previous session.</span>
              <Button size="sm" variant="outline" onClick={draft.restore}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore draft
              </Button>
              <Button size="sm" variant="ghost" onClick={draft.discard}>Discard</Button>
            </div>
          ) : draft.dirty && draft.lastSavedAt ? (
            <p className="text-xs text-muted-foreground">Draft saved automatically at {draft.lastSavedAt.toLocaleTimeString()} — restored automatically if you leave.</p>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="cus-name">Company name *</Label>
              <Input id="cus-name" value={draft.value.companyName} onChange={(e) => draft.setValue({ companyName: e.target.value })} placeholder="e.g. Metro Tower Facilities" />
              <FieldError msg={fieldErrors.companyName} />
            </div>
            <div>
              <Label htmlFor="cus-contact">Contact person *</Label>
              <Input id="cus-contact" value={draft.value.contactPerson} onChange={(e) => draft.setValue({ contactPerson: e.target.value })} placeholder="Full name" />
              <FieldError msg={fieldErrors.contactPerson} />
            </div>
            <div>
              <Label htmlFor="cus-phone">Phone *</Label>
              <Input id="cus-phone" value={draft.value.phone} onChange={(e) => draft.setValue({ phone: e.target.value })} placeholder="+60 3-…" />
              <FieldError msg={fieldErrors.phone} />
            </div>
            <div>
              <Label htmlFor="cus-email">Email *</Label>
              <Input id="cus-email" type="email" value={draft.value.email} onChange={(e) => draft.setValue({ email: e.target.value })} placeholder="contact@company.my" />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="cus-city">City</Label>
              <Input id="cus-city" value={draft.value.city} onChange={(e) => draft.setValue({ city: e.target.value })} placeholder="Kuala Lumpur" />
              <FieldError msg={fieldErrors.city} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-address">Address</Label>
              <Input id="cus-address" value={draft.value.address} onChange={(e) => draft.setValue({ address: e.target.value })} placeholder="Street, building, postcode" />
              <FieldError msg={fieldErrors.address} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-notes">Notes</Label>
              <Textarea id="cus-notes" rows={2} value={draft.value.notes} onChange={(e) => draft.setValue({ notes: e.target.value })} placeholder="Internal notes (optional)" />
              <FieldError msg={fieldErrors.notes} />
            </div>

            <div className="sm:col-span-2 rounded-lg border bg-muted/40 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> CUSTOMER PORTAL ACCESS (OPTIONAL)
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="cus-portal-email">Portal email</Label>
                  <Input id="cus-portal-email" type="email" value={draft.value.portalEmail} onChange={(e) => draft.setValue({ portalEmail: e.target.value })} placeholder="portal@company.my" />
                  <FieldError msg={fieldErrors.portalEmail} />
                </div>
                <div>
                  <Label htmlFor="cus-portal-pw">Portal password</Label>
                  <Input id="cus-portal-pw" type="text" autoComplete="off" value={portalPassword} onChange={(e) => setPortalPassword(e.target.value)} placeholder="Min 8 chars, letters + numbers" />
                  <FieldError msg={fieldErrors.portalPassword} />
                </div>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={saving}>{saving ? "Creating…" : "Create customer"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit {editRow?.companyName}</DialogTitle>
            <DialogDescription>Code {editRow?.code} · status and portal accounts are managed from the list.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-name">Company name</Label>
              <Input id="cus-e-name" value={editForm.companyName} onChange={(e) => setEditForm((f) => ({ ...f, companyName: e.target.value }))} />
              <FieldError msg={fieldErrors.companyName} />
            </div>
            <div>
              <Label htmlFor="cus-e-contact">Contact person</Label>
              <Input id="cus-e-contact" value={editForm.contactPerson} onChange={(e) => setEditForm((f) => ({ ...f, contactPerson: e.target.value }))} />
              <FieldError msg={fieldErrors.contactPerson} />
            </div>
            <div>
              <Label htmlFor="cus-e-phone">Phone</Label>
              <Input id="cus-e-phone" value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
              <FieldError msg={fieldErrors.phone} />
            </div>
            <div>
              <Label htmlFor="cus-e-email">Email</Label>
              <Input id="cus-e-email" type="email" value={editForm.email} onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="cus-e-city">City</Label>
              <Input id="cus-e-city" value={editForm.city} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-address">Address</Label>
              <Input id="cus-e-address" value={editForm.address} onChange={(e) => setEditForm((f) => ({ ...f, address: e.target.value }))} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cus-e-notes">Notes</Label>
              <Textarea id="cus-e-notes" rows={2} value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog */}
      <Dialog open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detailLoading ? "Loading…" : detail?.companyName}
              {detail ? <StatusBadge status={detail.status} /> : null}
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.code} · ${detail.contactPerson} · ${detail.email} · ${detail.phone}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatCard title="Equipment" value={detail._count.equipment} />
                <StatCard title="Complaints" value={detail._count.complaints} />
                <StatCard title="Work orders" value={detail._count.workOrders} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Address</p>
                  <p>{[detail.address, detail.city].filter(Boolean).join(", ") || "—"}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Portal account</p>
                  <p className="flex items-center gap-2">
                    {detail.portalUser ? (
                      <>
                        <StatusBadge status={detail.portalUser.status} />
                        <span className="truncate">{detail.portalUser.email}</span>
                      </>
                    ) : "No portal user"}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Quotations / Invoices</p>
                  <p>{detail._count.quotations} / {detail._count.invoices}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">Customer since</p>
                  <p>{fmtDate(detail.createdAt)}</p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Recent complaints</p>
                {detail.complaints.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No complaints logged.</p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {detail.complaints.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{c.code}</span>
                        <span className="flex-1 min-w-0 truncate text-sm">{c.title}</span>
                        <StatusBadge status={c.priority} />
                        <StatusBadge status={c.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Recent invoices</p>
                {detail.invoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No invoices issued.</p>
                ) : (
                  <div className="divide-y rounded-lg border">
                    {detail.invoices.map((inv) => (
                      <div key={inv.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="font-mono text-xs text-muted-foreground w-24 shrink-0">{inv.code}</span>
                        <span className="flex-1 text-sm">{money(inv.totalCents)} <span className="text-muted-foreground">({money(inv.paidCents)} paid)</span></span>
                        <StatusBadge status={inv.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <LoadingState label="Loading customer…" rows={2} />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteRow?.companyName}?</AlertDialogTitle>
            <AlertDialogDescription>
              If this customer has equipment, complaints or invoices it will be deactivated (status INACTIVE) instead of removed, keeping history intact.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(e) => { e.preventDefault(); submitDelete(); }}>
              {deleting ? "Working…" : "Delete customer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
