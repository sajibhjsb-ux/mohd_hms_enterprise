"use client";

// MOHD.HMS ENTERPRISE — Realtime provider (mounts the socket for the session).
// One connection per authenticated browser; torn down on sign-out. Renders
// nothing — the connection state surfaces via the header indicator (STEP 24).

import { useEffect } from "react";
import { useSession } from "@/components/hms/session";
import { connectRealtime, disconnectRealtime } from "@/lib/hms/realtime/socket";

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();

  useEffect(() => {
    if (!user) return;
    connectRealtime();
    return () => {
      // Only disconnect when the session really goes away (sign-out),
      // not on every re-render — the effect deps are the user id.
      disconnectRealtime();
    };
  }, [user?.id]);

  return <>{children}</>;
}
