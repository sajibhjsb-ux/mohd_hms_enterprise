"use client";

// Client session context: holds the authenticated user + permissions.
// Renewal is silent (background heartbeat) — the app NEVER reloads mid-work.
//
// SINGLE ACTIVE DEVICE (client side, §11): the backend stays authoritative —
// a superseded device's very next API call answers 401 SESSION_REVOKED and
// the central interceptor below logs it out. When the device is online its
// WebSocket also delivers the SESSION_REVOKED event instantly (same event
// channel as everything else — no second connection, no polling): the
// handler re-verifies against the server and logs out only on a definitive
// revocation, so the NEW device (same user room) is never affected.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/hms/api-client";
import { clearLastRoute } from "@/lib/hms/pwa";
import { markWelcomePending } from "@/lib/hms/welcome";
import { onRealtimeEvents } from "@/lib/hms/realtime/bus";
import { RT } from "@/lib/hms/realtime/matrix";
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
};

const Ctx = createContext<SessionCtx>({
  user: null, loading: true, refresh: async () => {}, signIn: async () => {}, signOut: async () => {},
});

/** sessionStorage key for the post-logout login banner (set before the
 *  redirect, consumed + cleared once by the auth flow). The value IS the
 *  message so each logout reason can speak for itself (§26). */
export const SESSION_END_NOTICE_KEY = "hms_session_end_notice";
/** §26: the exact user-facing wording for a single-active-device revocation. */
export const SESSION_REVOKED_MESSAGE =
  "Your account was signed in on another device, so this session has been logged out.";

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ authenticated: boolean; user?: SessionUser }>("/api/v1/auth/session");
      if (res.data.authenticated && res.data.user) {
        setUser(res.data.user);
      } else {
        setUser(null);
        // USER-CONTROLLED AUTO LOGIN: the session cookie itself IS the
        // persistent credential — a remember-grant session simply stays
        // valid (no inactivity expiry exists), so no separate restoration
        // step is needed. Revoked/expired/destroyed grants fail above and
        // the login flow renders; nothing is ever silently restored.
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Central session-security interception (§11): the api-client dispatches
  // this once for any 401 SESSION_REVOKED / SESSION_EXPIRED; every component
  // shares this single cleanup — record the reason for the login banner,
  // clear auth state + the persisted launch route, and go to the login
  // screen. A full navigation also tears down the WebSocket, polls and all
  // authenticated state in one move.
  useEffect(() => {
    const onExpired = (ev: Event) => {
      const code = (ev as CustomEvent<{ code?: string }>).detail?.code;
      const message = code === "SESSION_REVOKED" ? SESSION_REVOKED_MESSAGE : "Your session has ended. Please log in again.";
      try { sessionStorage.setItem(SESSION_END_NOTICE_KEY, message); } catch { /* best effort */ }
      clearLastRoute();
      setUser(null);
      if (window.location.pathname !== "/") window.location.assign("/?auth=login");
    };
    window.addEventListener("hms:session-expired", onExpired);
    return () => window.removeEventListener("hms:session-expired", onExpired);
  }, []);

  // Realtime revocation (§8): the login on ANOTHER device emits
  // SESSION_REVOKED to this account's socket room. Re-verify with the
  // server (authoritative) — a superseded device gets 401 SESSION_REVOKED
  // here (the central interceptor above then performs the logout with the
  // banner), while the NEW device verifies fine and stays untouched. Uses
  // the raw bus subscription deliberately: a session revocation must NEVER
  // be suppressed by the dirty-form guard.
  const userRef = useRef<SessionUser | null>(null);
  userRef.current = user;
  useEffect(() => {
    return onRealtimeEvents([RT.SESSION_REVOKED], () => {
      if (!userRef.current) return;
      // Server-authoritative re-verification: a DEFINITIVE "not
      // authenticated" (or a 401 SESSION_REVOKED from a protected call — the
      // interceptor above) logs this device out with the banner. An ambiguous
      // network error never logs out — the heartbeat and the next API call
      // re-verify anyway.
      api.get<{ authenticated: boolean }>("/api/v1/auth/session").then((res) => {
        if (!res.data.authenticated) {
          try { sessionStorage.setItem(SESSION_END_NOTICE_KEY, SESSION_REVOKED_MESSAGE); } catch { /* best effort */ }
          clearLastRoute();
          setUser(null);
          if (window.location.pathname !== "/") window.location.assign("/?auth=login");
        }
      }).catch(() => undefined);
    });
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

  return <Ctx.Provider value={{ user, loading, refresh, signIn, signOut }}>{children}</Ctx.Provider>;
}

/** The one-shot logout-reason banner for the auth flow (§26): returns and
 *  clears the stored message — e.g. the single-active-device revocation
 *  notice — or null when this is a plain login. */
export function consumeSessionEndNotice(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const message = sessionStorage.getItem(SESSION_END_NOTICE_KEY);
    if (message) sessionStorage.removeItem(SESSION_END_NOTICE_KEY);
    return message;
  } catch { /* best effort */ }
  return null;
}

export function hasPerm(user: SessionUser | null, perm: Permission): boolean {
  return !!user && user.permissions.includes(perm);
}
