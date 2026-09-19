"use client";

// MOHD.HMS ENTERPRISE — application shell (orchestrator + page router).
// Desktop: premium top header + floating navigation (reference design).
// Mobile: simplified header + bottom navigation. Role-based nav is a UX hint;
// the backend enforces real permissions. One authoritative nav config: MODULES.
//
// NAVIGATION ARCHITECTURE — dedicated pages, no popup CRUD:
// Every business form/detail/management view is a full page addressed by a
// path route (/complaints/new, /complaints/{id}, …). The shell owns the
// location pathname ⇄ ui-store sync, so browser Back/Forward and direct URLs
// work. While any form page is dirty, route changes are guarded by a confirm
// dialog ("Leave with unsaved changes?") — drafts auto-save as a second safety net.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "./session";
import { useUi } from "@/lib/hms/ui-store";
import { ROUTE_EVENT, hrefFor, navigateTo, parsePath, replacePath } from "@/lib/hms/router";
import { MODULES, type ModuleDef } from "./registry";
import { humanize } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/hms/format";
import { Loader2, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { TopHeader } from "./shell/header";
import { FloatingNav } from "./shell/floating-nav";
import { MobileNav } from "./shell/mobile-nav";
import { GlobalSearch, type SearchNavigateTarget } from "./shell/global-search";
import { QrScanDialog } from "./shell/qr-dialog";
import { RealtimeProvider } from "./realtime/realtime-provider";
import { TermsConsentGate } from "./legal/terms-consent-gate";

export function AppShell() {
  const { user } = useSession();
  const activeModule = useUi((s) => s.activeModule);
  const deepLink = useUi((s) => s.deepLink);
  const setDeepLink = useUi((s) => s.setDeepLink);
  const changePwOpen = useUi((s) => s.changePwOpen);
  const setChangePwOpen = useUi((s) => s.setChangePwOpen);
  const [searchOpen, setSearchOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
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

  // Modules reachable but not shown in the module navigation (profile is
  // entered from the header account menu).
  const navVisible = useMemo(() => visible.filter((m) => !m.navHidden), [visible]);

  // Latest visible modules for the hashchange handler (avoids stale closures).
  const visibleRef = useRef<ModuleDef[]>(visible);
  useEffect(() => { visibleRef.current = visible; }, [visible]);

  /** Path of the page currently rendered (drives guard + no-op detection). */
  const appliedHashRef = useRef<string>("");

  const applyRoute = useCallback((path: string) => {
    // Re-applying the page we're already on (e.g. browser Back returning to a
    // dirty form after "Stay") must be a no-op — it must NOT clear dirtiness.
    // The comparison includes the query string so drill-down URLs (/complaints
    // ?status=active) re-apply correctly and plain URLs clear the filters.
    const vis = visibleRef.current;
    const parsed = parsePath(path);
    let target = parsed?.module;
    let seg = parsed?.seg ?? [];
    const query = parsed?.query ?? "";
    const canonical = hrefFor(target ?? "dashboard", seg) + (query ? `?${new URLSearchParams(query).toString()}` : "");
    if (path && canonical === appliedHashRef.current) return path;
    if (!target || (vis.length > 0 && !vis.some((m) => m.key === target))) {
      target = vis[0]?.key ?? "dashboard";
      seg = [];
      replacePath(hrefFor(target, seg));
    }
    const routeQuery = parsed && parsed.module === target ? query : "";
    const canonicalRoute = hrefFor(target, seg) + (routeQuery ? `?${new URLSearchParams(routeQuery).toString()}` : "");
    const ui = useUi.getState();
    if (ui.activeModule !== target) ui.setActiveModule(target);
    ui.setPage(target, seg);
    ui.setQuery(target, routeQuery);
    // A fresh route is never dirty — the (unmounting) form page keeps its draft.
    useUi.setState({ pageDirty: false });
    window.scrollTo(0, 0);
    appliedHashRef.current = canonicalRoute;
    return appliedHashRef.current;
  }, []);

  // Path ⇄ store sync. Mounted once the user is authenticated so role-based
  // fallbacks resolve; also handles direct URLs (/complaints/{id}) after login.
  useEffect(() => {
    if (!user) return;
    const currentPath = () => window.location.pathname + window.location.search;
    applyRoute(currentPath() || `/${visibleRef.current[0]?.key ?? "dashboard"}`);
    const onRouteChange = () => {
      const next = currentPath();
      if (useUi.getState().pageDirty && next !== appliedHashRef.current) {
        // Keep rendering the form until the user confirms; URL shows the target.
        setPendingNav(next);
        return;
      }
      applyRoute(next);
    };
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener(ROUTE_EVENT, onRouteChange);
    if (window.location.pathname === "/") replacePath(appliedHashRef.current);
    return () => {
      window.removeEventListener("popstate", onRouteChange);
      window.removeEventListener(ROUTE_EVENT, onRouteChange);
    };
  }, [user, applyRoute]);

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
      if (window.location.pathname === "/") navigateTo(deepLink.type);
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

  // Consent gate (spec §21/§22/§26): while a customer has not accepted the
  // current Terms & Conditions version, the portal is replaced by the consent
  // screen — first acceptance AND the "updated" re-acceptance flow. The state
  // is backend-authoritative (session payload), never a UI-only flag.
  if (user.role === "CUSTOMER" && user.terms?.requiresAcceptance === true) {
    return <TermsConsentGate />;
  }

  const active = visible.find((m) => m.key === activeModule) ?? visible[0];
  const ActiveComponent = active?.component;

  return (
    <RealtimeProvider>
    {/* --hms-mobile-nav-h is measured by MobileNav (bar + safe-area + QR rise +
        gap) so the footer and every page element clear the floating bottom nav */}
    <div className="min-h-screen flex flex-col bg-[radial-gradient(60rem_30rem_at_50%_-10%,oklch(0.95_0.05_152/0.6),transparent)] dark:bg-none pb-[var(--hms-mobile-nav-h,102px)] lg:pb-0">
      <TopHeader
        onOpenSearch={() => setSearchOpen(true)}
        onOpenQr={() => setQrOpen(true)}
        onSelectModule={switchModule}
        onOpenChangePassword={() => setChangePwOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
      />
      <FloatingNav visible={navVisible} activeModule={activeModule} onSelect={switchModule} />

      {/* Content — aligned with the floating navigation grid */}
      <main className="flex-1 mx-auto w-full max-w-[1500px] px-4 sm:px-6 py-5 lg:pb-8" id="main-content">
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
            {/* Canonical legal pages (spec §25) — internal SPA navigation. */}
            <button
              type="button"
              onClick={() => navigateTo("terms")}
              className="underline-offset-4 hover:underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              Terms &amp; Conditions
            </button>
            <button
              type="button"
              onClick={() => navigateTo("privacy")}
              className="underline-offset-4 hover:underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
            >
              Privacy Policy
            </button>
            <a
              href="https://www.mohdhms.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline underline-offset-4 hover:underline hover:text-foreground"
            >
              www.mohdhms.com
            </a>
            <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 mr-1 inline-block" aria-hidden /> System healthy
            </Badge>
          </div>
        </div>
      </footer>

      {/* Mobile floating bottom navigation — 5-slot grid, QR scanner center */}
      <MobileNav
        modules={navVisible}
        activeModule={activeModule}
        onSelect={switchModule}
        onOpenQr={() => setQrOpen(true)}
      />

      {/* Overlays (utility dialogs only — business CRUD uses dedicated pages) */}
      <ChangePasswordDialog open={changePwOpen} onOpenChange={setChangePwOpen} />
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
              if (target) applyRoute(target);
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
    </RealtimeProvider>
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
