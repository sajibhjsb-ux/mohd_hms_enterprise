"use client";

// Client session context: holds the authenticated user + permissions.
// Renewal is silent (background heartbeat) — the app NEVER reloads mid-work.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/hms/api-client";
import { clearLastRoute } from "@/lib/hms/pwa";
import { markWelcomePending } from "@/lib/hms/welcome";
import type { Permission } from "@/lib/hms/constants";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
  customerId: string | null;
  permissions: Permission[];
  /** Backend-authoritative derived profile state (customers). */
  profileComplete?: boolean;
  missingFields?: string[];
  /** Object-storage key of the profile photo (served via authenticated API). */
  avatarUrl?: string | null;
  /** Backend-authoritative Terms & Conditions acceptance state (see
   *  lib/hms/legal/legal.ts). Present on session/login/verify payloads. */
  terms?: {
    version: string | null;
    effectiveDate: string | null;
    publishedAt: string | null;
    changeSummary: string | null;
    acceptedVersion: string | null;
    requiresAcceptance: boolean;
  };
};

type SessionCtx = {
  user: SessionUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Server-configured idle timeout (seconds; 300 in production). The
   *  IdleSessionGuard builds its warning/UX timers from this — no client-side
   *  hardcoding of the timeout value anywhere. */
  idleTimeoutSeconds: number | null;
};

const Ctx = createContext<SessionCtx>({
  user: null, loading: true, refresh: async () => {}, signIn: async () => {}, signOut: async () => {}, idleTimeoutSeconds: null,
});

/** sessionStorage key for the post-expiry login banner (set before the
 *  redirect, consumed + cleared once by the auth flow). */
export const SESSION_EXPIRED_NOTICE_KEY = "hms_session_expired_notice";

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [idleTimeoutSeconds, setIdleTimeoutSeconds] = useState<number | null>(null);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ authenticated: boolean; user?: SessionUser; idleTimeoutSeconds?: number }>("/api/v1/auth/session");
      setUser(res.data.authenticated && res.data.user ? res.data.user : null);
      if (res.data.idleTimeoutSeconds) setIdleTimeoutSeconds(res.data.idleTimeoutSeconds);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Central SESSION_EXPIRED interception (§10/§17): the api-client dispatches
  // this once for any 401 SESSION_EXPIRED; every component shares this single
  // cleanup — clear auth state, clear the persisted launch route, and go to
  // the login screen with the inactivity notice. A full navigation also tears
  // down the WebSocket, polls and all authenticated state in one move.
  useEffect(() => {
    const onExpired = () => {
      try { sessionStorage.setItem(SESSION_EXPIRED_NOTICE_KEY, "1"); } catch { /* best effort */ }
      clearLastRoute();
      setUser(null);
      if (window.location.pathname !== "/") window.location.assign("/?auth=login");
    };
    window.addEventListener("hms:session-expired", onExpired);
    return () => window.removeEventListener("hms:session-expired", onExpired);
  }, []);

  // Silent heartbeat: renews sliding session, keeps work alive. No reloads, ever.
  useEffect(() => {
    if (!user) {
      if (beatRef.current) clearInterval(beatRef.current);
      return;
    }
    beatRef.current = setInterval(async () => {
      try {
        const res = await api.get<{ authenticated: boolean; user?: SessionUser }>("/api/v1/auth/session");
        if (!res.data.authenticated) setUser(null);
        else if (res.data.user) setUser(res.data.user); // silent permission refresh
      } catch { /* transient network issue — session kept */ }
    }, 4 * 60 * 1000);
    return () => { if (beatRef.current) clearInterval(beatRef.current); };
  }, [user?.id]);  

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.post<SessionUser>("/api/v1/auth/login", { email, password });
    // A fresh sign-in is NOT a session restoration: drop any route persisted by
    // the previous session so the role-based post-login landing applies.
    clearLastRoute();
    // Real-login signal for the post-login welcome popup (spec §8): only a
    // genuine credential sign-in marks it — refresh/restore never does.
    markWelcomePending();
    setUser(res.data);
    // Push lifecycle (spec §34): if THIS browser was already granted
    // notification permission, silently re-bind its FCM installation to the
    // freshly authenticated user. Never prompts (no context-free permission
    // request) and never blocks login.
    void import("@/lib/hms/push-client").then((m) => m.syncPushOnLogin()).catch(() => undefined);
  }, []);

  const signOut = useCallback(async () => {
    // Push lifecycle (spec §34): unregister THIS browser's FCM installation so
    // the outgoing user's push identity never leaks into the next session on
    // this device. Other devices of the user are untouched; legacy VAPID
    // subscriptions keep the existing owner-binding policy (re-bound on next
    // enable by whoever logs in here).
    void import("@/lib/hms/push-client").then((m) => m.disableFcm()).catch(() => undefined);
    await api.post("/api/v1/auth/logout").catch(() => undefined);
    clearLastRoute();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, refresh, signIn, signOut, idleTimeoutSeconds }}>{children}</Ctx.Provider>;
}

/** True when the current page load came through an idle-session expiry
 *  (consumed by the auth flow to show the exact expired message once). */
export function consumeSessionExpiredFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (sessionStorage.getItem(SESSION_EXPIRED_NOTICE_KEY) === "1") {
      sessionStorage.removeItem(SESSION_EXPIRED_NOTICE_KEY);
      return true;
    }
  } catch { /* best effort */ }
  return false;
}

export function hasPerm(user: SessionUser | null, perm: Permission): boolean {
  return !!user && user.permissions.includes(perm);
}
