"use client";

// MOHD.HMS ENTERPRISE — premium top header (reference design).
// Left: canonical logo/branding · Center: global search trigger (Ctrl/⌘K)
// Right: QR scanner · Notifications · Theme · Language · User profile.
// Self-contained notification polling; reuses existing session + theme systems.

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, RESOURCE_ROUTES } from "@/lib/hms/router";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { initials } from "@/lib/hms/format";
import { cn } from "@/lib/utils";
import { onRealtimeState, type RealtimeState } from "@/lib/hms/realtime/bus";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { RT } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { PushNotificationRow, startInstall, useInstallable } from "./pwa-menu";
import {
  AlertTriangle, Bell, CheckCircle2, CheckCheck, ChevronDown, Download, Globe, Info, KeyRound, Loader2,
  LogOut, Moon, QrCode, Search, Sun,
} from "lucide-react";

type NotifItem = {
  id: string; type: string; title: string; message: string;
  resourceType: string; resourceId: string; readAt: string | null; createdAt: string;
};

type Props = {
  onOpenSearch: () => void;
  onOpenQr: () => void;
  onSelectModule: (key: string) => void;
  onOpenChangePassword: () => void;
  onOpenAbout: () => void;
};

export function TopHeader({ onOpenSearch, onOpenQr, onSelectModule, onOpenChangePassword, onOpenAbout }: Props) {
  const { user, signOut } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [mounted, setMounted] = useState(false);
  const { toast } = useToast();
  const toastSeq = useRef(0);

  // Theme icon must only render after hydration to avoid mismatch
  // (rAF keeps setState off the synchronous effect path).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

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

  // Realtime notifications (STEP 17): badge/panel/toast update immediately —
  // no refresh. The server only delivers events targeted at THIS user.
  useRealtimeEvent([RT.NOTIFICATION_CREATED], (ev) => {
    void loadNotifs();
    toastSeq.current += 1;
    const title = typeof ev.data?.title === "string" ? ev.data.title : "New notification";
    const message = typeof ev.data?.message === "string" ? ev.data.message : undefined;
    const isError = ev.data?.type === "ERROR";
    toast({
      title,
      description: message,
      variant: isError ? "destructive" : "default",
    });
  });

  async function markAllRead() {
    await api.patch("/api/v1/notifications/read-all", {}).catch(() => undefined);
    await loadNotifs();
  }

  async function markRead(id: string) {
    await api.patch("/api/v1/notifications", { ids: [id] }).catch(() => undefined);
    await loadNotifs();
  }

  function toggleTheme() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }

  const canScan = hasPerm(user, PERMISSIONS.equipment_read);

  return (
    <TooltipProvider delayDuration={250}>
      <header className="sticky top-0 z-40 border-b border-border/50 bg-background/85 backdrop-blur-xl no-print pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-[1500px] px-4 sm:px-6 h-16 md:h-[72px] flex items-center gap-2 sm:gap-4">
          {/* Branding — canonical logo + wordmark (same source as login/PWA).
              Wordmark hides below sm so the search pill never overlaps it. */}
          <button
            onClick={() => onSelectModule("dashboard")}
            className="flex items-center gap-2.5 mr-1 shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="MOHD HMS Enterprise — go to dashboard"
          >
            <Image src="/brand/logo-128.png" alt="MOHD HMS Enterprise logo" width={40} height={40} priority className="h-9 w-9 md:h-10 md:w-10 rounded-full" />
            <div className="leading-none text-left hidden sm:block">
              <div className="font-semibold text-sm md:text-base tracking-tight">MOHD.HMS</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Enterprise</div>
            </div>
          </button>

          {/* Global search — large pill (desktop) / icon (mobile) */}
          <div className="flex-1 flex justify-center min-w-0">
            <button
              onClick={onOpenSearch}
              className={cn(
                "group flex items-center gap-2.5 h-10 md:h-11 rounded-full border border-border/70 bg-muted/40 hover:bg-muted/70 hover:border-border transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "w-10 md:w-auto md:flex-1 md:min-w-0 md:max-w-[560px] justify-center md:justify-start md:px-4"
              )}
              aria-label="Open global search"
            >
              <Search className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" aria-hidden />
              <span className="hidden md:inline text-sm text-muted-foreground group-hover:text-foreground/80 transition-colors truncate">
                Search equipment, customers, work orders…
              </span>
              <kbd className="hidden lg:inline-flex ml-auto items-center gap-0.5 rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                <SearchShortcutHint />
              </kbd>
            </button>
          </div>

          {/* Right cluster */}
          <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
            <LiveIndicator />
            {canScan ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="rounded-full hidden sm:inline-flex" onClick={onOpenQr} aria-label="Open QR scanner">
                    <QrCode className="h-5 w-5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>QR Scanner</TooltipContent>
              </Tooltip>
            ) : null}

            <NotifMenu
              notifs={notifs}
              unread={unread}
              onOpen={loadNotifs}
              markAllRead={markAllRead}
              markRead={markRead}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full hidden lg:inline-flex" onClick={toggleTheme} aria-label="Toggle dark or light theme">
                  {mounted && resolvedTheme === "dark" ? <Sun className="h-5 w-5" aria-hidden /> : <Moon className="h-5 w-5" aria-hidden />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{mounted && resolvedTheme === "dark" ? "Light mode" : "Dark mode"}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span className="hidden lg:inline-flex items-center gap-1.5 h-9 px-2.5 rounded-full border border-border/60 bg-background text-xs font-medium text-muted-foreground" title="Language: English">
                  <Globe className="h-4 w-4" aria-hidden /> EN
                </span>
              </TooltipTrigger>
              <TooltipContent>English</TooltipContent>
            </Tooltip>

            <ProfileMenu
              onToggleTheme={toggleTheme}
              themeMounted={mounted}
              themeDark={mounted && resolvedTheme === "dark"}
              onSignOut={async () => { await signOut(); }}
              onOpenChangePassword={onOpenChangePassword}
              onOpenAbout={onOpenAbout}
            />
          </div>
        </div>
      </header>
    </TooltipProvider>
  );
}

function SearchShortcutHint() {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  return <span aria-hidden>{isMac ? "⌘K" : "Ctrl K"}</span>;
}

/**
 * Realtime connection indicator (STEP 21/24).
 * Small, non-blocking status pill — no error modals on reconnect. Only the
 * connection health is shown to everyone; technical diagnostics stay in the
 * Super Admin's realtime health panel.
 */
function LiveIndicator() {
  const [state, setState] = useState<RealtimeState>("CONNECTING");
  useEffect(() => onRealtimeState(setState), []);

  const live = state === "CONNECTED";
  const label =
    state === "CONNECTED" ? "Live"
    : state === "RECONNECTING" ? "Reconnecting…"
    : state === "CONNECTING" ? "Connecting…"
    : state === "FAILED" ? "Offline"
    : "Offline";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "hidden sm:inline-flex items-center gap-1.5 h-9 px-2.5 rounded-full border text-xs font-medium",
            live
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
              : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400"
          )}
          role="status"
          aria-live="polite"
          aria-label={`Realtime connection: ${label}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} aria-hidden />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{live ? "Realtime updates are live" : "Realtime updates are retrying automatically"}</TooltipContent>
    </Tooltip>
  );
}

function NotifMenu({ notifs, unread, onOpen, markAllRead, markRead }: {
  notifs: NotifItem[];
  unread: number;
  onOpen: () => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={(o) => { setOpen(o); if (o) onOpen(); }}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative rounded-full" aria-label={`Notifications (${unread} unread)`}>
          <Bell className="h-5 w-5" aria-hidden />
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
            <CheckCheck className="h-3.5 w-3.5 mr-1" aria-hidden /> Mark all read
          </Button>
        </div>
        <div className="max-h-80 overflow-y-auto hms-scroll">
          {notifs.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">You&apos;re all caught up 🎉</div>
          ) : (
            notifs.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  if (!n.readAt) markRead(n.id);
                  // Navigate to the resource's dedicated detail page when one exists.
                  if (n.resourceId) {
                    const route = RESOURCE_ROUTES[n.resourceType];
                    if (route) {
                      setOpen(false);
                      navigateTo(route.module, route.seg(n.resourceId));
                    }
                  }
                }}
                className={cn("w-full text-left px-3 py-2.5 border-b last:border-0 flex gap-2.5 hover:bg-accent/60", !n.readAt && "bg-primary/5")}
              >
                <span className="mt-0.5 shrink-0">
                  {n.type === "WARNING" ? <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
                    : n.type === "SUCCESS" ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />
                    : <Info className="h-4 w-4 text-teal-500" aria-hidden />}
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
        {/* Web Push opt-in for this device (real state only, §41) */}
        <PushNotificationRow />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProfileMenu({ onToggleTheme, themeMounted, themeDark, onSignOut, onOpenChangePassword, onOpenAbout }: {
  onToggleTheme: () => void;
  themeMounted: boolean;
  themeDark: boolean;
  onSignOut: () => Promise<void>;
  onOpenChangePassword: () => void;
  onOpenAbout: () => void;
}) {
  const { user } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const installable = useInstallable();
  if (!user) return <span className="h-8 w-8 rounded-full bg-muted animate-pulse" aria-hidden />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="rounded-full pl-1 pr-1.5 sm:pr-2.5 gap-2">
          <span className="h-9 w-9 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center">{initials(user.name)}</span>
          <span className="hidden md:block text-left leading-tight">
            <span className="block text-sm font-medium max-w-[10rem] truncate">{user.name}</span>
            <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{humanize(user.role)}</span>
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground hidden md:block" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>
          <div className="text-sm font-medium">{user.name}</div>
          <div className="text-xs text-muted-foreground font-normal">{user.email}</div>
          <Badge variant="outline" className="mt-1.5 bg-primary/5 text-primary border-primary/20">{humanize(user.role)}</Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {installable ? (
          <DropdownMenuItem onClick={() => { void startInstall(); }}>
            <Download className="h-4 w-4 mr-2" aria-hidden /> Install app
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onToggleTheme}>
          {themeMounted && themeDark ? <Sun className="h-4 w-4 mr-2" aria-hidden /> : <Moon className="h-4 w-4 mr-2" aria-hidden />}
          {themeMounted && themeDark ? "Light mode" : "Dark mode"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenChangePassword}>
          <KeyRound className="h-4 w-4 mr-2" aria-hidden /> Change password
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenAbout}>
          <Info className="h-4 w-4 mr-2" aria-hidden /> About MOHD.HMS
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async () => {
            setSigningOut(true);
            try { await onSignOut(); } finally { setSigningOut(false); }
          }}
        >
          {signingOut ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : <LogOut className="h-4 w-4 mr-2" aria-hidden />}
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
