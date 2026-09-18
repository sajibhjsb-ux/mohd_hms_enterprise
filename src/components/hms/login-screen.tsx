"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { useSession } from "./session";
import { Loader2, LogIn, ShieldCheck, Wrench, ClipboardList, FileText } from "lucide-react";

/** Official Google "G" mark (brand guideline colors). */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Server error codes (?googleError=) mapped to friendly, actionable messages. */
const GOOGLE_ERROR_MESSAGES: Record<string, string> = {
  not_configured: "Google sign-in is not configured on this server yet.",
  no_account:
    "No MOHD.HMS account matches this Google email. Ask your administrator to create your account, then try Google sign-in again to link it.",
  account_disabled: "This account has been disabled. Contact your administrator.",
  email_unverified:
    "Your Google account email is not verified. Use a verified Google account or sign in with your password.",
  state_mismatch: "This sign-in attempt expired or is no longer valid. Please try again.",
  exchange_failed: "Could not complete Google sign-in (token exchange failed). Please try again.",
  profile_failed: "Could not read your Google profile. Please try again.",
  provider_error: "Google returned an error during sign-in. Please try again.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes and try again.",
};

export function LoginScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);

  // Surface the outcome of a redirected Google sign-in attempt, then clean
  // the URL so refreshing doesn't replay the message.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("googleError");
    if (!code) return;
    if (code === "access_denied") {
      // User cancelled on Google's consent screen — not an error worth a banner.
    } else if (code === "not_configured") {
      setOauthError(
        `${GOOGLE_ERROR_MESSAGES.not_configured} Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server environment, then register this callback URL in Google Cloud Console: ${window.location.origin}/api/auth/callback/google`
      );
    } else {
      setOauthError(GOOGLE_ERROR_MESSAGES[code] ?? "Google sign-in failed. Please try again.");
    }
    try {
      window.history.replaceState(null, "", window.location.pathname);
    } catch {
      /* ignore */
    }
  }, []);

  function startGoogle() {
    setGoogleBusy(true);
    window.location.assign("/api/v1/auth/google");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function sendReset() {
    setForgotBusy(true);
    setForgotMsg(null);
    try {
      const res = await api.post<{ message: string }>("/api/v1/auth/forgot-password", { email: forgotEmail.trim().toLowerCase() });
      setForgotMsg(res.data.message);
    } catch (err) {
      setForgotMsg(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setForgotBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row">
      {/* Brand panel */}
      <div className="relative bg-primary text-primary-foreground lg:w-[45%] px-8 py-10 lg:py-0 flex flex-col justify-center overflow-hidden">
        <div className="absolute inset-0 opacity-[0.07]" aria-hidden>
          <svg className="h-full w-full" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">
            <defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0v40" fill="none" stroke="white" strokeWidth="1" /></pattern></defs>
            <rect width="400" height="400" fill="url(#grid)" />
          </svg>
        </div>
        <div className="relative max-w-md mx-auto lg:mx-0 lg:ml-16 xl:ml-28">
          <div className="flex items-center gap-3.5 mb-6">
            <Image
              src="/brand/logo-256.png"
              alt="MOHD HMS Enterprise logo"
              width={96}
              height={96}
              priority
              className="h-16 w-16 lg:h-[5.5rem] lg:w-[5.5rem] rounded-full ring-2 ring-white/25 shadow-lg"
            />
            <div>
              <div className="font-bold text-lg leading-tight">MOHD.HMS</div>
              <div className="text-xs uppercase tracking-[0.2em] text-primary-foreground/70">Enterprise</div>
            </div>
          </div>
          <h1 className="text-3xl lg:text-4xl font-bold leading-tight">Smart Facility Maintenance Management</h1>
          <p className="mt-4 text-primary-foreground/80 text-sm lg:text-base">
            Complaints, work orders, equipment, preventive maintenance, IRMS inspections, inventory, quotations, invoices, finance and HR — one secure enterprise platform.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-3 text-sm">
            {[
              { icon: Wrench, label: "Work Orders" },
              { icon: ClipboardList, label: "Complaints" },
              { icon: ShieldCheck, label: "Role-Based Access" },
              { icon: FileText, label: "Invoicing" },
            ].map((f) => (
              <div key={f.label} className="flex items-center gap-2 rounded-lg bg-white/10 backdrop-blur px-3 py-2.5">
                <f.icon className="h-4 w-4 shrink-0" aria-hidden /> <span className="truncate">{f.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Login panel */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <Card className="w-full max-w-md shadow-lg border-0 ring-1 ring-border">
          <CardHeader className="text-center">
            <Image
              src="/brand/logo-128.png"
              alt="MOHD HMS Enterprise logo"
              width={56}
              height={56}
              className="mx-auto mb-2 h-14 w-14"
            />
            <CardTitle className="text-xl">Sign in to your workspace</CardTitle>
            <CardDescription>Enter your credentials to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@mohdhms.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p>
              ) : null}
              {oauthError ? (
                <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2 break-words">{oauthError}</p>
              ) : null}
              <Button type="submit" className="w-full h-11" disabled={busy || googleBusy}>
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4 mr-2" aria-hidden />}
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <div className="flex items-center text-sm">
                <button type="button" className="text-primary hover:underline underline-offset-2" onClick={() => setForgotOpen(true)}>
                  Forgot password?
                </button>
              </div>
            </form>
            <div className="relative mt-5 mb-4" aria-hidden>
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-2 text-xs uppercase tracking-wide text-muted-foreground">or</span>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full h-11"
              onClick={startGoogle}
              disabled={busy || googleBusy}
            >
              {googleBusy ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden />
              ) : (
                <GoogleIcon className="h-4 w-4 mr-2" />
              )}
              {googleBusy ? "Redirecting to Google…" : "Sign in with Google"}
            </Button>
          </CardContent>
        </Card>
        <p className="mt-6 text-xs text-muted-foreground text-center max-w-sm">
          Protected enterprise system. All access is authenticated, role-based and audit-logged.
        </p>
      </div>

      {/* Forgot password */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription>Enter your account email. If it exists, a reset link will be sent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="forgot-email">Email</Label>
              <Input id="forgot-email" type="email" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} placeholder="you@mohdhms.com" />
            </div>
            {forgotMsg ? <p className="text-sm text-muted-foreground bg-muted rounded-md px-3 py-2">{forgotMsg}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForgotOpen(false)}>Close</Button>
            <Button onClick={sendReset} disabled={forgotBusy || !forgotEmail.includes("@")}>
              {forgotBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Send reset link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
