"use client";

// MOHD.HMS ENTERPRISE — Users module.
// Staff account management: role badges, status toggle with confirm, password
// reset dialog, create dialog (SUPER_ADMIN creation restricted to SUPER_ADMIN).
// Customer portal users are hidden behind an "include portal users" toggle.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Column } from "@/components/hms/shared/data-table";
import { PageHeader, StatusBadge, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import type { Permission } from "@/lib/hms/constants";
import { humanize } from "@/lib/hms/constants";
import { fmtDateTime } from "@/lib/hms/format";
import { EyeOff, Eye, KeyRound, Pencil, Plus, ShieldCheck, UserX } from "lucide-react";

type UserRow = {
  id: string; email: string; name: string; phone: string | null; role: string; status: string;
  lastLoginAt: string | null; createdAt: string;
  customer: { id: string; companyName: string; code: string } | null;
  technicianProfile: { id: string; employeeNo: string; specialty: string; status: string } | null;
};

const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const;
const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== "CUSTOMER");

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

/** Mirrors the server-side password policy (min 8 chars, letters + numbers). */
function passwordProblem(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters long.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}

type FormState = { name: string; email: string; password: string; phone: string; role: string };
const EMPTY_FORM: FormState = { name: "", email: "", password: "", phone: "", role: "SUPERVISOR" };

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

export function UsersModule() {
  const { user } = useSession();
  const { toast } = useToast();
  const can = (p: Permission) => !!user?.permissions.includes(p);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  const [rows, setRows] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeCustomers, setIncludeCustomers] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // Edit dialog
  const [editRow, setEditRow] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; phone: string; role: string }>({ name: "", phone: "", role: "SUPERVISOR" });

  // Reset password dialog
  const [pwRow, setPwRow] = useState<UserRow | null>(null);
  const [newPassword, setPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);

  // Disable confirm
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

  async function submitCreate() {
    const pwErr = passwordProblem(form.password);
    if (pwErr) {
      setFieldErrors({ password: pwErr });
      toast({ title: "Check the password", description: pwErr, variant: "destructive" });
      return;
    }
    setSaving(true);
    setFieldErrors({});
    try {
      const res = await api.post<UserRow>("/api/v1/users", {
        name: form.name, email: form.email, password: form.password,
        phone: form.phone || undefined, role: form.role,
      });
      toast({ title: "User created", description: `${res.data.name} can now sign in as ${humanize(res.data.role)}.` });
      setForm(EMPTY_FORM);
      setCreateOpen(false);
      load();
    } catch (e) {
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not create user", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitEdit() {
    if (!editRow) return;
    setSaving(true);
    try {
      await api.patch(`/api/v1/users/${editRow.id}`, { name: editForm.name, phone: editForm.phone || null, role: editForm.role });
      toast({ title: "User updated", description: `${editForm.name} saved.` });
      setEditRow(null);
      load();
    } catch (e) {
      toast({ title: "Could not update user", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitResetPassword() {
    if (!pwRow) return;
    const pwErr = passwordProblem(newPassword);
    if (pwErr) { setPwError(pwErr); return; }
    setSaving(true);
    setPwError(null);
    try {
      await api.patch(`/api/v1/users/${pwRow.id}`, { action: "reset_password", newPassword });
      toast({ title: "Password reset", description: `${pwRow.name} must sign in with the new password.` });
      setPwRow(null);
      setPassword("");
    } catch (e) {
      toast({ title: "Could not reset password", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

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

  const roleOptions = ASSIGNABLE_ROLES.filter((r) => r !== "SUPER_ADMIN" || isSuperAdmin);

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
    { key: "phone", header: "Phone", value: (r) => r.phone ?? "", render: (r) => r.phone || "—", hideOnMobile: true },
    {
      key: "customer", header: "Linked customer", value: (r) => r.customer?.companyName ?? "",
      render: (r) => (r.customer ? <span className="text-xs">{r.customer.companyName}</span> : <span className="text-muted-foreground">—</span>),
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
            {can("users.update") && !guarded ? (
              <>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setEditRow(r); setEditForm({ name: r.name, phone: r.phone ?? "", role: r.role }); }} aria-label={`Edit ${r.name}`}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setPwRow(r); setPassword(""); setPwError(null); }} aria-label={`Reset password for ${r.name}`}>
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
              <Button onClick={() => { setForm({ ...EMPTY_FORM, role: roleOptions[0] ?? "SUPERVISOR" }); setFieldErrors({}); setCreateOpen(true); }}>
                <Plus className="h-4 w-4 mr-1.5" /> New User
              </Button>
            ) : null}
          </div>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <LoadingState label="Loading users…" />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          searchPlaceholder="Search name or email…"
          filters={[
            {
              key: "role", label: "Role",
              options: ROLES.filter((r) => r !== "CUSTOMER" || includeCustomers).map((r) => ({ value: r, label: humanize(r) })),
              match: (r, v) => r.role === v,
            },
            {
              key: "status", label: "Status",
              options: [{ value: "ACTIVE", label: "Active" }, { value: "DISABLED", label: "Disabled" }],
              match: (r, v) => r.status === v,
            },
          ]}
          emptyTitle="No users found"
          emptyHint={includeCustomers ? "Try clearing the search or filters." : "Toggle “Portal users” to include customer logins."}
          exportName="users"
        />
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create user account</DialogTitle>
            <DialogDescription>The user signs in with this email and password immediately.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="u-name">Full name *</Label>
              <Input id="u-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Sarah Lim" />
              <FieldError msg={fieldErrors.name} />
            </div>
            <div>
              <Label htmlFor="u-email">Email *</Label>
              <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} placeholder="name@mohdhms.com" />
              <FieldError msg={fieldErrors.email} />
            </div>
            <div>
              <Label htmlFor="u-pw">Password *</Label>
              <Input id="u-pw" type="text" autoComplete="off" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="Min 8 chars, letters + numbers" />
              <FieldError msg={fieldErrors.password} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="u-phone">Phone</Label>
                <Input id="u-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+60 12-…" />
              </div>
              <div>
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm((f) => ({ ...f, role: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}
                  </SelectContent>
                </Select>
                {!isSuperAdmin ? <p className="text-xs text-muted-foreground mt-1">SUPER_ADMIN accounts can only be created by a SUPER_ADMIN.</p> : null}
              </div>
            </div>
            {form.role === "TECHNICIAN" ? (
              <p className="text-xs rounded-md bg-muted px-3 py-2 text-muted-foreground">
                A technician profile with an employee number is provisioned automatically.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={submitCreate} disabled={saving}>{saving ? "Creating…" : "Create user"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editRow} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit {editRow?.name}</DialogTitle>
            <DialogDescription>{editRow?.email}{editRow?.technicianProfile ? ` · ${editRow.technicianProfile.employeeNo}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="ue-name">Full name</Label>
              <Input id="ue-name" value={editForm.name} onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label htmlFor="ue-phone">Phone</Label>
              <Input id="ue-phone" value={editForm.phone} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={editForm.role} onValueChange={(v) => setEditForm((f) => ({ ...f, role: v }))} disabled={editRow?.id === user?.id}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}
                </SelectContent>
              </Select>
              {editRow?.id === user?.id ? <p className="text-xs text-muted-foreground mt-1">You cannot change your own role.</p> : null}
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Status</p>
                <p className="text-xs text-muted-foreground">{editRow?.status === "ACTIVE" ? "Active — can sign in" : "Disabled — sign-in blocked"}</p>
              </div>
              <StatusBadge status={editRow?.status} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditRow(null)}>Cancel</Button>
            <Button onClick={submitEdit} disabled={saving}>{saving ? "Saving…" : "Save changes"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!pwRow} onOpenChange={(o) => !o && setPwRow(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset password — {pwRow?.name}</DialogTitle>
            <DialogDescription>All active sessions for this user will be signed out.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="up-new">New password *</Label>
            <Input id="up-new" type="text" autoComplete="off" value={newPassword} onChange={(e) => { setPassword(e.target.value); setPwError(passwordProblem(e.target.value)); }} placeholder="Min 8 chars, letters + numbers" />
            {newPassword && !pwError ? <p className="text-xs text-emerald-600 mt-1">Password meets the policy.</p> : null}
            <FieldError msg={pwError ?? undefined} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwRow(null)}>Cancel</Button>
            <Button onClick={submitResetPassword} disabled={saving || !!pwError || !newPassword}>{saving ? "Resetting…" : "Reset password"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Disable confirm */}
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
