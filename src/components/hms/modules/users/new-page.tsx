"use client";

// MOHD.HMS ENTERPRISE — dedicated New User page (users/new view).
// Replaces the former "Create user account" dialog. Same API
// (POST /api/v1/users), same RBAC (SUPER_ADMIN creation restricted to
// SUPER_ADMIN) and same password policy — no popup.
//
// Draft note: user creation has no server-backed draft (credentials must never
// be persisted), so the form uses plain state; the central pageDirty guard
// protects typed data until the page is left or submitted.

import { useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PageShell } from "@/components/hms/shared/page-shell";
import { EmptyState } from "@/components/hms/shared/ui-bits";
import { humanize } from "@/lib/hms/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types & constants ──

type UserCreated = { id: string; name: string; role: string };

const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "CUSTOMER", "FINANCE", "HR"] as const;
const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== "CUSTOMER");

/** Mirrors the server-side password policy (min 8 chars, letters + numbers). */
function passwordProblem(pw: string): string | null {
  if (!pw || pw.length < 8) return "Password must be at least 8 characters long.";
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain letters and numbers.";
  return null;
}

type FormState = { name: string; email: string; password: string; phone: string; role: string };

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

// ── Page ──

export function UserNewPage() {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const canCreate = !!user?.permissions.includes("users.create");

  const roleOptions = ASSIGNABLE_ROLES.filter((r) => r !== "SUPER_ADMIN" || isSuperAdmin);

  // Fresh form on every open — dedicated pages mount per navigation, which
  // resets form + field errors exactly like the old dialog-open reset did.
  const [initial] = useState<FormState>(() => ({ name: "", email: "", password: "", phone: "", role: roleOptions[0] ?? "SUPERVISOR" }));
  const [form, setForm] = useState<FormState>(initial);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // ── Dirty-state wiring: protect typed data with the central router guard ──
  const dirty =
    form.name !== initial.name || form.email !== initial.email || form.password !== initial.password ||
    form.phone !== initial.phone || form.role !== initial.role;
  useEffect(() => {
    setPageDirty(dirty);
    return () => { setPageDirty(false); };
  }, [dirty, setPageDirty]);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

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
      const res = await api.post<UserCreated>("/api/v1/users", {
        name: form.name, email: form.email, password: form.password,
        phone: form.phone || undefined, role: form.role,
      });
      toast({ title: "User created", description: `${res.data.name} can now sign in as ${humanize(res.data.role)}.` });
      setPageDirty(false);
      // Users have no detail page — return to the list.
      navigateTo("users");
    } catch (e) {
      // Keep every entered value on failure — show the error and allow retry.
      setFieldErrors(extractFieldErrors(e));
      toast({ title: "Could not create user", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (!canCreate) {
    return (
      <PageShell
        backLabel="Back to Users"
        backHref="#/users"
        crumbs={[{ label: "Users", href: "#/users" }, { label: "New User" }]}
        title="New User"
      >
        <EmptyState
          title="You don't have permission to create users"
          hint="User creation is limited to authorized roles. Contact your administrator if you believe this is a mistake."
        />
      </PageShell>
    );
  }

  const pwProblem = passwordProblem(form.password);

  const createButton = (
    <Button onClick={submitCreate} disabled={saving}>
      {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
      {saving ? "Creating…" : "Create user"}
    </Button>
  );

  return (
    <PageShell
      backLabel="Back to Users"
      backHref="#/users"
      crumbs={[{ label: "Users", href: "#/users" }, { label: "New User" }]}
      title="New User"
      description="The user signs in with this email and password immediately."
      actions={<div className="hidden sm:flex items-center gap-2 no-print">{createButton}</div>}
    >
      <Card className="shadow-sm max-w-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="u-name">Full name *</Label>
            <Input id="u-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Sarah Lim" />
            <FieldError msg={fieldErrors.name} />
          </div>
          <div>
            <Label htmlFor="u-email">Email *</Label>
            <Input id="u-email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} placeholder="name@mohdhms.com" />
            <FieldError msg={fieldErrors.email} />
          </div>
          <div>
            <Label htmlFor="u-pw">Password *</Label>
            <Input
              id="u-pw" type="text" autoComplete="off" value={form.password}
              onChange={(e) => { set({ password: e.target.value }); setFieldErrors((p) => ({ ...p, password: "" })); }}
              placeholder="Min 8 chars, letters + numbers"
              aria-invalid={!!form.password && !!pwProblem}
            />
            {form.password && !pwProblem ? <p className="text-xs text-emerald-600 mt-1">Password meets the policy.</p> : null}
            {form.password && pwProblem ? <p className="text-xs text-muted-foreground mt-1">{pwProblem}</p> : null}
            <FieldError msg={fieldErrors.password} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="u-phone">Phone</Label>
              <Input id="u-phone" value={form.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+60 12-…" />
            </div>
            <div>
              <Label>Role</Label>
              <Select value={form.role} onValueChange={(v) => set({ role: v })}>
                <SelectTrigger aria-label="Role"><SelectValue placeholder="Select role" /></SelectTrigger>
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
        </CardContent>
      </Card>

      {/* Sticky mobile action bar */}
      <div className={cn("sticky bottom-[4.4rem] lg:bottom-4 z-20 mt-4 lg:hidden no-print")}>
        <div className="rounded-xl border bg-background/95 backdrop-blur shadow-lg p-3">
          <Button className="w-full" onClick={submitCreate} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1.5" />}
            {saving ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
