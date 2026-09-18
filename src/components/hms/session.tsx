"use client";

// Client session context: holds the authenticated user + permissions.
// Renewal is silent (background heartbeat) — the app NEVER reloads mid-work.

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/hms/api-client";
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
      setUser(res.data.authenticated && res.data.user ? res.data.user : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

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
    setUser(res.data);
  }, []);

  const signOut = useCallback(async () => {
    await api.post("/api/v1/auth/logout").catch(() => undefined);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, refresh, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function hasPerm(user: SessionUser | null, perm: Permission): boolean {
  return !!user && user.permissions.includes(perm);
}
