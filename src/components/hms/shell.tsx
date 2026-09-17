"use client";

// MOHD.HMS ENTERPRISE — application shell.
// Desktop: floating glassmorphism navigation. Mobile: bottom navigation.
// Role-based nav (frontend hint only — the backend enforces real permissions).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "./session";
import { useUi } from "@/lib/hms/ui-store";
import { MODULES, type ModuleDef } from "./registry";
import { humanize } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { initials } from "@/lib/hms/format";
import {
  Bell, CheckCheck, ChevronDown, Home, LayoutGrid, Loader2, LogOut,
  Menu, ScanLine, ShieldCheck, KeyRound, Info, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type NotifItem = {
  id: string; type: string; title: string; message: string;
  resourceType: string; resourceId: string; readAt: string | null; createdAt: string;
};

export function AppShell() {
  const { user, signOut } = useSession();
  const { activeModule, setActiveModule, deepLink, setDeepLink } = useUi();
  const [notifsOpen, setNotifsOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const { toast } = useToast();

  // Deep link handling (QR scans land on /?resource=equipment:{qrToken})
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const resource = sp.get("resource");
    if (resource) {
      const [type, ...rest] = resource.split(":");
      if (type && rest.length) {
        setDeepLink({ type, token: rest.join(":") });
      }
    }
  }, [setDeepLink]);

  const loadNotifs = useCallback(async () => {
    try {
      const res = await api.get<NotifItem[]>("/api/v1/notifications?take=20");
      setNotifs(res.data);
      setUnread(Number(res.meta?.unread ?? 0));
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    if (!user) return;
    const t = setInterval(loadNotifs, 60_000);
    const initial = setTimeout(loadNotifs, 0);
    return () => { clearInterval(t); clearTimeout(initial); };
  }, [user?.id, loadNotifs]);

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

  useEffect(() => {
    if (visible.length && !visible.some((m) => m.key === activeModule)) {
      setActiveModule(visible[0].key);
    }
  }, [visible, activeModule, setActiveModule]);

  // Consume deep link when its module exists
  useEffect(() => {
    if (deepLink && visible.some((m) => m.key === deepLink.type)) {
      setActiveModule(deepLink.type);
    }
  }, [deepLink, visible, setActiveModule]);

  if (!user) return null;

  const active = visible.find((m) => m.key === activeModule) ?? visible[0];
  const mobileNav = visible.filter((m) => m.mobile);
  const ActiveComponent = active?.component;

  async function markAllRead() {
    await api.patch("/api/v1/notifications/read-all", {}).catch(() => undefined);
    await loadNotifs();
  }

  async function markRead(id: string) {
    await api.patch("/api/v1/notifications", { ids: [id] }).catch(() => undefined);
    await loadNotifs();
  }

  return (
    <div className="min-h-screen flex flex-col bg-[radial-gradient(60rem_30rem_at_50%_-10%,oklch(0.95_0.05_152/0.6),transparent)]">
      {/* Top bar */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md no-print">
        <div className="mx-auto max-w-7xl px-3 sm:px-6 h-14 flex items-center gap-3">
          <div className="flex items-center gap-2.5 mr-1">
            <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold">H</div>
            <div className="leading-none">
              <div className="font-semibold text-sm tracking-tight">MOHD.HMS</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Enterprise</div>
            </div>
          </div>

          {/* Desktop floating nav */}
          <nav aria-label="Primary" className="hidden lg:flex items-center gap-1 mx-auto rounded-full border bg-white/70 backdrop-blur-md shadow-sm px-1.5 py-1.5 max-w-[52rem] overflow-x-auto hms-scroll">
            {visible.map((m) => (
              <button
                key={m.key}
                onClick={() => setActiveModule(m.key)}
                aria-current={activeModule === m.key ? "page" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                  activeModule === m.key ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <m.icon className="h-4 w-4" aria-hidden /> {m.shortLabel ?? m.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            {/* Notifications */}
            <DropdownMenu open={notifsOpen} onOpenChange={(o) => { setNotifsOpen(o); if (o) loadNotifs(); }}>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative rounded-full" aria-label={`Notifications (${unread} unread)`}>
                  <Bell className="h-5 w-5" />
                  {unread > 0 ? (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-destructive text-white text-[10px] font-semibold flex items-center justify-center tabular-nums">
                      {unread > 9 ? "9+" : unread}
                    </span>
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[22rem] sm:w-[26rem] p-0">
                <div className="flex items-center justify-between px-3 py-2.5 border-b">
                  <span className="font-medium text-sm">Notifications</span>
                  <Button variant="ghost" size="sm" onClick={markAllRead} disabled={unread === 0} className="h-7 text-xs">
                    <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark all read
                  </Button>
                </div>
                <div className="max-h-80 overflow-y-auto hms-scroll">
                  {notifs.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">You&apos;re all caught up 🎉</div>
                  ) : (
                    notifs.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => markRead(n.id)}
                        className={cn("w-full text-left px-3 py-2.5 border-b last:border-0 flex gap-2.5 hover:bg-accent/60", !n.readAt && "bg-primary/5")}
                      >
                        <span className="mt-0.5 shrink-0">
                          {n.type === "WARNING" ? <AlertTriangle className="h-4 w-4 text-amber-500" />
                            : n.type === "SUCCESS" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                            : <Info className="h-4 w-4 text-teal-500" />}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{n.title}</span>
                            {!n.readAt ? <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" aria-label="unread" /> : null}
                          </span>
                          <span className="text-xs text-muted-foreground line-clamp-2">{n.message}</span>
                          <span className="text-[10px] text-muted-foreground/70">{new Date(n.createdAt).toLocaleString()}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="rounded-full pl-1 pr-2 sm:pr-3 gap-2">
                  <span className="h-8 w-8 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">{initials(user.name)}</span>
                  <span className="hidden sm:block text-left leading-tight">
                    <span className="block text-sm font-medium max-w-[10rem] truncate">{user.name}</span>
                    <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{humanize(user.role)}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground hidden sm:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <div className="text-sm font-medium">{user.name}</div>
                  <div className="text-xs text-muted-foreground font-normal">{user.email}</div>
                  <Badge variant="outline" className="mt-1.5 bg-primary/5 text-primary border-primary/20">{humanize(user.role)}</Badge>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setPwOpen(true)}><KeyRound className="h-4 w-4 mr-2" /> Change password</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAboutOpen(true)}><Info className="h-4 w-4 mr-2" /> About MOHD.HMS</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { signOut(); toast({ title: "Signed out", description: "You have been securely logged out." }); }}>
                  <LogOut className="h-4 w-4 mr-2" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-3 sm:px-6 py-5 pb-24 lg:pb-8" id="main-content">
        {ActiveComponent ? <ActiveComponent /> : null}
      </main>

      {/* Sticky footer */}
      <footer className="mt-auto border-t bg-background/80 backdrop-blur no-print">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3.5 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span>© {new Date().getFullYear()} MOHD.HMS Enterprise — Smart Facility Maintenance Management</span>
          </div>
          <div className="flex items-center gap-3">
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
          {mobileNav.slice(0, 5).map((m) => (
            <button
              key={m.key}
              onClick={() => setActiveModule(m.key)}
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
          {visible.length > 5 ? (
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
                      onClick={() => { setActiveModule(m.key); setMobileMoreOpen(false); }}
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
          ) : null}
        </div>
      </nav>

      <ChangePasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>MOHD.HMS Enterprise</DialogTitle>
            <DialogDescription>Enterprise Smart Facility Maintenance Management System</DialogDescription>
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
