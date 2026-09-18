"use client";

import Image from "next/image";
import { useSession } from "./session";
import { AppShell } from "./shell";
import { LoginScreen } from "./login-screen";

export function Gate() {
  const { user, loading } = useSession();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          {/* Official brand logo (same source as login/header/PWA) with loading pulse. */}
          <Image
            src="/brand/logo-128.png"
            alt="MOHD HMS Enterprise logo"
            width={64}
            height={64}
            priority
            className="h-14 w-14 rounded-full ring-1 ring-border/40 shadow-sm animate-pulse"
          />
          <p className="text-sm text-muted-foreground">Loading MOHD.HMS Enterprise…</p>
        </div>
      </div>
    );
  }
  return user ? <AppShell /> : <LoginScreen />;
}
