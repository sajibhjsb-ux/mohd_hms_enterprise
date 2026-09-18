"use client";

// MOHD.HMS ENTERPRISE — application shell (orchestrator + page router).
// Desktop: premium top header + floating navigation (reference design).
// Mobile: simplified header + bottom navigation. Role-based nav is a UX hint;
// the backend enforces real permissions. One authoritative nav config: MODULES.
//
// NAVIGATION ARCHITECTURE — dedicated pages, no popup CRUD:
// Every business form/detail/management view is a full page addressed by a
// hash route (#/complaints/new, #/complaints/{id}, …). The shell owns the
// location.hash ⇄ ui-store sync, so browser Back/Forward and direct URLs work.
// While any form page is dirty, route changes are guarded by a confirm dialog
// ("Leave with unsaved changes?") — drafts auto-save as a second safety net.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "./session";
import { useUi } from "@/lib/hms/ui-store";
import { hrefFor, navigateTo, parseHash, replaceHash } from "@/lib/hms/router";
import { MODULES, type ModuleDef } from "./registry";
import { humanize } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/hms/format";
import { LayoutGrid, Loader2, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { TopHeader } from "./shell/header";
import { FloatingNav } from "./shell/floating-nav";
import { GlobalSearch, type SearchNavigateTarget } from "./shell/global-search";
import { QrScanDialog } from "./shell/qr-dialog";

export function AppShell() {
  const { user } = useSession();
  const activeModule = useUi((s) => s.activeModule);
  const deepLink = useUi((s) => s.deepLink);
  const setDeepLink = useUi((s) => s.setDeepLink);
  const [searchOpen, setSearchOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Hash the user asked for while a dirty form blocked navigation. */
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const { toast } = useToast();

  const visible = useMemo(
    () => MODULES.filter((m: ModuleDef) => {
      if (m.roles && user && !m.roles.includes(user.role)) return false;
      if (m.permissions && m.permissions.length) {
        return m.permissions.some((p) => hasPerm(user, p));
      }
      return true;
    }),
    [user]
  );

  // Latest visible modules for the hashchange handler (avoids stale closures).
  const visibleRef = useRef<ModuleDef[]>(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  /** Hash of the page currently rendered (drives guard + no-op detection). */
  const appliedHashRef = useRef<string>("");

  const applyHash = useCallback((hash: string) => {
    // Re-applying the page we're already on (e.g. browser Back returning to a
    // dirty form after "Stay") must be a no-op — it must NOT clear dirtiness.
    if (hash && hash === appliedHashRef.current) return hash;
    const vis = visibleRef.current;
    const parsed = parseHash(hash);
    let target = parsed?.module;
    let seg = parsed?.seg ?? [];
    if (!target || (vis.length > 0 && !vis.some((m) => m.key === target))) {
      target = vis[0]?.key ?? "dashboard";
      seg = [];
      replaceHash(hrefFor(target, seg));
    }
    const ui = useUi.getState();
    if (ui.activeModule !== target) ui.setActiveModule(target);
    ui.setPage(target, seg);
    // A fresh route is never dirty — the (unmounting) form page keeps its draft.
    useUi.setState({ pageDirty: false });
    window.scrollTo(0, 0);
    appliedHashRef.current = hrefFor(target, seg);
    return appliedHashRef.current;
  }, []);

  // Hash ⇄ store sync. Mounted once the user is authenticated so role-based
  // fallbacks resolve; also handles direct URLs (#/complaints/{id}) after login.
  useEffect(() => {
    if (!user) return;
    applyHash(window.location.hash || `#${visibleRef.current[0]?.key ?? "dashboard"}`);
    const onHashChange = () => {
      const next = window.location.hash;
      if (useUi.getState().pageDirty && next !== appliedHashRef.current) {
        // Keep rendering the form until the user confirms; URL shows the target.
        setPendingNav(next);
        return;
      }
      applyHash(next);
    };
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) replaceHash(appliedHashRef.current);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [user, applyHash]);

  // Deep link handling (QR scans land on /?resource=equipment:{qrToken})
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const resource = sp.get("resource");
    if (resource) {
      const [type, ...rest] = resource.split(":");
      if (type && rest.length) {
        setDeepLink({ type, token: rest.join(":") });
        navigateTo(type);
      }
    }
  }, [setDeepLink]);

  useEffect(() => {
    if (deepLink && visible.some((m) => m.key === deepLink.type)) {
      if (!window.location.hash) navigateTo(deepLink.type);
    }
  }, [deepLink, visible]);

  /**
   * Single guarded navigation entry for header / floating nav / mobile nav.
   * Delegates to the hash router — the hashchange guard asks before leaving
   * dirty form pages. NOTE: declared before the early return (rules of hooks).
   */
  const switchModule = useCallback((key: string) => {
    navigateTo(key);
  }, []);

  const navigateFromSearch = useCallback((t: SearchNavigateTarget) => {
    navigateTo(t.module, t.id ? [t.id] : []);
  }, []);

  const navigateFromQr = useCallback((module: string, token: string) => {
    setDeepLink({ type: module, token });
    navigateTo(module);
  }, [setDeepLink]);

  if (!user) return null;

  const active = visible.find((m) => m.key === activeModule) ?? visible[0];
  const mobileNav = visible.filter((m) => m.mobile);
  const ActiveComponent = active?.component;

  return (
    <div className="min-h-screen flex flex-col bg-[radial-gradient(60rem_30rem_at_50%_-10%,oklch(0.95_0.05_152/0.6),transparent)] dark:bg-none">
      <TopHeader
        onOpenSearch={() => setSearchOpen(true)}
        onOpenQr={() => setQrOpen(true)}
        onSelectModule={switchModule}
        onOpenChangePassword={() => setPwOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <FloatingNav visible={visible} activeModule={activeModule} onSelect={switchModule} />

      {/* Content — aligned with the floating navigation grid */}
      <main className="flex-1 mx-auto w-full max-w-[1500px] px-4 sm:px-6 py-5 pb-24 lg:pb-8" id="main-content">
        {ActiveComponent ? <ActiveComponent /> : null}
      </main>

      {/* Sticky footer */}
      <footer className="mt-auto border-t bg-background/80 backdrop-blur no-print">
        <div className="mx-auto max-w-[1500px] px-4 sm:px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span>© {new Date().getFullYear()} MOHD.HMS Enterprise — Smart Facility Maintenance Management</span>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <span className="hidden sm:inline">www.mohdhms.com</span>
            <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 inline-block" aria-hidden /> System healthy
            </Badge>
          </div>
        </div>
      </footer>

      {/* Mobile bottom navigation */}
      <nav aria-label="Mobile navigation" className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t bg-background/90 backdrop-blur-md no-print pb-[env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-5">
          {mobileNav.slice(0, 4).map((m) => (
            <button
              key={m.key}
              onClick={() => switchModule(m.key)}
              aria-current={activeModule === m.key ? "page" : undefined}
              className={cn(
                "flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium min-h-[44px]",
                activeModule === m.key ? "text-primary" : "text-muted-foreground"
              )}
            >
              <m.icon className="h-5 w-5" aria-hidden />
              {m.shortLabel ?? m.label}
            </button>
          ))}
          <Sheet open={mobileMoreOpen} onOpenChange={setMobileMoreOpen}>
            <SheetTrigger asChild>
              <button className="flex flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium text-muted-foreground min-h-[44px]">
                <LayoutGrid className="h-5 w-5" aria-hidden /> More
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-2xl">
              <SheetHeader>
                <SheetTitle>All modules</SheetTitle>
              </SheetHeader>
              <div className="grid grid-cols-3 gap-2 pb-6">
                {visible.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => { switchModule(m.key); setMobileMoreOpen(false); }}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs font-medium",
                      activeModule === m.key ? "border-primary bg-primary/5 text-primary" : "text-muted-foreground"
                    )}
                  >
                    <m.icon className="h-5 w-5" aria-hidden />
                    {m.shortLabel ?? m.label}
                  </button>
                ))}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>

      {/* Overlays (utility dialogs only — business CRUD uses dedicated pages) */}
      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} onNavigate={navigateFromSearch} />
      <QrScanDialog open={qrOpen} onOpenChange={setQrOpen} onNavigate={navigateFromQr} />

      {/* Unsaved-changes guard — blocks any route change away from a dirty form */}
      <Dialog open={!!pendingNav} onOpenChange={(o) => { if (!o) setPendingNav(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave with unsaved changes?</DialogTitle>
            <DialogDescription>
              This page has unsaved changes. Your draft auto-saves as you type and will be offered for restore when you return.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setPendingNav(null)}>
              Stay on this page
            </Button>
            <Button onClick={() => {
              const target = pendingNav;
              setPendingNav(null);
              useUi.getState().setPageDirty(false);
              if (target) applyHash(target);
            }}>
              Leave anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex justify-center" aria-hidden>
              <Image src="/brand/logo-128.png" alt="" width={72} height={72} className="h-[4.5rem] w-[4.5rem] rounded-full" />
            </div>
            <DialogTitle className="text-center">MOHD.HMS Enterprise</DialogTitle>
            <DialogDescription className="text-center">Enterprise Smart Facility Maintenance Management System</DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            <p>Manages facility maintenance, equipment, complaints, work orders, preventive maintenance, IRMS inspections, inventory, procurement, quotations, invoices, finance, HR, vehicles and reporting.</p>
            <p className="text-xs">Signed in as <strong>{user.name}</strong> · {humanize(user.role)} · {user.email}</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setAboutOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/api/v1/auth/password", { currentPassword: current, newPassword: next });
      toast({ title: "Password changed", description: "Your password has been updated." });
      onOpenChange(false);
      setCurrent(""); setNext("");
    } catch (err) {
      setError(err instanceof ClientApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>Minimum 8 characters with letters and numbers. Other sessions stay signed in.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="cur-pw">Current password</Label>
            <Input id="cur-pw" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-pw">New password</Label>
            <Input id="new-pw" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !current || !next}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null} Update password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
