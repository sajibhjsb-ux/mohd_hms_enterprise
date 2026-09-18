"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit User page (users/{id} and
// users/{id}/edit views). Merges the former EDIT and RESET PASSWORD dialogs
// into one page with TWO cards:
//   • Profile        — name / phone / role + Save        (PATCH /api/v1/users/{id})
//   • Reset password — new password + Update password    (PATCH … {action:"reset_password"})
// Users have no detail page — the list routes row clicks and [id] URLs here.
//
// Record lookup (documented approach, keeps the API unchanged): the users API
// is list-based, so the page loads GET /api/v1/users and finds the row by id.
// If the id is not part of the visible list (e.g. a customer portal user,
// hidden behind the "Portal users" toggle), a not-found state is shown.

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { humanize } from "@/lib/hms/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { KeyRound, Save } from "lucide-react";

// ── Types & constants ──

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

// ── Page ──

export function UserEditPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const canUpdate = !!user?.permissions.includes("users.update");

  const [target, setTarget] = useState<UserRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Profile form + baseline (for the dirty guard and "no changes" state)
  const [form, setForm] = useState<{ name: string; phone: string; role: string }>({ name: "", phone: "", role: "SUPERVISOR" });
  const [initial, setInitial] = useState<{ name: string; phone: string; role: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [pwProblem, setPwProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const roleOptions = ASSIGNABLE_ROLES.filter((r) => r !== "SUPER_ADMIN" || isSuperAdmin);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // List-based lookup (documented approach — no API change). The default
      // list hides customer portal users; those ids resolve to not-found here.
      const res = await api.get<UserRow[]>(`/api/v1/users${qs({ pageSize: 200 })}`);
      const found = (Array.isArray(res.data) ? res.data : []).find((r) => r.id === id) ?? null;
      setTarget(found);
      if (found) {
        const f = { name: found.name, phone: found.phone ?? "", role: found.role };
        setForm(f);
        setInitial(f);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this user.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Dirty-state wiring (central router guard protects typed edits) ──
  const profileDirty = !!initial && (form.name !== initial.name || form.phone !== initial.phone || form.role !== initial.role);
  const dirty = profileDirty || newPassword.length > 0;
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitProfile() {
    if (!target) return;
    setSaving(true);
    try {
      const res = await api.patch<UserRow>(`/api/v1/users/${target.id}`, { name: form.name, phone: form.phone || null, role: form.role });
      toast({ title: "User updated", description: `${res.data.name} saved.` });
      const f = { name: res.data.name, phone: res.data.phone ?? "", role: res.data.role };
      setForm(f);
      setInitial(f);
      setTarget((t) => (t ? { ...t, ...f } : t));
    } catch (e) {
      toast({ title: "Could not update user", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitResetPassword() {
    if (!target) return;
    const pwErr = passwordProblem(newPassword);
    if (pwErr) { setPwProblem(pwErr); return; }
    setSaving(true);
    setPwProblem(null);
    try {
      await api.patch(`/api/v1/users/${target.id}`, { action: "reset_password", newPassword });
      toast({ title: "Password reset", description: `${target.name} must sign in with the new password.` });
      setNewPassword("");
      setPwProblem(null);
    } catch (e) {
      toast({ title: "Could not reset password", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canUpdate) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="/users"
        crumbs={[{ label: "Users", href: "/users" }, { label: "Edit" }]}
        title="Edit user"
      >
        <EmptyState
          title="You don't have permission to edit users"
          hint="User management is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  if (loading && !target && !loadError) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="/users"
        crumbs={[{ label: "Users", href: "/users" }, { label: "Edit" }]}
        title="Edit user"
      >
        <LoadingState label="Loading user…" rows={3} />
      </PageShell>
    );
  }

  if (loadError && !target) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="/users"
        crumbs={[{ label: "Users", href: "/users" }, { label: "Edit" }]}
        title="Edit user"
      >
        <ErrorState message={loadError} onRetry={load} />
      </PageShell>
    );
  }

  if (!target) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="/users"
        crumbs={[{ label: "Users", href: "/users" }, { label: "Edit" }]}
        title="Edit user"
      >
        <EmptyState
          title="User not found"
          hint="The link may be incorrect, or this is a customer portal user — toggle “Portal users” in the users list to manage those accounts."
        />
      </PageShell>
    );
  }

  const isSelf = target.id === user?.id;
  const guarded = target.role === "SUPER_ADMIN" && !isSuperAdmin;

  if (guarded) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="/users"
        crumbs={[{ label: "Users", href: "/users" }, { label: target.name, href: "/users" }, { label: "Edit" }]}
        title="Edit user"
      >
        <EmptyState
          title="This account is protected"
          hint="Only a SUPER_ADMIN can modify another SUPER_ADMIN account."
        />
      </PageShell>
    );
  }

  const set = (patch: Partial<{ name: string; phone: string; role: string }>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <PageShell
      backLabel="Back to Users"
      backHref="/users"
      crumbs={[{ label: "Users", href: "/users" }, { label: target.name, href: "/users" }, { label: "Edit" }]}
      title={`Edit ${target.name}`}
      description={`${target.email}${target.technicianProfile ? ` · ${target.technicianProfile.employeeNo}` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <RoleBadge role={target.role} />
          <StatusBadge status={target.status} />
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Card 1: Profile ── */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ue-name">Full name</Label>
              <Input id="ue-name" value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ue-phone">Phone</Label>
              <Input id="ue-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="ue-role">Role</Label>
              <Select value={form.role} onValueChange={(v) => set({ role: v })} disabled={isSelf}>
                <SelectTrigger id="ue-role" aria-label="Role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}
                </SelectContent>
              </Select>
              {isSelf ? <p className="text-xs text-muted-foreground mt-1">You cannot change your own role.</p> : null}
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Status</p>
                <p className="text-xs text-muted-foreground">{target.status === "ACTIVE" ? "Active — can sign in" : "Disabled — sign-in blocked"}</p>
              </div>
              <StatusBadge status={target.status} />
            </div>
            <div>
              <Button onClick={submitProfile} disabled={saving || !profileDirty}>
                {saving ? <Save className="h-4 w-4 mr-1.5 animate-pulse" /> : <Save className="h-4 w-4 mr-1.5" />}
                {saving ? "Saving…" : "Save changes"}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Status is managed from the list (disable/enable actions).
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 2: Reset password ── */}
        <Card className="shadow-sm h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="h-4 w-4" aria-hidden /> Reset password
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="up-new">New password *</Label>
              <Input
                id="up-new" type="text" autoComplete="off" value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setPwProblem(passwordProblem(e.target.value)); }}
                placeholder="Min 8 chars, letters + numbers"
                aria-invalid={!!newPassword && !!pwProblem}
              />
              {newPassword && !pwProblem ? <p className="text-xs text-emerald-600 mt-1">Password meets the policy.</p> : null}
              {newPassword && pwProblem ? <p className="text-xs text-destructive mt-1">{pwProblem}</p> : null}
            </div>
            <p className="text-xs rounded-md bg-muted px-3 py-2 text-muted-foreground">
              All active sessions for this user will be signed out.
            </p>
            <div>
              <Button onClick={submitResetPassword} disabled={saving || !!pwProblem || !newPassword}>
                {saving ? "Resetting…" : "Update password"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Unsaved changes are protected — navigation asks for confirmation until you save or clear them.
      </p>
    </PageShell>
  );
}
