"use client";

// MOHD.HMS ENTERPRISE — My Profile module (dedicated full pages, EVERY role).
// /profile           → view profile (account + role-specific details)
// /profile/edit      → edit permitted details
// /profile/complete  → first-login onboarding (customers; backend enforces the
//                      same completeness rule on every service request)
//
// ONE canonical profile foundation for every authenticated user with
// role-specific sections — never separate per-role profile systems:
//   • Account identity (name / email / phone) is MANAGED BY SUPER ADMIN for
//     everyone — read-only here, backend-enforced (PATCH /api/v1/profile
//     rejects identity fields; only PATCH /api/v1/users/{id} by a
//     SUPER_ADMIN can change them).
//   • Customers edit their canonical Customer record: address (multi-line,
//     verbatim), optional company name, city. Their mobile number follows
//     the secure REQUEST workflow (submit → SUPER_ADMIN approves) so the
//     "no verified phone + no address = no service requests" rule stays
//     intact without a user-side bypass.
//   • Staff see their employee/technician context; their contact details are
//     managed by administrators.
//   • Profile photo uploads go through the existing MinIO storage service
//     (POST /api/v1/profile/avatar) — object reference in PostgreSQL only.

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { useDraft } from "@/hooks/use-draft";
import { PageHeader, StatusBadge, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { PushSettingsCards } from "@/components/hms/modules/profile/push-settings";
import { MyPayslipsCard } from "@/components/hms/modules/profile/payslips";
import { SecuritySessionsCard } from "@/components/hms/modules/profile/security-sessions";
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
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Briefcase, Building2, CheckCircle2, ChevronRight, Clock,
  IdCard, ImagePlus, KeyRound, Loader2, Lock, Mail, MapPin, Pencil, Phone, Save,
  ScrollText, ShieldCheck, Smartphone, Trash2, User, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SkillsManager, type SkillEntry } from "@/components/hms/modules/technicians/skills-manager";

type ProfilePayload = {
  user: {
    id: string;
    email: string;
    name: string;
    phone: string | null;
    role: string;
    // Organizational job title — display-only, separate from the RBAC role.
    position?: string | null;
    status: string;
    avatarUrl: string | null;
    googleLinked: boolean;
    lastLoginAt: string | null;
    createdAt: string;
  };
  // Corporate email (email provisioning spec §8) — the WORK identity, kept
  // separate from the sign-in identity. Null when the account has no corporate
  // mailbox; active:false shows a suspended mailbox honestly.
  corporateEmail?: { email: string; active: boolean } | null;
  technicianProfile: {
    id: string;
    employeeNo: string;
    skills: string | null;
    specialty: string;
    status: string;
  } | null;
  employee: {
    id: string;
    employeeNo: string;
    name: string;
    position: string | null;
    department: string | null;
    email: string | null;
    phone: string | null;
    joinDate: string | null;
    status: string;
  } | null;
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
  pendingPhoneRequest: {
    id: string;
    proposedValue: string;
    currentValue: string;
    createdAt: string;
  } | null;
};

type ProfileForm = {
  address: string;
  companyName: string;
  city: string;
};

const EMPTY_FORM: ProfileForm = { address: "", companyName: "", city: "" };

/** Permissive Brunei-friendly mobile check mirroring the backend (§16). */
function mobileError(v: string): string | null {
  const trimmed = v.trim();
  if (!trimmed) return "Mobile number is required.";
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return "Enter a valid mobile number (7–15 digits, e.g. +673 1234567).";
  }
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return "Enter a valid mobile number (digits with optional +, spaces, dashes).";
  return null;
}

/** Authenticated avatar URL (cache-busting on the key, bucket stays private). */
function avatarSrc(key: string | null | undefined): string | null {
  return key ? `/api/v1/profile/avatar?v=${encodeURIComponent(key)}` : null;
}

function Avatar({ url, name, className }: { url: string | null | undefined; name: string; className?: string }) {
  const src = avatarSrc(url);
  return src ? (
    <img src={src} alt="" className={cn("rounded-full object-cover", className)} />
  ) : (
    <span className={cn("rounded-full bg-primary/10 text-primary font-semibold flex items-center justify-center", className)}>
      {initials(name)}
    </span>
  );
}

export function ProfileModule() {
  const page = useUi((s) => s.pageOf("profile"));
  const view = page[0];
  if (view === "edit") return <ProfileEditPage onboarding={false} />;
  if (view === "complete") return <ProfileEditPage onboarding />;
  return <ProfileViewPage />;
}

/**
 * "My Skills" (spec §6/§7) — structured, self-managed technician skills.
 * Loaded from the self-service endpoint (own profile only, IDOR-safe) and
 * edited through the shared SkillsManager. Falls back to the legacy CSV text
 * if the endpoint ever fails, so the field never shows a false "no skills".
 */
function MySkillsSection({ profileId, fallbackCsv }: { profileId: string; fallbackCsv: string | null }) {
  const [skills, setSkills] = useState<SkillEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ profile: { id: string }; skills: SkillEntry[] }>("/api/v1/profile/technician-skills")
      .then((r) => { if (alive) setSkills(r.data.skills); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return <div className="font-medium">{fallbackCsv?.trim() || "—"}</div>;
  if (!skills) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading skills" />;
  }
  return <SkillsManager profileId={profileId} skills={skills} canEdit selfService onChange={setSkills} />;
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

// ─────────────────────── Shared: phone change request ───────────────────────

function ManagedFieldHint({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
      <Lock className="h-3 w-3 shrink-0" aria-hidden />
      {children ?? "Managed by Super Admin — contact your administrator to change this."}
    </p>
  );
}

function PhoneRequestDialog({ open, onOpenChange, currentPhone, onSubmitted }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  currentPhone: string;
  onSubmitted: () => void;
}) {
  const { toast } = useToast();
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setPhone(""); setError(null); }
  }, [open]);

  async function submit() {
    const err = mobileError(phone);
    if (err) { setError(err); return; }
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/profile/phone-requests", { phone: phone.trim() });
      toast({
        title: "Request submitted",
        description: "Your mobile number update request was sent to a SUPER_ADMIN for review.",
      });
      onOpenChange(false);
      onSubmitted();
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Unable to submit the request. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Request phone number update</DialogTitle>
          <DialogDescription>
            Your mobile number is a verified, administrator-managed field. Submit the proposed number and a SUPER_ADMIN will review and apply it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pr-current">Current number</Label>
            <Input id="pr-current" value={currentPhone || "Not yet registered"} disabled readOnly />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pr-proposed">
              Proposed mobile number <span className="text-destructive" aria-hidden>*</span>
              <span className="sr-only">(required)</span>
            </Label>
            <Input
              id="pr-proposed"
              type="tel"
              inputMode="tel"
              placeholder="+673 1234567"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              maxLength={40}
              aria-invalid={!!error}
            />
            {error ? <FieldError msg={error} /> : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <Smartphone className="h-4 w-4 mr-2" aria-hidden />}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PhoneRequestStatus({ data, onChanged }: { data: ProfilePayload; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const pending = data.pendingPhoneRequest;
  const isCustomer = data.user.role === "CUSTOMER";
  const canonicalPhone = isCustomer ? data.customer?.phone ?? "" : data.user.phone ?? "";

  if (!isCustomer || !pending) return null;

  async function cancel() {
    setBusy(true);
    try {
      await api.del("/api/v1/profile/phone-requests");
      toast({ title: "Request canceled", description: "Your phone number update request was canceled." });
      onChanged();
    } catch (e) {
      toast({
        title: "Unable to cancel the request",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-amber-200 bg-amber-50/60">
      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
        <Clock className="h-5 w-5 text-amber-600 shrink-0" aria-hidden />
        <div className="min-w-0 text-amber-900">
          <span className="font-medium">Phone number update pending review.</span>{" "}
          <span className="text-amber-800">
            Proposed <strong>{pending.proposedValue}</strong> (current: {pending.currentValue.trim() || "not yet registered"}) — a SUPER_ADMIN will review it.
          </span>
        </div>
        <Button size="sm" variant="outline" className="sm:ml-auto shrink-0 border-amber-300 text-amber-900 hover:bg-amber-100" onClick={cancel} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />}
          Cancel request
        </Button>
      </CardContent>
    </Card>
  );
}

// ─────────────────────── VIEW ───────────────────────

function ProfileViewPage() {
  const { user } = useSession();
  const setChangePwOpen = useUi((s) => s.setChangePwOpen);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const { data, loading, error, load } = useProfile("view");

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (loading && !data) return <LoadingState label="Loading profile…" />;
  if (!data) return null;

  const c = data.customer;
  const isCustomer = data.user.role === "CUSTOMER";
  const canonicalPhone = isCustomer ? c?.phone ?? "" : data.user.phone ?? "";
  const missingPhone = !canonicalPhone.trim();

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="My Profile"
        subtitle="Your MOHD.HMS account and details"
        actions={
          <>
            <Button size="sm" onClick={() => navigateTo("profile", ["edit"])}>
              <Pencil className="h-4 w-4 mr-1.5" aria-hidden /> Edit Profile
            </Button>
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
              Your profile is incomplete. Please add your <strong>address</strong> and have a <strong>mobile number</strong> registered before requesting a service.
            </span>
            <Button size="sm" className="sm:ml-auto shrink-0" onClick={() => navigateTo("profile", ["complete"])}>
              Complete Profile
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <PhoneRequestStatus data={data} onChanged={load} />

      {/* Account card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>Sign-in details for this account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar url={data.user.avatarUrl} name={data.user.name} className="h-12 w-12 text-sm shrink-0" />
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
          {/* Job position (role/position spec §6) — shown with the role so the
              distinction between ACCESS (role) and JOB TITLE (position) is
              obvious. Falls back to the employee record's snapshot title. */}
          {(data.user.position ?? data.employee?.position) ? (
            <div className="flex items-center gap-2 text-sm">
              <Briefcase className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Position:</span>
              <span>{data.user.position ?? data.employee?.position}</span>
            </div>
          ) : null}
          {/* Corporate email (email provisioning spec §8) — WORK identity shown
              next to the account identity; honest about suspension state. */}
          {data.corporateEmail ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Corporate email:</span>
              <span className="font-medium break-all">{data.corporateEmail.email}</span>
              <Badge variant="outline" className={data.corporateEmail.active ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-stone-100 text-stone-600 border-stone-200"}>
                {data.corporateEmail.active ? "ACTIVE" : "SUSPENDED"}
              </Badge>
            </div>
          ) : null}
          <Separator />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Mobile:</span>
              <span className={cn("truncate", (!data.user.phone || !data.user.phone.trim()) && "text-muted-foreground")}>
                {(isCustomer ? canonicalPhone : data.user.phone)?.trim() || "Not yet registered"}
              </span>
            </div>
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
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
              <span className="text-muted-foreground">Status:</span>
              <StatusBadge status={data.user.status} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Login & Session Security: user-controlled auto login + active
          sessions (per device) — the backend stays authoritative */}
      <SecuritySessionsCard />

      {/* Notifications: registered devices + push preferences (spec §19/§32) */}
      <PushSettingsCards />

      {/* Payroll self-service (payroll spec §51) — own payslips + salary history */}
      <MyPayslipsCard />

      {/* Customer identity card (canonical record) */}
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
                  {!c.phone.trim() ? (
                    <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 bg-amber-50">Not yet registered</Badge>
                  ) : null}
                </div>
                <div className={cn("font-medium", !c.phone.trim() && "text-muted-foreground")}>
                  {c.phone.trim() || "Not provided"}
                </div>
                {missingPhone ? (
                  <Button size="sm" variant="outline" className="mt-2 h-8 text-xs" onClick={() => setPhoneDialogOpen(true)}>
                    <Smartphone className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Request Phone Number Update
                  </Button>
                ) : null}
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
      ) : null}

      {/* Employee context (staff) */}
      {data.employee ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Employment</CardTitle>
            <CardDescription>HR record linked to this account — managed by HR and administrators.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Employee No.</div>
                <div className="font-medium">{data.employee.employeeNo || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Position</div>
                <div className="font-medium">{data.employee.position || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Department</div>
                <div className="font-medium">{data.employee.department || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Joined</div>
                <div className="font-medium">{data.employee.joinDate ? fmtDate(data.employee.joinDate) : "—"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Technician profile (technicians) */}
      {data.technicianProfile ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="h-4 w-4 text-primary" aria-hidden /> Technician profile
            </CardTitle>
            <CardDescription>Operational record used for work order assignment.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Employee No.</div>
                <div className="font-medium">{data.technicianProfile.employeeNo || "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Specialty</div>
                <div className="font-medium">{humanize(data.technicianProfile.specialty)}</div>
              </div>
              <div className="sm:col-span-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">My Skills</div>
                <MySkillsSection
                  profileId={data.technicianProfile.id}
                  fallbackCsv={data.technicianProfile.skills}
                />
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Availability</div>
                <StatusBadge status={data.technicianProfile.status} />
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {!c && !isCustomer ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Your name, email and phone number are managed by MOHD.HMS administrators.
            Use <strong>Edit Profile</strong> to change your profile photo, or contact your administrator for identity changes.
          </CardContent>
        </Card>
      ) : null}

      {isCustomer ? (
        // Legal (spec §27) — Terms & Conditions / Privacy Policy reachable from
        // the customer portal profile without adding top-level navigation.
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Legal</CardTitle>
            <CardDescription>The company's legal documents — always the current published version.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => navigateTo("terms")}
              className="flex min-h-[44px] items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ScrollText className="h-4 w-4 text-primary" aria-hidden />
              <span className="flex-1 text-left">Terms &amp; Conditions</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => navigateTo("privacy")}
              className="flex min-h-[44px] items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
              <span className="flex-1 text-left">Privacy Policy</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
            </button>
          </CardContent>
        </Card>
      ) : null}

      <PhoneRequestDialog
        open={phoneDialogOpen}
        onOpenChange={setPhoneDialogOpen}
        currentPhone={canonicalPhone}
        onSubmitted={load}
      />
    </div>
  );
}

// ─────────────────────── EDIT / ONBOARDING ───────────────────────

function ProfileEditPage({ onboarding }: { onboarding: boolean }) {
  const { user, refresh } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);
  const [phoneDialogOpen, setPhoneDialogOpen] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const { data, loading, error, load } = useProfile(onboarding ? "complete" : "edit");
  const isCustomer = data?.user.role === "CUSTOMER";
  const draft = useDraft<ProfileForm>({
    formKey: onboarding ? "profile.complete" : "profile.edit",
    initial: EMPTY_FORM,
    restoreOnMount: false,
  });
  const [hydrated, setHydrated] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Hydrate the form from the authoritative profile exactly once per load
  // (never clobber what the user is typing on refetch).
  useEffect(() => {
    if (!data || hydrated) return;
    draft.setValue({
      address: data.customer?.address ?? "",
      companyName: data.customer?.companyName ?? "",
      city: data.customer?.city ?? "",
    });
    setHydrated(true);
  }, [data, hydrated, draft]);

  // Completed profiles don't belong on the onboarding page.
  useEffect(() => {
    if (onboarding && data && !data.onboardingRequired) navigateTo("dashboard");
  }, [onboarding, data]);

  useEffect(() => {
    setPageDirty(draft.dirty);
    return () => { setPageDirty(false); };
  }, [draft.dirty, setPageDirty]);

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    if (isCustomer) {
      const address = draft.value.address.trim();
      if (!address) errs.address = "Address is required.";
    }
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
        // Multi-line address preserved verbatim — backend stores it as typed.
        address: draft.value.address,
        companyName: draft.value.companyName.trim(),
        city: draft.value.city.trim(),
      });
      draft.reset({
        address: draft.value.address,
        companyName: draft.value.companyName.trim(),
        city: draft.value.city.trim(),
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
        setFormError("Unable to update your profile. Please try again.");
      }
      // Failure keeps the entered data (spec §37) — draft state is untouched.
    } finally {
      setSaving(false);
    }
  }

  async function uploadPhoto(file: File) {
    setUploading(true);
    try {
      // Multipart upload — raw fetch (the IRMS photo manager pattern); the
      // api-client wrapper is JSON-only and must not stringify FormData.
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/v1/profile/avatar", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.ok) {
        throw new ClientApiError(
          body?.error?.message ?? "Unable to upload profile photo.",
          body?.error?.code ?? "UNKNOWN",
          res.status,
          body?.error?.details,
        );
      }
      await Promise.all([refresh(), load()]);
      toast({ title: "Profile photo updated.", description: "Your new photo is now visible on your account." });
    } catch (e) {
      toast({
        title: "Unable to upload profile photo.",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePhoto() {
    setUploading(true);
    try {
      await api.del("/api/v1/profile/avatar");
      await Promise.all([refresh(), load()]);
      toast({ title: "Profile photo removed." });
    } catch (e) {
      toast({
        title: "Unable to remove the photo.",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  async function cancelPendingRequest() {
    setCancelPending(true);
    try {
      await api.del("/api/v1/profile/phone-requests");
      toast({ title: "Request canceled", description: "Your phone number update request was canceled." });
      await load();
    } catch (e) {
      toast({
        title: "Unable to cancel the request",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setCancelPending(false);
    }
  }

  if (loading && !data) return <LoadingState label="Loading profile…" />;
  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return null;

  const canonicalPhone = isCustomer ? data.customer?.phone ?? "" : data.user.phone ?? "";
  const phoneMissing = !canonicalPhone.trim();

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
          subtitle="Update your permitted profile details"
          actions={
            <Button size="sm" variant="outline" onClick={() => navigateTo("profile")}>
              <ArrowLeft className="h-4 w-4 mr-1.5" aria-hidden /> Back to profile
            </Button>
          }
        />
      )}

      {/* Profile photo — existing MinIO storage via the authenticated API */}
      <Card>
        <CardContent className="p-4 sm:p-6 flex flex-col sm:flex-row items-center gap-4">
          <div className="relative">
            <Avatar url={data.user.avatarUrl} name={data.user.name} className="h-20 w-20 text-lg" />
            {uploading ? (
              <span className="absolute inset-0 rounded-full bg-background/70 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden />
              </span>
            ) : null}
          </div>
          <div className="flex-1 text-center sm:text-left">
            <div className="text-sm font-medium">Profile photo</div>
            <p className="text-xs text-muted-foreground mt-0.5">
              JPEG, PNG or WebP · up to 5 MB. Stored privately — only you (and administrators) can view it.
            </p>
            <div className="flex flex-wrap justify-center sm:justify-start gap-2 mt-2.5">
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                className="sr-only"
                id="pf-photo-input"
                aria-label="Choose a profile photo"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPhoto(f);
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="h-4 w-4 mr-1.5" aria-hidden /> Change Photo
              </Button>
              {data.user.avatarUrl ? (
                <Button type="button" size="sm" variant="ghost" disabled={uploading} onClick={() => void removePhoto()}>
                  <Trash2 className="h-4 w-4 mr-1.5" aria-hidden /> Remove
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Account information — managed fields, read-only for every normal user */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Account information</CardTitle>
          <CardDescription>These details are verified and controlled — only a SUPER ADMIN can change them.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="pf-name">Full Name</Label>
            <Input id="pf-name" value={data.user.name} disabled readOnly aria-describedby="pf-name-hint" className="bg-muted/40" />
            <div id="pf-name-hint"><ManagedFieldHint /></div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pf-email">Email Address</Label>
            <Input id="pf-email" type="email" value={data.user.email} disabled readOnly aria-describedby="pf-email-hint" className="bg-muted/40" />
            <div id="pf-email-hint">
              <ManagedFieldHint>
                {data.user.googleLinked
                  ? "Managed by Super Admin — your Google sign-in stays linked."
                  : "Managed by Super Admin — your email is your sign-in identity."}
              </ManagedFieldHint>
            </div>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="pf-phone">Mobile Number</Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="pf-phone"
                type="tel"
                value={canonicalPhone.trim() || ""}
                disabled
                readOnly
                placeholder={phoneMissing ? "Not yet registered" : undefined}
                aria-describedby="pf-phone-hint"
                className="bg-muted/40 flex-1"
              />
              {isCustomer ? (
                phoneMissing ? (
                  <Button type="button" variant="outline" onClick={() => setPhoneDialogOpen(true)} className="shrink-0">
                    <Smartphone className="h-4 w-4 mr-1.5" aria-hidden /> Request Phone Number Update
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={() => setPhoneDialogOpen(true)} className="shrink-0">
                    <Smartphone className="h-4 w-4 mr-1.5" aria-hidden /> Request Update
                  </Button>
                )
              ) : null}
            </div>
            <div id="pf-phone-hint">
              <ManagedFieldHint>
                {isCustomer
                  ? "Managed by Super Admin — submit a request and a SUPER_ADMIN will review it."
                  : "Managed by Super Admin — contact your administrator to change it."}
              </ManagedFieldHint>
            </div>
          </div>
        </CardContent>
      </Card>

      {data.pendingPhoneRequest ? (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3 text-sm">
            <Clock className="h-5 w-5 text-amber-600 shrink-0" aria-hidden />
            <div className="min-w-0 text-amber-900">
              <span className="font-medium">Phone number update pending review.</span>{" "}
              <span className="text-amber-800">
                Proposed <strong>{data.pendingPhoneRequest.proposedValue}</strong>.
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="sm:ml-auto shrink-0 border-amber-300 text-amber-900 hover:bg-amber-100"
              onClick={() => void cancelPendingRequest()}
              disabled={cancelPending}
            >
              {cancelPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4 mr-1.5" aria-hidden />}
              Cancel request
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Customer details — the editable section for customers */}
      {isCustomer && data.customer ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Personal / business information</CardTitle>
            <CardDescription>
              Stored on your canonical customer record {data.customer.code ? `(${data.customer.code})` : ""} — used by every complaint, quotation and invoice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <div className="space-y-1.5">
                <Label htmlFor="pf-city">City <span className="text-[11px] font-normal text-muted-foreground">(Optional)</span></Label>
                <Input
                  id="pf-city"
                  placeholder="e.g. Bandar Seri Begawan"
                  value={draft.value.city}
                  onChange={(e) => draft.setValue({ city: e.target.value })}
                  maxLength={120}
                  aria-invalid={!!fieldErrors.city}
                />
                <FieldError msg={fieldErrors.city} />
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
      ) : null}

      {/* Staff — nothing else is self-serviceable; be honest about it */}
      {!isCustomer && !onboarding ? (
        <Card>
          <CardContent className="p-4 flex items-start gap-3 text-sm text-muted-foreground">
            <IdCard className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <span>
              All other account details (name, email, phone, role and employment record) are managed by MOHD.HMS administrators.
              Contact your administrator — or, for phone numbers, ask a SUPER_ADMIN to update them through User Management.
            </span>
          </CardContent>
        </Card>
      ) : null}

      {onboarding ? (
        <p className="text-xs text-muted-foreground text-center -mt-2">
          Company name is optional — individuals and homeowners can leave it blank.
        </p>
      ) : null}

      <PhoneRequestDialog
        open={phoneDialogOpen}
        onOpenChange={setPhoneDialogOpen}
        currentPhone={canonicalPhone}
        onSubmitted={load}
      />
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
