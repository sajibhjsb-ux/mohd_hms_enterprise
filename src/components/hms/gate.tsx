"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useSession } from "./session";
import { AppShell } from "./shell";
import { LoginScreen } from "./login-screen";
import { PublicLegalView } from "./legal/public-legal-view";
import type { LegalKind } from "@/lib/hms/legal/types";

/** Public legal paths served to logged-out visitors (Terms & Conditions /
 *  Privacy Policy). The links appear on the auth screens, in the app footer,
 *  on documents and in the consent gate, so they must work without a session. */
function legalKindFromPath(pathname: string): LegalKind | null {
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/terms") return "TERMS";
  if (clean === "/privacy") return "PRIVACY";
  return null;
}

export function Gate() {
  const { user, loading } = useSession();
  // Tracked via effect (not a state initializer) so the server-rendered splash
  // and the first client render match — no hydration mismatch.
  const [legalKind, setLegalKind] = useState<LegalKind | null>(null);

  useEffect(() => {
    const compute = () => setLegalKind(legalKindFromPath(window.location.pathname));
    compute();
    window.addEventListener("popstate", compute);
    return () => window.removeEventListener("popstate", compute);
  }, []);

  if (loading) {
    return (
      // Splash container: full dynamic viewport height (splash-viewport helper in
      // globals.css: 100dvh with 100vh fallback for older browsers) + safe-area
      // padding so the logo can never sit under a notch, camera cutout or system
      // navigation area in standalone/PWA mode.
      <div className="splash-viewport flex items-center justify-center pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <div className="flex flex-col items-center gap-4">
          {/* Official brand logo (same asset family as login/header/PWA icons).
              Fluid responsive sizing: clamp(96px, 25vmin, 240px) — vmin is
              min(viewport width, height), so the logo scales with whichever
              dimension is limiting (width in portrait, height in landscape)
              across phone → tablet → desktop → 4K without ever dominating or
              disappearing. Width-only sizing + intrinsic 1:1 source preserve
              the aspect ratio (never stretched or cropped). The 512px official
              asset stays sharp up to the 240px cap even at 2x DPR, and is
              precached by the service worker so offline PWA boots still show it. */}
          <Image
            src="/brand/logo-512.png"
            alt="MOHD HMS Enterprise logo"
            width={512}
            height={512}
            priority
            unoptimized
            className="h-auto w-[clamp(6rem,25vmin,15rem)] max-w-full rounded-full object-contain ring-1 ring-border/40 shadow-sm animate-pulse motion-reduce:animate-none"
          />
          <p role="status" className="text-sm text-muted-foreground">Loading MOHD.HMS Enterprise…</p>
        </div>
      </div>
    );
  }
  // Public legal pages: logged-out visitors get the standalone document;
  // authenticated users get the in-app module via the shell (same canonical
  // document either way).
  if (legalKind) {
    return user ? <AppShell /> : <PublicLegalView kind={legalKind} />;
  }
  return user ? <AppShell /> : <LoginScreen />;
}
