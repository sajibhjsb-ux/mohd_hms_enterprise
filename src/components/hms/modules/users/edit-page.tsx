"use client";

// MOHD.HMS ENTERPRISE — dedicated Edit User page (users/{id} and
// users/{id}/edit views). Dedicated-page layout with SEPARATE cards:
//   • Profile          — name / email / phone                (identity, SA-managed)
//   • System Access    — ROLE (RBAC) + Save                  — authorization
//   • Job Information  — POSITION (job title) + Save         — organizational,
//     independent from the role (role/position spec §4/§8/§12/§13): changing
//     the role never moves the position and vice versa; they can also be
//     changed together in one request (backend supports a combined PATCH).
//   • Reset password — new password + Update password
// IDENTITY FIELDS (spec §5): name / email / phone are editable ONLY by a
// SUPER_ADMIN (inputs disabled for ADMIN + the backend rejects them with 403).
// Email changes open a dependency confirmation dialog (sign-in identity,
// Google linkage, verification state — spec §29). Users have no detail page —
// the list routes row clicks and [id] URLs here.

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
import { History, KeyRound, Lock, Save, ShieldCheck, Briefcase, UserCog, TriangleAlert } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CorporateEmailCard } from "./corporate-email-card";

// ── Types & constants ──

type UserRow = {
  id: string; email: string; name: string; phone: string | null; role: string; status: string;
  lastLoginAt: string | null; createdAt: string;
  customer: { id: string; companyName: string; code: string } | null;
  technicianProfile: { id: string; employeeNo: string; specialty: string; status: string } | null;
  positionId: string | null;
  position: { id: string; name: string; status?: string } | null;
};

/** Position catalog option (from /api/v1/hr/positions — HR master data). */
type PositionOption = { id: string; name: string; department?: { id: string; name: string } | null };

const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const;

/** Role-change audit row (spec §18) — derived from the existing audit system. */
type RoleHistoryRow = { id: string; createdAt: string; previousRole: string; newRole: string; changedBy: string };
/** Position-change audit row (role/position spec §15/§16) — same audit system. */
type PositionHistoryRow = { id: string; createdAt: string; previousPosition: string | null; newPosition: string | null; changedBy: string };

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

  // Profile form + baseline (for the dirty guard and "no changes" state).
  // role lives in the System Access card, positionId in Job Information —
  // tracked separately so each card saves exactly its own field.
  const [form, setForm] = useState<{ name: string; phone: string; email: string }>({ name: "", phone: "", email: "" });
  const [initial, setInitial] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [accessForm, setAccessForm] = useState<{ role: string }>({ role: "SUPERVISOR" });
  const [accessInitial, setAccessInitial] = useState<{ role: string } | null>(null);
  const [jobForm, setJobForm] = useState<{ positionId: string }>({ positionId: "" });
  const [jobInitial, setJobInitial] = useState<{ positionId: string } | null>(null);
  const [positions, setPositions] = useState<PositionOption[] | null>(null);
  const [emailConfirmOpen, setEmailConfirmOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [pwProblem, setPwProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const roleOptions = ROLES.filter((r) => r !== "SUPER_ADMIN" || isSuperAdmin);
  const canReadAudit = !!user?.permissions.includes("audit.read");

  const [roleHistory, setRoleHistory] = useState<RoleHistoryRow[] | null>(null);
  const [positionHistory, setPositionHistory] = useState<PositionHistoryRow[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // ROOT-CAUSE FIX: load the user through the DEDICATED detail endpoint.
      // The previous list-based lookup hit GET /api/v1/users (which hides
      // customer portal users by default), so every portal-registered user
      // resolved to "not found" and the edit form never rendered — portal
      // user roles could not be changed at all. GET /api/v1/users/{id}
      // returns ANY user and is the authoritative record for this page.
      const res = await api.get<{
        id: string; email: string; name: string; phone: string | null; role: string; status: string;
        lastLoginAt: string | null; createdAt: string; customerId: string | null;
        customer: { id: string; companyName: string; code: string } | null;
        technicianProfile: { id: string; employeeNo: string; specialty: string; skills?: string; status: string } | null;
        positionId: string | null;
        position: { id: string; name: string; status?: string } | null;
      }>(`/api/v1/users/${id}`);
      const found = res.data;
      setTarget(found);
      const f = { name: found.name, phone: found.phone ?? "", email: found.email };
      setForm(f);
      setInitial(f);
      setAccessForm({ role: found.role });
      setAccessInitial({ role: found.role });
      setJobForm({ positionId: found.positionId ?? "" });
      setJobInitial({ positionId: found.positionId ?? "" });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this user.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Position catalog for the Job Information dropdown — HR master data,
  // ACTIVE titles only (inactive ones cannot be assigned, spec §29).
  useEffect(() => {
    let alive = true;
    api.get<PositionOption[]>(`/api/v1/hr/positions${qs({ status: "ACTIVE", pageSize: 200, sort: "name" })}`)
      .then((res) => { if (alive) setPositions(res.data); })
      .catch(() => { if (alive) setPositions(null); });
    return () => { alive = false; };
  }, []);

  // ── Role history (spec §18) — from the EXISTING audit system, no new tables.
  // Covers the dedicated USER_ROLE_CHANGED rows and legacy USER_UPDATED rows
  // that carried roleFrom/roleTo.
  const loadRoleHistory = useCallback(async () => {
    if (!canReadAudit) return;
    try {
      const [dedicated, legacy] = await Promise.all([
        api.get<{ id: string; createdAt: string; actorEmail: string; actor?: { name?: string | null } | null; metadata?: unknown }[]>(
          `/api/v1/audit-logs${qs({ resourceType: "USER", resourceId: id, action: "USER_ROLE_CHANGED", pageSize: 20 })}`
        ),
        api.get<{ id: string; createdAt: string; actorEmail: string; actor?: { name?: string | null } | null; metadata?: unknown }[]>(
          `/api/v1/audit-logs${qs({ resourceType: "USER", resourceId: id, action: "USER_UPDATED", pageSize: 20 })}`
        ),
      ]);
      const map = (rows: typeof dedicated.data): RoleHistoryRow[] =>
        rows
          .map((r) => {
            const meta = (typeof r.metadata === "object" && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>;
            const previousRole = typeof meta.previousRole === "string" ? meta.previousRole : typeof meta.roleFrom === "string" ? meta.roleFrom : null;
            const newRole = typeof meta.newRole === "string" ? meta.newRole : typeof meta.roleTo === "string" ? meta.roleTo : null;
            if (!previousRole || !newRole || previousRole === newRole) return null;
            return { id: r.id, createdAt: r.createdAt, previousRole, newRole, changedBy: r.actor?.name ?? r.actorEmail };
          })
          .filter((r): r is RoleHistoryRow => !!r);
      const merged = [...map(dedicated.data), ...map(legacy.data)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setRoleHistory(merged);
    } catch {
      setRoleHistory(null); // history is best-effort — never blocks editing
    }
  }, [canReadAudit, id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { void loadRoleHistory(); }, [loadRoleHistory, target?.role]);

  // ── Position history (role/position spec §15/§16) — same audit system, the
  // dedicated USER_POSITION_CHANGED rows. Best-effort, never blocks editing.
  const loadPositionHistory = useCallback(async () => {
    if (!canReadAudit) return;
    try {
      const res = await api.get<{ id: string; createdAt: string; actorEmail: string; actor?: { name?: string | null } | null; metadata?: unknown }[]>(
        `/api/v1/audit-logs${qs({ resourceType: "USER", resourceId: id, action: "USER_POSITION_CHANGED", pageSize: 20 })}`
      );
      const rows = res.data
        .map((r) => {
          const meta = (typeof r.metadata === "object" && r.metadata !== null ? r.metadata : {}) as Record<string, unknown>;
          const previousPosition = typeof meta.previousPosition === "string" ? meta.previousPosition : null;
          const newPosition = typeof meta.newPosition === "string" ? meta.newPosition : null;
          if (previousPosition === newPosition) return null;
          return { id: r.id, createdAt: r.createdAt, previousPosition, newPosition, changedBy: r.actor?.name ?? r.actorEmail };
        })
        .filter((r): r is PositionHistoryRow => !!r)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setPositionHistory(rows);
    } catch {
      setPositionHistory(null);
    }
  }, [canReadAudit, id]);
  useEffect(() => { void loadPositionHistory(); }, [loadPositionHistory, target?.positionId]);

  // ── Dirty-state wiring (central router guard protects typed edits) ──
  // Each card tracks its OWN dirty flag so it saves exactly its own field —
  // role and position are independent (role/position spec §12/§13).
  const profileDirty = !!initial && (form.name !== initial.name || form.phone !== initial.phone || form.email !== initial.email);
  const accessDirty = !!accessInitial && accessForm.role !== accessInitial.role;
  const jobDirty = !!jobInitial && jobForm.positionId !== jobInitial.positionId;
  const emailChanged = !!initial && form.email.trim().toLowerCase() !== initial.email.trim().toLowerCase();
  const dirty = profileDirty || accessDirty || jobDirty || newPassword.length > 0;
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  async function submitProfile() {
    if (!target || !initial) return;
    // Minimal-diff payload (role-change spec §5/§15): ONLY send what actually
    // changed AND what the actor is allowed to change. Name/phone/email are
    // SUPER_ADMIN-managed identity fields — including them in an ADMIN's
    // payload made the backend (correctly) reject the whole request with 403,
    // which previously blocked role changes by ADMIN accounts.
    const payload: Record<string, unknown> = {};
    if (isSuperAdmin) {
      if (form.name !== initial.name) payload.name = form.name;
      if ((form.phone || null) !== (initial.phone || null)) payload.phone = form.phone || null;
      if (emailChanged) payload.email = form.email.trim().toLowerCase();
    }
    if (Object.keys(payload).length === 0) return; // nothing to change
    setSaving(true);
    try {
      const res = await api.patch<{
        id: string; name: string; phone: string | null; role: string; email: string;
        technicianProfile?: { id: string; employeeNo: string; specialty: string; status: string } | null;
      }>(`/api/v1/users/${target.id}`, payload);
      // Backend-confirmed data only (spec §15/§16) — never local-first updates.
      const f = { name: res.data.name, phone: res.data.phone ?? "", email: res.data.email };
      setForm(f);
      setInitial(f);
      toast({ title: "Profile updated", description: `${res.data.name} saved.` });
    } catch (e) {
      // Failure: keep the existing values displayed, show the real error (spec §15/§19).
      toast({ title: "Could not update user", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  /** SYSTEM ACCESS — save the ROLE only (authorization; role/position spec §12).
   *  The position is never touched here and vice-versa. */
  async function submitAccess() {
    if (!target || !accessInitial || accessForm.role === accessInitial.role) return;
    setSaving(true);
    try {
      const res = await api.patch<{
        id: string; name: string; role: string;
        technicianProfile?: { id: string; employeeNo: string; specialty: string; status: string } | null;
        position: { id: string; name: string } | null;
      }>(`/api/v1/users/${target.id}`, { role: accessForm.role });
      setAccessInitial({ role: res.data.role });
      setAccessForm({ role: res.data.role });
      setTarget((t) => (t ? { ...t, role: res.data.role, technicianProfile: res.data.technicianProfile ?? t.technicianProfile } : t));
      toast({
        title: "Role updated",
        description: `${res.data.name} is now ${humanize(res.data.role)}${res.data.technicianProfile ? ` · technician profile ${res.data.technicianProfile.employeeNo} ready` : ""}.`,
      });
      void loadRoleHistory();
    } catch (e) {
      toast({ title: "Could not update role", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  /** JOB INFORMATION — save the POSITION only (job title; role/position spec
   *  §13). Position changes never alter permissions or sessions (§22). */
  async function submitJobInfo() {
    if (!target || !jobInitial || jobForm.positionId === jobInitial.positionId) return;
    setSaving(true);
    try {
      const res = await api.patch<{
        id: string; name: string; role: string; positionId: string | null; position: { id: string; name: string } | null;
      }>(`/api/v1/users/${target.id}`, { positionId: jobForm.positionId || null });
      setJobInitial({ positionId: res.data.positionId ?? "" });
      setJobForm({ positionId: res.data.positionId ?? "" });
      setTarget((t) => (t ? { ...t, positionId: res.data.positionId, position: res.data.position } : t));
      toast({
        title: "Position updated",
        description: res.data.position ? `${res.data.name}'s position is now ${res.data.position.name}.` : `${res.data.name}'s position was cleared.`,
      });
      void loadPositionHistory();
    } catch (e) {
      toast({ title: "Could not update position", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function requestSaveProfile() {
    if (emailChanged) setEmailConfirmOpen(true);
    else void submitProfile();
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

  const set = (patch: Partial<{ name: string; phone: string; email: string }>) => setForm((f) => ({ ...f, ...patch }));

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
        {/* ── Card 1: Profile (identity — SA-managed fields) ── */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Profile</CardTitle>
            {!isSuperAdmin ? (
              <p className="text-xs text-muted-foreground">Name, email and phone are managed fields — only a SUPER ADMIN can change them.</p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ue-name">Full name</Label>
              <Input id="ue-name" value={form.name} onChange={(e) => set({ name: e.target.value })} disabled={!isSuperAdmin} className={!isSuperAdmin ? "bg-muted/40" : undefined} />
              {!isSuperAdmin ? <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden /> Managed by Super Admin</p> : null}
            </div>
            <div>
              <Label htmlFor="ue-email">Email (sign-in identity)</Label>
              <Input id="ue-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} disabled={!isSuperAdmin} className={!isSuperAdmin ? "bg-muted/40" : undefined} />
              {!isSuperAdmin ? (
                <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden /> Managed by Super Admin</p>
              ) : (
                <p className="text-[11px] text-muted-foreground mt-1">Changing the email affects sign-in, verification and mirrored records — a confirmation explains the impact.</p>
              )}
            </div>
            <div>
              <Label htmlFor="ue-phone">Phone</Label>
              <Input id="ue-phone" type="tel" value={form.phone} onChange={(e) => set({ phone: e.target.value })} disabled={!isSuperAdmin} className={!isSuperAdmin ? "bg-muted/40" : undefined} />
              {!isSuperAdmin ? <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden /> Managed by Super Admin</p> : null}
            </div>
            {target.customer && isSuperAdmin ? (
              <p className="text-[11px] rounded-md bg-muted px-3 py-2 text-muted-foreground">
                Customer account ({target.customer.code}) — name / phone / email changes also update the canonical customer record.
              </p>
            ) : null}
            <div>
              <Button onClick={requestSaveProfile} disabled={saving || !profileDirty}>
                {saving ? <Save className="h-4 w-4 mr-1.5 animate-pulse" /> : <Save className="h-4 w-4 mr-1.5" />}
                {saving ? "Saving…" : "Save profile"}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 2: SYSTEM ACCESS — the ROLE (RBAC authorization) ── */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden /> System access
            </CardTitle>
            <p className="text-xs text-muted-foreground">The role controls permissions and module access. It is independent of the job position.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ue-role">Role</Label>
              <Select value={accessForm.role} onValueChange={(v) => setAccessForm({ role: v })} disabled={isSelf}>
                <SelectTrigger id="ue-role" aria-label="Role"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => <SelectItem key={r} value={r}>{humanize(r)}</SelectItem>)}
                </SelectContent>
              </Select>
              {isSelf ? <p className="text-xs text-muted-foreground mt-1">You cannot change your own role.</p> : null}
              {!isSelf && target.customer && accessForm.role === "CUSTOMER" ? (
                <p className="text-xs text-muted-foreground mt-1">Portal account — CUSTOMER access with their own linked customer record.</p>
              ) : null}
              {!isSelf && accessForm.role !== accessInitial?.role && accessForm.role === "TECHNICIAN" && !target.technicianProfile ? (
                <p className="text-xs rounded-md bg-emerald-50 px-3 py-2 text-emerald-800 mt-1 flex items-center gap-1.5">
                  <UserCog className="h-3.5 w-3.5" aria-hidden /> Saving will provision a technician profile (TEC number) automatically — the user becomes assignable in Technician Management, complaints, work orders and PM.
                </p>
              ) : null}
              {!isSelf && accessForm.role !== accessInitial?.role && accessInitial?.role === "TECHNICIAN" ? (
                <p className="text-xs rounded-md bg-amber-50 px-3 py-2 text-amber-800 mt-1">
                  Downgrading away from TECHNICIAN removes technician access. Historical assignments, work orders and records stay intact.
                </p>
              ) : null}
            </div>
            <div className="flex items-center justify-between rounded-lg border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium">Status</p>
                <p className="text-xs text-muted-foreground">{target.status === "ACTIVE" ? "Active — can sign in" : "Disabled — sign-in blocked"}</p>
              </div>
              <StatusBadge status={target.status} />
            </div>
            <div>
              <Button onClick={submitAccess} disabled={saving || !accessDirty || isSelf}>
                {saving ? <Save className="h-4 w-4 mr-1.5 animate-pulse" /> : <Save className="h-4 w-4 mr-1.5" />}
                {saving ? "Saving…" : "Save role"}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Status is managed from the list (disable/enable actions). Job title is set under Job information.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 3: JOB INFORMATION — the POSITION (organizational job title) ──
            Visually and functionally separate from System Access (spec §8): a
            position NEVER grants permissions and a role change never edits it. */}
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="h-4 w-4 text-primary" aria-hidden /> Job information
            </CardTitle>
            <p className="text-xs text-muted-foreground">The position is the organizational job title — it does not change system access. Manage titles in HR → Positions.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="ue-position">Position</Label>
              <Select value={jobForm.positionId || "none"} onValueChange={(v) => setJobForm({ positionId: v === "none" ? "" : v })}>
                <SelectTrigger id="ue-position" aria-label="Position"><SelectValue placeholder="No position assigned" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No position assigned</SelectItem>
                  {target.position && !positions?.some((p) => p.id === target.position?.id) ? (
                    <SelectItem value={target.position.id}>{target.position.name} (inactive)</SelectItem>
                  ) : null}
                  {(positions ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {target.position ? `Current: ${target.position.name}` : "No position assigned yet."}
              </p>
            </div>
            <div>
              <Button onClick={submitJobInfo} disabled={saving || !jobDirty}>
                {saving ? <Save className="h-4 w-4 mr-1.5 animate-pulse" /> : <Save className="h-4 w-4 mr-1.5" />}
                {saving ? "Saving…" : "Save position"}
              </Button>
              <p className="text-xs text-muted-foreground mt-2">
                Changing the position does not affect this user's permissions or sign-in session.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* ── Card 4.5: CORPORATE EMAIL (email provisioning spec §8/§29) —
            self-managed card: shows the real backend provisioning state and
            the authorized admin actions; auto-refreshes while provisioning
            runs asynchronously on the outbox worker. ── */}
        <CorporateEmailCard userId={id} role={target.role} onChanged={() => void load()} />

        {/* ── Card 5: Reset password ── */}
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

      {/* ── Role + Position history (spec §16/§18) — from the existing
          PostgreSQL audit log; historical rows are never rewritten. ── */}
      {canReadAudit ? (
        <Card className="shadow-sm mt-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4" aria-hidden /> Role history
            </CardTitle>
          </CardHeader>
          <CardContent>
            {roleHistory === null ? (
              <p className="text-xs text-muted-foreground">History could not be loaded (audit access required).</p>
            ) : roleHistory.length === 0 ? (
              <p className="text-xs text-muted-foreground">No role changes recorded yet — the current role is the original assignment.</p>
            ) : (
              <ul className="divide-y">
                {roleHistory.slice(0, 8).map((h) => (
                  <li key={h.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-xs text-muted-foreground w-40 shrink-0">
                      {new Date(h.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}{" "}
                      {new Date(h.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <Badge variant="outline" className={`${ROLE_TONE[h.previousRole] ?? ""} font-medium`}>{humanize(h.previousRole)}</Badge>
                    <span aria-hidden>→</span>
                    <Badge variant="outline" className={`${ROLE_TONE[h.newRole] ?? ""} font-medium`}>{humanize(h.newRole)}</Badge>
                    <span className="text-xs text-muted-foreground">Changed by {h.changedBy || "system"}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 pt-4 border-t">
              <CardTitle className="text-base flex items-center gap-2 mb-1">
                <Briefcase className="h-4 w-4" aria-hidden /> Position history
              </CardTitle>
              {positionHistory === null ? (
                <p className="text-xs text-muted-foreground">History could not be loaded (audit access required).</p>
              ) : positionHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">No position changes recorded yet — the current position is the original assignment.</p>
              ) : (
                <ul className="divide-y">
                  {positionHistory.slice(0, 8).map((h) => (
                    <li key={h.id} className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="text-xs text-muted-foreground w-40 shrink-0">
                        {new Date(h.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}{" "}
                        {new Date(h.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <Badge variant="outline" className="font-medium">{h.previousPosition ?? "—"}</Badge>
                      <span aria-hidden>→</span>
                      <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 font-medium">{h.newPosition ?? "—"}</Badge>
                      <span className="text-xs text-muted-foreground">Changed by {h.changedBy || "system"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Email-change dependency confirmation (spec §29) */}
      <Dialog open={emailConfirmOpen} onOpenChange={setEmailConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-4 w-4 text-amber-600" aria-hidden /> Change sign-in email?
            </DialogTitle>
            <DialogDescription>
              This address is the user's sign-in identity. The change will:
            </DialogDescription>
          </DialogHeader>
          <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-5">
            <li>Become the address used to sign in ({initial?.email} → {form.email.trim().toLowerCase()})</li>
            <li>Reset email verification (the new address starts unverified)</li>
            <li>Keep Google sign-in working if this account is Google-linked</li>
            <li>Update mirrored records (customer / employee) automatically</li>
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmailConfirmOpen(false)}>Cancel</Button>
            <Button onClick={() => { setEmailConfirmOpen(false); void submitProfile(); }} disabled={saving}>
              {saving ? "Saving…" : "Change email"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
