"use client";

// MOHD.HMS ENTERPRISE — standalone public legal page (logged-out visitors).
// The Gate renders this for /terms and /privacy when there is no session, so
// the legal links on the auth screens, in emails and on documents work without
// signing in. Brand-consistent minimal chrome: logo bar, document, mini footer.

import Image from "next/image";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LegalPageView } from "./legal-page-view";
import type { LegalKind } from "@/lib/hms/legal/types";

export function PublicLegalView({ kind }: { kind: LegalKind }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar */}
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <a href="/" className="flex items-center gap-2.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="MOHD.HMS Enterprise home">
            <Image
              src="/brand/logo-128.png"
              alt="MOHD.HMS Enterprise logo"
              width={36}
              height={36}
              className="h-9 w-9 rounded-full ring-1 ring-border/40"
              priority
            />
            <span className="text-sm font-semibold tracking-tight">
              <span className="text-primary">MOHD.HMS</span> Enterprise
            </span>
          </a>
          <Button asChild variant="outline" size="sm" className="h-9">
            <a href="/">
              <LogIn className="h-4 w-4" aria-hidden />
              Return to sign in
            </a>
          </Button>
        </div>
      </header>

      {/* Document */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6" id="main-content">
        <LegalPageView kind={kind} />
      </main>

      {/* Mini footer */}
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-1.5 px-4 py-3.5 text-xs text-muted-foreground sm:flex-row sm:px-6">
          <span>© {new Date().getFullYear()} MOHD.HMS Enterprise — Smart Facility Maintenance Management</span>
          <div className="flex items-center gap-4">
            <a href="/terms" className="underline-offset-4 hover:underline hover:text-foreground">Terms &amp; Conditions</a>
            <a href="/privacy" className="underline-offset-4 hover:underline hover:text-foreground">Privacy Policy</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
