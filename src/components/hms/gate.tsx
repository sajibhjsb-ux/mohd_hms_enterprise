"use client";

import { useSession } from "./session";
import { AppShell } from "./shell";
import { LoginScreen } from "./login-screen";

export function Gate() {
  const { user, loading } = useSession();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg animate-pulse">H</div>
          <p className="text-sm text-muted-foreground">Loading MOHD.HMS Enterprise…</p>
        </div>
      </div>
    );
  }
  return user ? <AppShell /> : <LoginScreen />;
}
