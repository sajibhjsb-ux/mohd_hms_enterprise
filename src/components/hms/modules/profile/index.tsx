"use client";

// MOHD.HMS ENTERPRISE — Customer Profile module (dedicated full pages).
// /profile           → view profile (read-only summary)
// /profile/edit      → edit profile (mobile, address, optional company…)
// /profile/complete  → first-login onboarding (mandatory before any service
//                      request; backend independently enforces the same rule)
//
// The Customer record (Customers module) is the canonical source for the
// business identity — this page edits exactly that record through
// PATCH /api/v1/profile. Email is the authentication identity and stays
// read-only. Role / customer id / status / ownership are never editable.

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageHeader, StatusBadge, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { humanize } from "@/lib/hms/constants";
import { initials, fmtDate } from "@/lib/hms/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Building2, CheckCircle2, KeyRound, Loader2,
  Mail, MapPin, Pencil, Phone, Save, User,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ProfilePayload = {
  user: {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    role: string;
    status: string;
    avatarUrl: string | null;
    googleLinked: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  };
  customer: {
    id: string;
    code: string;
    companyName: string;
    contactPerson: string;
    email: string;
    phone: string;
    address: string;
    city: string;
    country: string;
    status: string;
  } | null;
  profileComplete: boolean;
  missingFields: string[];
  onboardingRequired: boolean;
};

type ProfileForm = {
  name: string;
  mobile: string;
  address: string;
  companyName: string;
};

const EMPTY_FORM: ProfileForm = { name: "", mobile: "", address: "", companyName: "" };
const MOBILE_MAX_DIGITS = 15;
const MOBILE_MIN_DIGITS = 7;

/** Permissive Brunei-friendly mobile check mirroring the backend (§16). */
function mobileError(v: string): string | null {
  const trimmed = v.trim();
  if (!trimmed) return "Mobile number is required.";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < MOBILE_MIN_DIGITS || digits.length > MOBILE_MAX_DIGITS) {
    return "Enter a valid mobile number (7–15 digits, e.g. +673 1234567).";
  }
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return "Enter a valid mobile number (digits with optional +, spaces, dashes).";
  return null;
}

export function ProfileModule() {
  const page = useUi((s) => s.pageOf("profile"));
  const view = page[0];
  if (view === "edit") return <ProfileEditPage onboarding={false} />;
  if (view === "complete") return <ProfileEditPage onboarding />;
  return <ProfileViewPage />;
}

function useProfile(loadKey: string) {
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { user } = useSession();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ProfilePayload>("/api/v1/profile");
      setData(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, user?.id, loadKey]);

  return { data, loading, error, load };
}

// ─────────────────────── VIEW ───────────────────────

function ProfileViewPage() {
  const { user } = useSession();
  const setChangePwOpen = useUi((s) => s.setChangePwOpen);
  const { data, loading, error, load } = useProfile("view");

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (loading && !data) return <LoadingState label="Loading profile…" />;
  if (!data) return null;

  const c = data.customer;

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Profile"
        subtitle="Your MOHD.HMS account and customer details"
        actions={
          <>
            {c ? (
              <Button size="sm" onClick={() => navigateTo("profile", ["edit"])}>
                <Pencil className="h-4 w-4 mr-1.5" aria-hidden /> Edit Profile
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => setChangePwOpen(true)}>
              <KeyRound className="h-4 w-4 mr-1.5" aria-hidden /> Change Password
            </Button>
          </>
        }
      />

      {data.onboardingRequired ? (
        <Card className="border-amber-200 bg-amber-50/70">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" aria-hidden />
            <span className="text-amber-900">
              Your profile is incomplete. Please add your <strong>mobile number</strong> and <strong>address</strong> before requesting a service.
            </span>
            <Button size="sm" className="sm:ml-auto shrink-0" onClick={() => navigateTo("profile", ["complete"])}>
              Complete Profile
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Account card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>Sign-in details for this account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="h-12 w-12 rounded-full bg-primary/10 text-primary text-sm font-semibold flex items-center justify-center shrink-0">
              {initials(data.user.name)}
            </span>
            <div className="min-w-0">
              <div className="font-medium truncate">{data.user.name}</div>
              <div className="text-xs text-muted-foreground flex items-center gap-1.5 truncate">
                <Mail className="h-3 w-3 shrink-0" aria-hidden /> {data.user.email}
              </div>
            </div>
            <Badge variant="outline" className="ml-auto shrink-0 bg-primary/5 text-primary border-primary/20">
              {humanize(data.user.role)}
            </Badge>
          </div>
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Sign-in:</span>
              <span>{data.user.googleLinked ? "Google + password" : "Email & password"}</span>
            </div>
            <div className="flex items-center gap-2">
              <BadgeCheck className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Member since:</span>
              <span>{fmtDate(data.user.createdAt)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Customer identity card */}
      {c ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Customer details</CardTitle>
            <CardDescription>
              Canonical record used across complaints, quotations and invoices
              {c.code ? ` — ${c.code}` : ""}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Full name</div>
                <div className="font-medium">{c.contactPerson || data.user.name}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Phone className="h-3 w-3" aria-hidden /> Mobile number
                  {!c.phone.trim() ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50">Required</Badge> : null}
                </div>
                <div className={cn("font-medium", !c.phone.trim() && "text-muted-foreground")}>
                  {c.phone.trim() || "Not provided"}
                </div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1.5">
                  <MapPin className="h-3 w-3" aria-hidden /> Address
                  {!c.address.trim() ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50">Required</Badge> : null}
                </div>
                <div className={cn("font-medium whitespace-pre-line", !c.address.trim() && "text-muted-foreground")}>
                  {c.address.trim() || "Not provided"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1 flex items-center gap-1.5">
                  <Building2 className="h-3 w-3" aria-hidden /> Company name
                  <span className="text-[10px] normal-case">(Optional)</span>
                </div>
                <div className={cn("font-medium", !c.companyName.trim() && "text-muted-foreground")}>
                  {c.companyName.trim() || "—"}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Location</div>
                <div className="font-medium">{[c.city, c.country].filter((x) => x && x.trim()).join(", ") || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Status</div>
                <StatusBadge status={c.status} />
              </div>
              {data.profileComplete ? (
                <div className="sm:col-span-2 flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Profile complete — you can request services.
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No customer record is linked to this account yet. Contact support if you believe this is a mistake.
          </CardContent>
        </Card>
      )}

      {user?.role !== "CUSTOMER" ? (
        <p className="text-xs text-muted-foreground">
          This profile page is tailored for customer accounts. Staff profile fields can be managed by administrators.
        </p>
      ) : null}
    </div>
  );
}

// ─────────────────────── EDIT / ONBOARDING ───────────────────────

function ProfileEditPage({ onboarding }: { onboarding: boolean }) {
  const { user, refresh } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const { data, loading, error, load } = useProfile(onboarding ? "complete" : "edit");
  const draft = useDraft<ProfileForm>({
    formKey: onboarding ? "profile.complete" : "profile.edit",
    initial: EMPTY_FORM,
    restoreOnMount: false,
  });
  const [hydrated, setHydrated] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Hydrate the form from the authoritative profile exactly once per load
  // (never clobber what the user is typing on refetch).
  useEffect(() => {
    if (!data || hydrated) return;
    draft.setValue({
      name: data.customer?.contactPerson || data.user.name || "",
      mobile: data.customer?.phone ?? "",
      address: data.customer?.address ?? "",
      companyName: data.customer?.companyName ?? "",
    });
    setHydrated(true);
  }, [data, hydrated, draft]);

  // Completed profiles don't belong on the onboarding page.
  useEffect(() => {
    if (onboarding && data && !data.onboardingRequired) navigateTo("dashboard");
  }, [onboarding, data]);

  // Staff / accounts without a customer record have nothing to edit here.
  useEffect(() => {
    if (!onboarding && data && !data.customer && user?.role === "CUSTOMER") navigateTo("dashboard");
  }, [onboarding, data, user?.role]);

  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const name = draft.value.name.trim();
    if (!name) errs.name = "Full name is required.";
    else if (name.length < 2) errs.name = "Name must be at least 2 characters.";
    const mErr = mobileError(draft.value.mobile);
    if (mErr) errs.mobile = mErr;
    const address = draft.value.address.trim();
    if (!address) errs.address = "Address is required.";
    return errs;
  }

  async function save() {
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast({ title: "Check the highlighted fields", variant: "destructive" });
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await api.patch<{ profileComplete: boolean }>("/api/v1/profile", {
        name: draft.value.name.trim(),
        mobile: draft.value.mobile.trim(),
        // Multi-line address preserved verbatim — backend stores it as typed.
        address: draft.value.address,
        companyName: draft.value.companyName.trim(),
      });
      draft.reset({
        name: draft.value.name.trim(),
        mobile: draft.value.mobile.trim(),
        address: draft.value.address,
        companyName: draft.value.companyName.trim(),
      });
      await refresh(); // authoritative profile state (gates, banners) updates live
      toast({
        title: "Profile updated successfully.",
        description: res.data.profileComplete
          ? "Your profile is complete — you can now request services."
          : undefined,
      });
      navigateTo(onboarding ? "dashboard" : "profile");
    } catch (e) {
      if (e instanceof ClientApiError) {
        setFormError(e.message);
        // Field-specific server validation (details: [{path, message}]).
        const details = Array.isArray(e.details) ? e.details as { path?: string; message?: string }[] : [];
        const fe: Record<string, string> = {};
        for (const d of details) if (d.path && d.message) fe[d.path] = d.message;
        if (Object.keys(fe).length) setFieldErrors(fe);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
      // Failure keeps the entered data (spec §36) — draft state is untouched.
    } finally {
      setSaving(false);
    }
  }

  if (loading && !data) return <LoadingState label="Loading profile…" />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const email = data.user.email;

  return (
    <div className="space-y-6 max-w-2xl">
      {onboarding ? (
        <div className="text-center pt-2 pb-1">
          <Image
            src="/brand/logo-128.png"
            alt="MOHD HMS Enterprise logo"
            width={64}
            height={64}
            priority
            className="h-16 w-16 rounded-full mx-auto"
          />
          <h1 className="mt-3 text-xl font-semibold tracking-tight">WELCOME TO MOHD.HMS</h1>
          <p className="text-sm font-medium text-primary mt-1">Complete Your Profile</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Please complete the following information before requesting a service.
          </p>
        </div>
      ) : (
        <PageHeader
          title="Edit Profile"
          subtitle="Update your customer details"
          actions={
            <Button size="sm" variant="outline" onClick={() => navigateTo("profile")}>
              <ArrowLeft className="h-4 w-4 mr-1.5" aria-hidden /> Back to profile
            </Button>
          }
        />
      )}

      <Card>
        <CardContent className="p-4 sm:p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="pf-name">Full Name</Label>
              <Input
                id="pf-name"
                value={draft.value.name}
                onChange={(e) => draft.setValue({ name: e.target.value })}
                autoComplete="name"
                maxLength={80}
                aria-invalid={!!fieldErrors.name}
              />
              <FieldError msg={fieldErrors.name} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-email">Email</Label>
              <Input id="pf-email" value={email} disabled readOnly aria-describedby="pf-email-hint" />
              <p id="pf-email-hint" className="text-[11px] text-muted-foreground">
                Your email is your sign-in identity and cannot be changed here.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-mobile">
                Mobile Number <span className="text-destructive" aria-hidden>*</span>
                <span className="sr-only">(required)</span>
              </Label>
              <Input
                id="pf-mobile"
                type="tel"
                inputMode="tel"
                placeholder="+673 1234567"
                value={draft.value.mobile}
                onChange={(e) => draft.setValue({ mobile: e.target.value })}
                autoComplete="tel"
                maxLength={40}
                aria-invalid={!!fieldErrors.mobile}
                required
              />
              <FieldError msg={fieldErrors.mobile} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-company">
                Company Name <span className="text-[11px] font-normal text-muted-foreground">(Optional)</span>
              </Label>
              <Input
                id="pf-company"
                placeholder="Leave blank for individual / home customers"
                value={draft.value.companyName}
                onChange={(e) => draft.setValue({ companyName: e.target.value })}
                maxLength={200}
                aria-invalid={!!fieldErrors.companyName}
              />
              <FieldError msg={fieldErrors.companyName} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="pf-address">
                Address <span className="text-destructive" aria-hidden>*</span>
                <span className="sr-only">(required)</span>
              </Label>
              <Textarea
                id="pf-address"
                rows={4}
                placeholder={"Unit / house number, street\nKampong / mukim, district"}
                value={draft.value.address}
                onChange={(e) => draft.setValue({ address: e.target.value })}
                className="min-h-24"
                aria-invalid={!!fieldErrors.address}
                required
              />
              <p className="text-[11px] text-muted-foreground">You can use multiple lines — they are kept exactly as typed.</p>
              <FieldError msg={fieldErrors.address} />
            </div>
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
              {formError}
            </p>
          ) : null}

          <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
            <Button
              variant="outline"
              onClick={() => {
                if (onboarding) navigateTo("dashboard");
                else navigateTo("profile");
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <Save className="h-4 w-4 mr-2" aria-hidden />}
              {onboarding ? "Save & Continue" : "Save Changes"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {onboarding ? (
        <p className="text-xs text-muted-foreground text-center -mt-2">
          Company name is optional — individuals and homeowners can leave it blank.
        </p>
      ) : null}
    </div>
  );
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {msg}
    </p>
  );
}
