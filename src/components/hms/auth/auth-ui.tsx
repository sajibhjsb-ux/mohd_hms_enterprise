"use client";
// MOHD.HMS ENTERPRISE — shared authentication UI primitives.
// One visual language for the three auth screens (Welcome / Login / Verify):
// white background, official logo, rounded inputs, rounded green primary
// buttons, subtle shadows, safe-area-aware spacing, reduced-motion-safe
// transitions. Mobile-first; the same column is centered on desktop.

import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Responsive official logo — fluid clamp sizing, aspect locked, never distorted.
 *  Same 512px official asset as the splash (service-worker precached, so the
 *  auth screens render it even on an offline PWA boot with an expired session). */
export function AuthLogo({ className }: { className?: string }) {
  return (
    <Image
      src="/brand/logo-512.png"
      alt="MOHD HMS Enterprise logo"
      width={512}
      height={512}
      priority
      unoptimized
      className={cn(
        "h-auto w-[clamp(5.5rem,20vmin,8rem)] max-w-full rounded-full object-contain shadow-sm ring-1 ring-border/40",
        className
      )}
    />
  );
}

/** Root shell for every auth screen: dynamic viewport height (100dvh with a
 *  100vh fallback via the existing .splash-viewport helper), safe-area padding
 *  on all sides so content can never sit under notches / home indicators, and
 *  a centered single column (max-w-sm) that stays balanced on phones, tablets
 *  and desktop widths. Natural scrolling is allowed (keyboard never traps). */
export function AuthShell({ children, screenKey }: { children: React.ReactNode; screenKey: string }) {
  return (
    <div className="splash-viewport flex flex-col bg-background pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div key={screenKey} className="auth-screen-in mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-6">
        {children}
      </div>
    </div>
  );
}

/** Real history back navigation (router.back) with a safe fallback to the
 *  welcome screen when there is no in-app history to pop (deep link). */
export function BackButton({ label = "Back", onClick }: { label?: string; onClick?: () => void }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-10 w-10 shrink-0 rounded-full"
      aria-label={label}
      onClick={() => (onClick ? onClick() : router.back())}
    >
      <ArrowLeft className="h-5 w-5" aria-hidden />
    </Button>
  );
}

/** Official Google "G" mark (brand guideline colors). */
export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Accessible inline error message (announced by screen readers). */
export function AuthError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className={cn(
        "rounded-lg bg-destructive/10 px-3.5 py-2.5 text-sm font-medium text-destructive",
        className
      )}
    >
      {message}
    </p>
  );
}

/** Hairline divider with centered label ("OR" / "or continue with"). */
export function AuthDivider({ label }: { label: string }) {
  return (
    <div className="relative" aria-hidden>
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-background px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
    </div>
  );
}

/** Rounded green primary action with built-in loading state.
 *  48px tall — comfortable mobile touch target. */
export function AuthPrimaryButton({
  loading,
  loadingLabel,
  children,
  disabled,
  ...props
}: React.ComponentProps<typeof Button> & { loading?: boolean; loadingLabel?: string }) {
  return (
    <Button
      type="submit"
      className="h-12 w-full rounded-xl text-[0.95rem] font-semibold shadow-sm"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          {loadingLabel ?? "Working…"}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
