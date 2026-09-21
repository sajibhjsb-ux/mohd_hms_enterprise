"use client";

// MOHD.HMS ENTERPRISE — Users module (list page).
// Staff account management: role badges, portal-user toggle, disable confirm,
// inline re-enable. Create / edit / password-reset live on DEDICATED PAGES.
//
// NAVIGATION ARCHITECTURE (no popup CRUD): user create / edit are DEDICATED
// PAGES routed by the hash router (ui-store pages["users"]):
//   []            → this list page
//   ["new"]       → UserNewPage    (/users/new)
//   [id]          → UserEditPage   (/users/{id})     — no separate detail
//   [id, "edit"]  → UserEditPage   (/users/{id}/edit) — profile + password
// Only the disable confirmation remains an AlertDialog (confirm-only dialog).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import type { Permission } from "@/lib/hms/constants";
import { humanize } from "@/lib/hms/constants";
import { customerLabel, fmtDateTime } from "@/lib/hms/format";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { EyeOff, Eye, KeyRound, Pencil, Plus, ShieldCheck, UserX } from "lucide-react";
import { UserNewPage } from "./new-page";
import { UserEditPage } from "./edit-page";
import { PhoneRequestsCard } from "./phone-requests";

// ── Types & constants ──

type UserRow = {
  id: string; email: string; name: string; phone: string | null; role: string; status: string;
  lastLoginAt: string | null; createdAt: string;
  customer: { id: string; companyName: string; code: string; contactPerson?: string } | null;
  technicianProfile: { id: string; employeeNo: string; specialty: string; status: string } | null;
  positionId: string | null;
  position: { id: string; name: string } | null;
};

const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const;

const ROLE_TONE: Record<string, string> = {
  SUPER_ADMIN: "bg-purple-100 text-purple-800 border-purple-200",
  ADMIN: "bg-emerald-100 text-emerald-800 border-emerald-200",
  SUPERVISOR: "bg-teal-100 text-teal-800 border-teal-200",
  TECHNICIAN: "bg-amber-100 text-amber-800 border-amber-200",
  FINANCE: "bg-sky-100 text-sky-800 border-sky-200",
  HR: "bg-rose-100 text-rose-800 border-rose-200",
  CUSTOMER: "bg-stone-100 text-stone-700 border-stone-200",
};

function RoleBadge({ role }: { role: string }) {
  return (
    <Badge variant="outline" className={`font-medium border whitespace-nowrap ${ROLE_TONE[role] ?? "bg-stone-100 text-stone-700 border-stone-200"}`}>
      {humanize(role)}
    </Badge>
  );
}

// ── Module router ──

export function UsersModule() {
  const seg = useUi((s) => s.pages["users"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "new") return <UserNewPage />;
  // No separate detail page — both [id] and [id, "edit"] open the edit page.
  if ((page.view === "edit" || page.view === "detail") && page.id) return <UserEditPage id={page.id} />;
  return <UsersList />;
}

// ── List page ──

function UsersList() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);
  const canUpdate = can("users.update");
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  // All page navigation flows through the hash router (URL + Back/Forward).
  const openPage = useCallback((seg: string[]) => navigateTo("users", seg), []);

  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeCustomers, setIncludeCustomers] = useState(false);
  const [saving, setSaving] = useState(false);

  // Disable confirm (the only remaining dialog in this module)
  const [disableRow, setDisableRow] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<UserRow[]>(`/api/v1/users${qs({ pageSize: 200, includeCustomers: includeCustomers ? 1 : undefined })}`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [includeCustomers]);

  useEffect(() => { load(); }, [load]);

  // Realtime: user/role changes refresh the list live.
  useRealtimeEvent(MODULE_EVENTS.users, () => { void load(); });

  async function submitDisable() {
    if (!disableRow) return;
    setSaving(true);
    try {
      await api.del(`/api/v1/users/${disableRow.id}`);
      toast({ title: "Account disabled", description: `${disableRow.name} can no longer sign in. Their sessions were revoked.` });
      setDisableRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not disable account", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function reEnable(row: UserRow) {
    try {
      await api.patch(`/api/v1/users/${row.id}`, { status: "ACTIVE" });
      toast({ title: "Account re-enabled", description: `${row.name} can sign in again.` });
      load();
    } catch (e) {
      toast({ title: "Could not enable account", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    }
  }

  /** Row click opens the edit page — but only where editing is actually possible. */
  const rowClickable = (r: UserRow) => canUpdate && !(r.role === "SUPER_ADMIN" && !isSuperAdmin);

  const columns: Column<UserRow>[] = [
    {
      key: "name", header: "User", value: (r) => r.name,
      render: (r) => (
        <div className="min-w-[150px]">
          <div className="font-medium truncate">{r.name}{r.id === user?.id ? <span className="text-xs text-muted-foreground"> (you)</span> : null}</div>
          <div className="text-xs text-muted-foreground truncate">{r.email}</div>
        </div>
      ),
    },
    {
      key: "role", header: "Role", value: (r) => r.role,
      render: (r) => (
        <div className="space-y-1">
          <RoleBadge role={r.role} />
          {r.technicianProfile ? <div className="text-xs text-muted-foreground">{r.technicianProfile.employeeNo}</div> : null}
        </div>
      ),
    },
    {
      // POSITION column — its OWN column, never merged with the role badge
      // (role/position spec §7: the distinction must be obvious).
      key: "position", header: "Position", value: (r) => r.position?.name ?? "",
      render: (r) => (r.position?.name ? <span className="text-sm">{r.position.name}</span> : <span className="text-muted-foreground">—</span>),
      hideOnMobile: true,
    },
    { key: "phone", header: "Phone", value: (r) => r.phone ?? "", render: (r) => r.phone || "—", hideOnMobile: true },
    {
      key: "customer", header: "Linked customer", value: (r) => customerLabel(r.customer),
      render: (r) => (r.customer ? <span className="text-xs">{customerLabel(r.customer)}</span> : <span className="text-muted-foreground">—</span>),
      hideOnMobile: true,
    },
    {
      key: "lastLoginAt", header: "Last login", value: (r) => r.lastLoginAt ?? "",
      render: (r) => <span className="text-xs">{r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : "Never"}</span>,
      hideOnMobile: true,
    },
    { key: "status", header: "Status", value: (r) => r.status, render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "actions", header: "", sortable: false,
      render: (r) => {
        const isSelf = r.id === user?.id;
        const guarded = r.role === "SUPER_ADMIN" && !isSuperAdmin;
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            {canUpdate && !guarded ? (
              <>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage([r.id, "edit"])} aria-label={`Edit ${r.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openPage([r.id, "edit"])} aria-label={`Reset password for ${r.name}`}>
                  <KeyRound className="h-4 w-4" />
                </Button>
                {r.status === "ACTIVE" ? (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" disabled={isSelf} onClick={() => setDisableRow(r)} aria-label={`Disable ${r.name}`}>
                    <UserX className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon" className="h-8 w-8 text-emerald-700 hover:text-emerald-700" onClick={() => reEnable(r)} aria-label={`Enable ${r.name}`}>
                    <ShieldCheck className="h-4 w-4" />
                  </Button>
                )}
              </>
            ) : null}
          </div>
        );
      },
      className: "w-4",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Staff accounts, roles and portal access"
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <Switch checked={includeCustomers} onCheckedChange={(v) => setIncludeCustomers(!!v)} aria-label="Include customer portal users" />
              <span className="hidden sm:inline flex items-center gap-1">{includeCustomers ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />} Portal users</span>
            </label>
            {can("users.create") ? (
              <Button onClick={() => openPage(["new"])}>
                <Plus className="h-4 w-4 mr-1.5" /> New User
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Phone number update requests — SUPER_ADMIN review queue (spec §15/§16).
          Renders nothing when the queue is empty or the viewer is not a
          SUPER_ADMIN. */}
      {isSuperAdmin ? <PhoneRequestsCard onChanged={load} /> : null}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading users…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No users found"
          hint={includeCustomers ? "Try clearing the search or filters." : "Toggle “Portal users” to include customer logins."}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => { if (rowClickable(r)) openPage([r.id, "edit"]); }}
          searchPlaceholder="Search name or email…"
          filters={[
            {
              key: "role", label: "Role",
              options: ROLES.filter((r) => r !== "CUSTOMER" || includeCustomers).map((r) => ({ value: r, label: humanize(r) })),
              match: (r, v) => r.role === v,
            },
            {
              // Position filter (role/position spec §19) — job-title axis,
              // independent of the role filter.
              key: "position", label: "Position",
              options: [...new Set(rows.map((r) => r.position?.name).filter((n): n is string => !!n))].sort().map((n) => ({ value: n, label: n })),
              match: (r, v) => r.position?.name === v,
            },
            {
              key: "status", label: "Status",
              options: [{ value: "ACTIVE", label: "Active" }, { value: "DISABLED", label: "Disabled" }],
              match: (r, v) => r.status === v,
            },
          ]}
          emptyTitle="No users match"
          emptyHint="Try clearing the search or filters."
          exportName="users"
        />
      )}

      {/* Disable confirm — the only dialog kept in this module (confirm-only). */}
      <AlertDialog open={!!disableRow} onOpenChange={(o) => !o && setDisableRow(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {disableRow?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The account is soft-disabled ({humanize("DISABLED")}) — history is kept. All active sessions are signed out immediately. You can re-enable the account later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={saving} onClick={(e) => { e.preventDefault(); submitDisable(); }}>
              {saving ? "Working…" : "Disable account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
