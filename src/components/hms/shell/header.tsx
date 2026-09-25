"use client";

// MOHD.HMS ENTERPRISE — premium top header (reference design).
// Three logical zones. MOBILE (<lg): [ LOGO + MOHD.HMS/ENTERPRISE lockup ]·spacer·
// [ Search 🔍 ][ ● N Online ][ Bell ][ Avatar ] — the FULL brand lockup (official
// circular logo + two-line company name) is visible on EVERY width; search is a
// compact icon inside the RIGHT action group, never a standalone centered element.
// DESKTOP (≥lg): logo · centered global-search pill (Ctrl/⌘K) · Online presence ·
// QR scanner · Notifications · Theme · Language · User profile.
// On mobile the QR action lives in the floating bottom navigation's center slot
// (shell/mobile-nav.tsx), so the header QR button is desktop-only.
// Self-contained notification polling; reuses existing session + theme +
// realtime-presence systems (the ● N Online pill is backend-authoritative).

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ClientApiError, api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { GlobalSearch, type SearchNavigateTarget } from "./global-search";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, RESOURCE_ROUTES } from "@/lib/hms/router";
import { humanize, PERMISSIONS } from "@/lib/hms/constants";
import { initials } from "@/lib/hms/format";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/hms/shared/avatar";
import { onRealtimeState, onRealtimePresenceCount, type RealtimeState } from "@/lib/hms/realtime/bus";
import { getRealtimeSocket } from "@/lib/hms/realtime/socket";
import { useRealtimeEvent } from "@/lib/hms/realtime/hooks";
import { RT } from "@/lib/hms/realtime/matrix";
import { useToast } from "@/hooks/use-toast";
import { PushNotificationRow, startInstall, useInstallable } from "./pwa-menu";
import {
  AlertTriangle, Bell, CheckCircle2, CheckCheck, ChevronDown, CircleUserRound, Download, Globe, Info, KeyRound, Loader2,
  LogOut, Moon, QrCode, Search, Sun, X,
} from "lucide-react";

type NotifItem = {
  id: string; type: string; title: string; message: string;
  resourceType: string; resourceId: string; readAt: string | null; createdAt: string;
};

type Props = {
  /** Navigates to a search result's detail page through the shell's
   *  dirty-state guard (same path the old dialog used). */
  onSearchNavigate: (target: SearchNavigateTarget) => void;
  onOpenQr: () => void;
  onSelectModule: (key: string) => void;
  onOpenChangePassword: () => void;
  onOpenAbout: () => void;
};

export function TopHeader({ onSearchNavigate, onOpenQr, onSelectModule, onOpenChangePassword, onOpenAbout }: Props) {
  const { user, signOut } = useSession();
  const { resolvedTheme, setTheme } = useTheme();
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [mounted, setMounted] = useState(false);
  // Mobile INLINE search mode: the header row swaps to a full-width search
  // field (results dropdown beneath it) — never a fullscreen modal/dialog.
  const [mobileSearch, setMobileSearch] = useState(false);
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
        <div className="mx-auto max-w-[1500px] px-3 min-[360px]:px-4 sm:px-6 h-16 md:h-[72px] flex items-center gap-2 sm:gap-4">
          {mobileSearch ? (
            /* MOBILE INLINE SEARCH MODE — the same header, same bar position,
               zero modal/overlay: a full-width field with the results panel
               anchored beneath it. [×] (or Escape) returns to the header. */
            <div className="flex items-center gap-1.5 w-full min-w-0" data-testid="mobile-search-mode">
              <GlobalSearch
                variant="mobile"
                autoFocus
                onNavigate={onSearchNavigate}
                onClose={() => setMobileSearch(false)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full h-10 w-10 shrink-0"
                onClick={() => setMobileSearch(false)}
                aria-label="Close search"
                data-testid="mobile-search-close"
              >
                <X className="h-5 w-5" aria-hidden />
              </Button>
            </div>
          ) : (
            <>
          {/* Branding — full official brand lockup on EVERY width (logo + two-line
              wordmark, one indivisible brand group). Responsive tiers shrink the
              logo/text/gaps on narrow screens; the name is never hidden, wrapped
              or truncated. Desktop (md+) rendering is unchanged. */}
          <button
            onClick={() => onSelectModule("dashboard")}
            className="flex items-center gap-2 min-[360px]:gap-2.5 mr-1 shrink-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="MOHD HMS Enterprise — go to dashboard"
          >
            <BrandLockup />
          </button>

          {/* Global search — INLINE on DESKTOP: the centered pill IS the real
              input. Clicking it focuses the field directly and results open in
              a dropdown anchored beneath it — no popup/dialog/overlay. */}
          <div className="hidden lg:flex flex-1 justify-center min-w-0">
            <GlobalSearch variant="desktop" onNavigate={onSearchNavigate} />
          </div>

          {/* Right action group — search · notifications · profile share one
              vertical centerline; the group hugs the right edge on mobile. */}
          <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
            {/* Compact mobile search — activates the SAME inline search inside
                the header (never the desktop dialog). */}
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full h-10 w-10 sm:h-9 sm:w-9 lg:hidden"
              onClick={() => setMobileSearch(true)}
              aria-label="Search"
              data-testid="mobile-search-button"
            >
              <Search className="h-5 w-5" aria-hidden />
            </Button>

            <OnlinePresenceIndicator />
            {canScan ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* Desktop-only here — mobile/tablet use the bottom-nav center QR. */}
                  <Button variant="ghost" size="icon" className="rounded-full hidden lg:inline-flex" onClick={onOpenQr} aria-label="Open QR scanner">
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
            </>
          )}
        </div>
      </header>
    </TooltipProvider>
  );
}

/**
 * Official brand lockup — [ circular logo | MOHD.HMS / ENTERPRISE ].
 * One flex group vertically centered via the parent's align-items:center;
 * no absolute positioning, margins hacks or transforms.
 *
 * Responsive tiers (mobile-first; desktop md+ unchanged):
 *   <360px  → 32px logo · 14px MOHD.HMS · 9px ENTERPRISE · tighter tracking
 *   ≥360px  → 36px logo · 17px MOHD.HMS · 10px ENTERPRISE · 0.18em tracking
 *   ≥768px  → 40px logo · 16px MOHD.HMS (text-base, as before)
 *
 * The company name is always visible (never `hidden`, never truncated);
 * whitespace-nowrap only prevents mid-name wrapping under squeeze.
 * MOHD.HMS uses the brand green (text-primary) matching the login/welcome
 * screens; ENTERPRISE stays neutral gray. The official logo is untouched.
 */
function BrandLockup() {
  return (
    <>
      <Image
        src="/brand/logo-128.png"
        alt="MOHD HMS Enterprise logo"
        width={40}
        height={40}
        priority
        className="h-8 w-8 min-[360px]:h-9 min-[360px]:w-9 md:h-10 md:w-10 rounded-full"
      />
      <span className="block leading-none text-left whitespace-nowrap">
        <span className="block font-semibold text-[14px] min-[360px]:text-[17px] md:text-base tracking-tight text-primary">MOHD.HMS</span>
        <span className="block text-[9px] min-[360px]:text-[10px] uppercase tracking-[0.14em] min-[360px]:tracking-[0.18em] text-muted-foreground">Enterprise</span>
      </span>
    </>
  );
}

/**
 * Online presence indicator — the header's PRIMARY status (replaces the old
 * technical "Reconnecting…" pill).
 *
 * The number is the backend-authoritative ONLINE USER COUNT pushed by the
 * realtime service's presence manager over the EXISTING socket
 * (`presence:count` — unique authenticated users, deduplicated across
 * tabs/devices server-side; never raw sockets, never a frontend computation,
 * never a hardcoded value). No second WebSocket, no polling.
 *
 * State model (spec §12/§13/§27):
 *   healthy     ● N Online           (green — live count)
 *   recovering  ● N Online           (count kept, dot pulses — brief reconnect;
 *                                     the header is not dominated by diagnostics)
 *   loading     … Online             (no count yet — skeleton, not "0")
 *   unavailable ⚠ Online unavailable (channel dead — the stale count is
 *                                     WITHDRAWN; "unavailable" ≠ "0 online")
 *
 * Clicking opens the existing dropdown: staff receive the live online-user
 * list (server-scoped `presence:list` RPC + `presence:update` push — staff
 * room only, safe fields only: name/role/online), customers get the count
 * summary. One canonical presence source for header AND Realtime dashboard.
 */
type PresenceRow = {
  userId: string; name: string; role: string;
  sockets: number; since: number; lastSeenAt?: number;
};

function OnlinePresenceIndicator() {
  const { user } = useSession();
  const [state, setState] = useState<RealtimeState>("CONNECTING");
  const [count, setCount] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<PresenceRow[] | null>(null);

  useEffect(() => onRealtimeState(setState), []);
  useEffect(() => onRealtimePresenceCount(setCount), []);

  const isStaff = user?.role !== "CUSTOMER";
  const dead = state === "FAILED" || state === "DISCONNECTED";
  const showCount = count !== null && !dead; // a stale count is never shown as current
  const loading = !showCount && !dead; // connecting / awaiting first count

  // Live dropdown list (staff only — the server enforces that room scope):
  // initial snapshot via the request/response RPC, then kept fresh by the
  // staff-scoped push while the dropdown stays open. Both carry the same
  // safe fields (name, role, online) — no emails, tokens or session ids.
  // "Unavailable" is DERIVED from the connection state (never set in-effect).
  const listDead = open && isStaff && state !== "CONNECTED";
  useEffect(() => {
    if (!open || !isStaff) return;
    const socket = getRealtimeSocket();
    if (!socket || !socket.connected) return;
    const apply = (p: { presence?: PresenceRow[] }) => {
      setList(Array.isArray(p?.presence) ? [...p.presence].sort((a, b) => a.name.localeCompare(b.name)) : []);
    };
    socket.on("presence:list", apply);
    socket.on("presence:update", apply);
    socket.emit("presence:list");
    return () => { socket.off("presence:list", apply); socket.off("presence:update", apply); };
  }, [open, isStaff]);

  const summary = `${count ?? 0} user${count === 1 ? "" : "s"} currently online`;
  const pillTone = showCount
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-400"
    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400";
  const dotTone = showCount
    ? (state === "CONNECTED" ? "bg-emerald-500" : "bg-amber-500 animate-pulse")
    : "bg-amber-500 animate-pulse";
  const tooltip =
    dead ? "Realtime connection unavailable — online status cannot be verified right now"
    : !showCount ? "Connecting to realtime presence…"
    : state === "CONNECTED" ? `${summary} — live from the realtime presence service`
    : `Reconnecting — showing the last known count, which may be briefly outdated`;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="header-online-pill"
              aria-label="Online users — live presence"
              className={cn(
                "inline-flex items-center gap-1.5 h-9 px-2 min-[400px]:px-2.5 rounded-full border text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                pillTone,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotTone)} aria-hidden />
              {showCount ? (
                <span className="contents" role="status" aria-live="polite">
                  <span className="tabular-nums" data-testid="header-online-count">{count}</span>
                  <span className="hidden sm:inline">Online</span>
                  <span className="sr-only">users currently online</span>
                </span>
              ) : loading ? (
                <span className="contents" role="status" aria-live="polite">
                  <span aria-hidden>…</span>
                  <span className="hidden sm:inline">Online</span>
                  <span className="sr-only">Checking online status</span>
                </span>
              ) : (
                <span className="contents" role="status" aria-live="polite">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  <span className="hidden sm:inline">Online unavailable</span>
                  <span className="sr-only">Online status unavailable</span>
                </span>
              )}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-64 p-0" data-testid="header-online-dropdown">
        {isStaff ? (
          <div>
            <div className="flex items-center justify-between px-3 py-2.5 border-b">
              <span className="text-sm font-medium">Online users</span>
              <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden /> Live
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto hms-scroll">
              {listDead ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">Online status unavailable</div>
              ) : list === null ? (
                <div className="flex items-center justify-center gap-2 px-4 py-8 text-center text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading presence…
                </div>
              ) : list.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">No users currently online</div>
              ) : (
                list.map((p) => (
                  <div key={p.userId} className="flex items-center gap-2.5 px-3 py-2 border-b last:border-0">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-label="online" />
                    <span className="h-7 w-7 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center shrink-0" aria-hidden>
                      {initials(p.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium truncate">
                        {p.name}
                        {p.userId === user?.id ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">{humanize(p.role)}</span>
                    </span>
                    {/* Multiple sockets of the SAME user never inflate the count —
                        they only surface here, on the detailed staff list. */}
                    {p.sockets > 1 ? (
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">{p.sockets} devices</Badge>
                    ) : null}
                  </div>
                ))
              )}
            </div>
            <div className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="header-online-summary">
              {showCount ? summary : "Online status unavailable"}
            </div>
          </div>
        ) : (
          <div className="px-4 py-4 text-center text-sm text-muted-foreground" data-testid="header-online-summary">
            {showCount ? summary : "Online status unavailable"}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
        <Button variant="ghost" size="icon" className="relative rounded-full h-10 w-10 sm:h-9 sm:w-9" aria-label={`Notifications (${unread} unread)`}>
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
        <Button variant="ghost" aria-label="Profile" className="rounded-full pl-1 pr-1.5 sm:pr-2.5 gap-2 h-10 sm:h-9">
          <UserAvatar url={user.avatarUrl} name={user.name} className="h-9 w-9 text-xs shrink-0" />
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
        {/* My Profile — EVERY authenticated user (spec §31): view + edit own
            details; identity fields are managed by SUPER_ADMIN (backend). */}
        <DropdownMenuItem onClick={() => navigateTo("profile")}>
          <CircleUserRound className="h-4 w-4 mr-2" aria-hidden /> My Profile
        </DropdownMenuItem>
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
