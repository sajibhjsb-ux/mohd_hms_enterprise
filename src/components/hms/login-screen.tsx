"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { useSession } from "./session";
import { Building2, Loader2, LogIn, ShieldCheck, Wrench, ClipboardList, FileText } from "lucide-react";

const DEMO_ACCOUNTS = [
  { email: "admin@mohdhms.com", role: "Super Admin" },
  { email: "operations@mohdhms.com", role: "Admin" },
  { email: "supervisor@mohdhms.com", role: "Supervisor" },
  { email: "ahmad.tech@mohdhms.com", role: "Technician" },
  { email: "finance@mohdhms.com", role: "Finance" },
  { email: "hr@mohdhms.com", role: "HR" },
  { email: "customer1@demo.my", role: "Customer" },
];

export function LoginScreen() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDemo, setShowDemo] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);

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
          <div className="flex items-center gap-3 mb-6">
            <div className="h-12 w-12 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center font-bold text-xl">H</div>
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
            <div className="mx-auto mb-2 h-11 w-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Building2 className="h-5 w-5" aria-hidden />
            </div>
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
              <Button type="submit" className="w-full h-11" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <LogIn className="h-4 w-4 mr-2" aria-hidden />}
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button type="button" className="text-primary hover:underline underline-offset-2" onClick={() => setForgotOpen(true)}>
                  Forgot password?
                </button>
                <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setShowDemo((s) => !s)}>
                  {showDemo ? "Hide" : "Show"} demo accounts
                </button>
              </div>
              {showDemo ? (
                <div className="rounded-lg border bg-muted/40 p-3 space-y-1.5" data-testid="demo-accounts">
                  <p className="text-xs font-medium text-muted-foreground">Demo accounts — password: <code className="font-mono">Password@123</code></p>
                  <div className="grid grid-cols-1 gap-1">
                    {DEMO_ACCOUNTS.map((a) => (
                      <button
                        key={a.email}
                        type="button"
                        className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-accent text-left"
                        onClick={() => { setEmail(a.email); setPassword("Password@123"); }}
                      >
                        <span className="font-mono">{a.email}</span>
                        <span className="text-muted-foreground">{a.role}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </form>
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
