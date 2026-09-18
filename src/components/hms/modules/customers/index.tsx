"use client";

// MOHD.HMS ENTERPRISE — Customers module (list page).
// Corporate accounts, portal access and engagement overview. Soft delete keeps
// history intact when linked records exist.
//
// NAVIGATION ARCHITECTURE (no popup CRUD): customer create / detail / edit are
// DEDICATED PAGES routed by the hash router (ui-store pages["customers"]):
//   []            → this list page
//   ["new"]       → CustomerNewPage   (#/customers/new)
//   [id]          → CustomerDetailPage (#/customers/{id})
//   [id, "edit"]  → CustomerEditPage   (#/customers/{id}/edit)
// Only the delete confirmation remains an AlertDialog (confirm-only dialog,
// allowed by the navigation contract).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatCard, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Building2, ClipboardList, KeyRound, Pencil, Plus, Receipt, Trash2, Users, Wifi } from "lucide-react";
import { CustomerNewPage } from "./new-page";
import { CustomerDetailPage } from "./detail-page";
import { CustomerEditPage } from "./edit-page";

// ── Types ──

type CustomerRow = {
  id: string; code: string; companyName: string; contactPerson: string;
  email: string; phone: string; address: string; city: string; status: string; notes: string;
  createdAt: string;
  portalUser: { id: string; email: string; name: string; status: string } | null;
  _count: { equipment: number; complaints: number; invoices: number };
};

// ── Module router ──

export function CustomersModule() {
  const seg = useUi((s) => s.pages["customers"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <CustomerNewPage />;
  if (page.view === "detail" && page.id) return <CustomerDetailPage id={page.id} />;
  if (page.view === "edit" && page.id) return <CustomerEditPage id={page.id} />;
  return <CustomersList />;
}

// ── List page ──

function CustomersList() {
  const { user } = useSession();
  const { toast } = useToast();
  const canCreate = hasPerm(user, PERMISSIONS.customers_create);
  const canUpdate = hasPerm(user, PERMISSIONS.customers_update);
  const canDelete = hasPerm(user, PERMISSIONS.customers_delete);

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("customers", seg), []);

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Delete confirm (the only remaining dialog in this module)
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
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage([r.id])} aria-label={`View ${r.companyName}`}>
            <Users className="h-4 w-4" />
          </Button>
          {canUpdate ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage([r.id, "edit"])} aria-label={`Edit ${r.companyName}`}>
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          {canDelete ? (
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
          canCreate ? (
            <Button onClick={() => openPage(["new"])}>
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
      ) : rows.length === 0 ? (
        <EmptyState
          title="No customers yet"
          hint={canCreate ? "Create your first customer to start tracking equipment and service." : "Customers will appear here once created."}
          action={
            canCreate ? (
              <Button variant="outline" onClick={() => openPage(["new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> New Customer
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPage([r.id])}
          searchPlaceholder="Search company, contact, email, code…"
          filters={[
            {
              key: "status", label: "Status",
              options: [{ value: "ACTIVE", label: "Active" }, { value: "INACTIVE", label: "Inactive" }],
              match: (r, v) => r.status === v,
            },
          ]}
          emptyTitle="No customers match"
          emptyHint="Try clearing the search or filters."
          exportName="customers"
        />
      )}

      {/* Delete confirm — the only dialog kept in this module (confirm-only). */}
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
