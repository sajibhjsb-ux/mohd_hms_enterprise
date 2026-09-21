"use client";

// MOHD.HMS ENTERPRISE — post-login welcome popup.
//
// A professional, branded welcome notification shown ONCE after a REAL login
// (never on refresh / navigation / session restore — see lib/hms/welcome.ts
// for the single real-login signal this component consumes).
//
// Design rules (spec §3/§4): existing MOHD.HMS branding only — the official
// logo via the existing asset architecture (next/image + /brand asset family),
// the existing green primary, design tokens, border radius, shadows and the
// shared shadcn Dialog primitive (identical overlay/ESC/focus behavior to
// every other dialog in the app). One subtle entrance animation; no marketing
// styling, no heavy animation libraries (spec §4/§13).
//
// Non-blocking (spec §5): Continue button, close icon, ESC and outside-click
// all dismiss (Radix defaults — consistent with existing dialogs). The dialog
// uses the ALREADY-LOADED session user — zero extra API requests (spec §13).

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Moon, Sunrise, Sun, Sunset } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSession } from "@/components/hms/session";
import { humanize } from "@/lib/hms/constants";
import { buildWelcomeContent, takeWelcomePending, type WelcomePeriod } from "@/lib/hms/welcome";

/** Small period icon (spec §4 "optional small icon") — subtle, decorative. */
const PERIOD_ICONS: Record<WelcomePeriod, typeof Sunrise> = {
  morning: Sunrise,
  afternoon: Sun,
  evening: Sunset,
  night: Moon,
};

export function WelcomeDialog() {
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<{ period: WelcomePeriod; greeting: string; message: string } | null>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  // Mount-only: consume the single real-login signal. The flag is taken
  // exactly once per login event, so re-renders, auth-state updates, route
  // changes, heartbeats, token refreshes, PWA resume or StrictMode
  // double-invocation can never duplicate the popup (spec §7). Runs off the
  // synchronous effect path via rAF (React 19 set-state-in-effect rule) —
  // which also lets the shell + route effects settle first: route ready,
  // THEN the welcome popup fades in (spec §6 sequence).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (user && takeWelcomePending()) {
        setContent(buildWelcomeContent(user));
        setOpen(true);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Nothing to render until a real login is consumed — zero rendering cost.
  if (!content) return null;

  const Icon = PERIOD_ICONS[content.period];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setContent(null); // release content once dismissed
      }}
    >
      <DialogContent
        className="sm:max-w-md text-center gap-5"
        onOpenAutoFocus={(e) => {
          // Keyboard entry point = the primary action (spec §12): Enter
          // immediately continues, focus is visible and never trapped wrong.
          e.preventDefault();
          continueRef.current?.focus();
        }}
      >
        <DialogHeader className="items-center gap-4">
          {/* Official company logo — same asset family as the splash/login/
              header/about surfaces (public/brand), rendered via next/image. */}
          <div className="relative mx-auto flex h-24 w-24 items-center justify-center" aria-hidden>
            {/* Soft brand-green halo — matches the shell's radial accents */}
            <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle,oklch(0.85_0.13_155/0.35),transparent_70%)] dark:bg-[radial-gradient(circle,oklch(0.8_0.14_155/0.2),transparent_70%)]" />
            <Image
              src="/brand/logo-128.png"
              alt=""
              width={128}
              height={128}
              className="relative h-20 w-20 rounded-full object-contain ring-1 ring-border/40 shadow-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-300 motion-reduce:animate-none"
            />
          </div>
          <div className="flex items-center justify-center gap-1.5">
            <Icon className="h-4 w-4 text-primary" aria-hidden />
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
              {humanize(content.period)} · {humanize(user?.role ?? "")}
            </span>
          </div>
          {/* Screen-reader title = the time-based greeting with the user's
              actual name (spec §1/§2/§12). */}
          <DialogTitle className="text-center text-xl leading-snug">
            {content.greeting}
          </DialogTitle>
          <DialogDescription className="mx-auto max-w-xs text-center text-sm leading-relaxed">
            {content.message}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <Button
            ref={continueRef}
            onClick={() => setOpen(false)}
            className="w-full sm:w-auto sm:min-w-40"
            aria-label="Continue to the application"
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
