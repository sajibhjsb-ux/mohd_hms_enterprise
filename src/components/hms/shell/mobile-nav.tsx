"use client";

// MOHD.HMS ENTERPRISE — mobile floating bottom navigation (mobile only, <lg).
//
// Fixed five-slot CSS grid so the layout is mathematically centered on every
// supported width:
//
//   [ Dashboard ] [ Complaints ]  [ QR SCAN ]  [ Invoices ] [ More ]
//
// • The CENTER slot is always the QR Scanner — a large elevated circular green
//   action that opens the dedicated /scan camera scanner page (the app's single
//   scanner: live camera + the existing QR routing; the header QR dialog stays
//   as the manual-entry fallback).
// • Slots 1/2/4 resolve from the RBAC-filtered module list with deterministic
//   fallback chains, so unauthorized modules are never shown and every role
//   keeps the same 5-slot geometry (backend authorization stays authoritative).
// • "More" opens the existing bottom-sheet pattern listing every module the
//   signed-in user may access.
// • Alignment policy: grid slots only — no margins/offsets/transforms to force
//   positioning (the QR rise is a fixed negative top margin on its own slot).
// • The component publishes its occupied height (bar + safe-area + QR rise +
//   gap) as the --hms-mobile-nav-h CSS variable so the shell reserves exact
//   content space — nothing hides behind the navigation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal, QrCode } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { type ModuleDef } from "@/components/hms/registry";
import { cn } from "@/lib/utils";

type Props = {
  /** RBAC-filtered, nav-visible modules (from the shell). */
  modules: ModuleDef[];
  activeModule: string;
  onSelect: (key: string) => void;
  /** Opens the dedicated /scan camera scanner page. */
  onOpenScanner: () => void;
};

/** Deterministic fallback chains for the two module slots (first match wins). */
const SLOT2_PREFERRED = [
  "complaints", "work-orders", "equipment", "pm", "customers", "users", "employees",
  "technicians", "inventory", "purchases", "quotations", "irms", "vehicles",
  "reports", "audit", "settings", "finance", "hr",
] as const;

const SLOT4_PREFERRED = [
  "invoices", "finance", "quotations", "reports", "purchases", "work-orders",
  "inventory", "equipment", "pm", "irms", "customers", "vehicles", "employees",
  "technicians", "users", "hr", "audit", "settings",
] as const;

/** How far the QR button rises above the bar + breathing gap under the bar. */
const QR_RISE_PX = 28;
const BOTTOM_GAP_PX = 10;

function pickSlot(preferred: ReadonlyArray<string>, used: Set<string>, byKey: Map<string, ModuleDef>): ModuleDef | null {
  for (const key of preferred) {
    if (!used.has(key) && byKey.has(key)) return byKey.get(key)!;
  }
  // Edge case: a role whose module set matches none of the preferred chains —
  // fall back to any unused module so the 5-slot geometry is preserved.
  for (const m of byKey.values()) {
    if (!used.has(m.key)) return m;
  }
  return null;
}

export function MobileNav({ modules, activeModule, onSelect, onOpenScanner }: Props) {
  const [moreOpen, setMoreOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Slot resolution — centralized here (single source for the mobile layout).
  const { slot1, slot2, slot4 } = useMemo(() => {
    const byKey = new Map(modules.map((m) => [m.key, m]));
    const first = byKey.get("dashboard") ?? modules[0] ?? null;
    const used1 = new Set(first ? [first.key] : []);
    const second = pickSlot(SLOT2_PREFERRED, used1, byKey);
    const used2 = new Set([...used1, ...(second ? [second.key] : [])]);
    const fourth = pickSlot(SLOT4_PREFERRED, used2, byKey);
    return { slot1: first, slot2: second, slot4: fourth };
  }, [modules]);

  // More-menu grouping — the communication pair (Email / WhatsApp, RBAC-filtered
  // upstream) gets its own section at the top; every other module keeps the
  // existing grid below. Roles without communication permissions see the sheet
  // exactly as before (no empty group, no layout change).

  // Publish the exact occupied height (bar + safe-area + QR rise + gap) so the
  // shell can reserve matching content space. Measured — never hardcoded.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => {
      if (window.matchMedia("(min-width: 1024px)").matches || el.offsetHeight === 0) {
        root.style.removeProperty("--hms-mobile-nav-h");
        return;
      }
      root.style.setProperty("--hms-mobile-nav-h", `${el.offsetHeight + QR_RISE_PX + BOTTOM_GAP_PX}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty("--hms-mobile-nav-h");
    };
  }, []);

  const { communication, others } = useMemo(() => {
    const comm = modules.filter((m) => m.key === "email" || m.key === "whatsapp");
    const commKeys = new Set(comm.map((m) => m.key));
    return { communication: comm, others: modules.filter((m) => !commKeys.has(m.key)) };
  }, [modules]);

  const selectAndClose = useCallback(
    (key: string) => {
      onSelect(key);
      setMoreOpen(false);
    },
    [onSelect]
  );

  return (
    <nav
      aria-label="Mobile navigation"
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 no-print pointer-events-none"
      data-testid="mobile-nav"
    >
      {/* Floating capsule — safe-area aware, centered, max width for tablets */}
      <div
        ref={wrapRef}
        className="pointer-events-auto mx-auto w-full max-w-[30rem] px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]"
      >
        <div className="grid h-16 grid-cols-5 rounded-[1.65rem] border border-border/60 bg-background/95 shadow-[0_12px_32px_-14px_rgb(0_0_0/0.3)] backdrop-blur-xl">
          <NavSlot module={slot1} active={!!slot1 && activeModule === slot1.key} onSelect={onSelect} />
          <NavSlot module={slot2} active={!!slot2 && activeModule === slot2.key} onSelect={onSelect} />

          {/* Center slot — QR Scanner primary action (exact middle of the grid) */}
          <div className="relative flex flex-col items-center">
            <button
              type="button"
              onClick={onOpenScanner}
              aria-label="Scan QR code"
              className="-mt-7 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_10px_24px_-6px_oklch(0.53_0.14_154/0.55)] ring-4 ring-background outline-none transition-[background-color,box-shadow,transform] hover:bg-primary/90 focus-visible:ring-4 focus-visible:ring-ring active:scale-[0.97]"
              data-testid="mobile-qr-button"
            >
              <QrCode className="h-7 w-7" aria-hidden />
            </button>
            <span className="mt-1 text-[10px] leading-none font-medium text-muted-foreground">Scan</span>
          </div>

          <NavSlot module={slot4} active={!!slot4 && activeModule === slot4.key} onSelect={onSelect} />

          {/* More — three-dot, opens the existing bottom-sheet module list */}
          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="More"
                aria-expanded={moreOpen}
                className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-[1.4rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="flex h-6 w-10 items-center justify-center rounded-full" aria-hidden>
                  <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
                </span>
                <span className="text-[10px] leading-none font-medium text-muted-foreground">More</span>
              </button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-t-3xl">
              <SheetHeader>
                <SheetTitle>All modules</SheetTitle>
              </SheetHeader>
              <div className="max-h-[56vh] space-y-4 overflow-y-auto hms-scroll pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
                {/* Communication group — Email + WhatsApp (only for roles the
                    RBAC filter grants them; hidden entirely otherwise) */}
                {communication.length > 0 ? (
                  <section aria-label="Communication">
                    <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Communication
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                      {communication.map((m) => (
                        <MoreItem key={m.key} module={m} active={activeModule === m.key} onSelect={selectAndClose} />
                      ))}
                    </div>
                  </section>
                ) : null}
                <section aria-label="All modules">
                  {communication.length > 0 ? (
                    <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Modules
                    </h3>
                  ) : null}
                  <div className="grid grid-cols-3 gap-2">
                    {others.map((m) => (
                      <MoreItem key={m.key} module={m} active={activeModule === m.key} onSelect={selectAndClose} />
                    ))}
                  </div>
                </section>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  );
}

/**
 * One module tile inside the More bottom sheet (identical styling for the
 * Communication group and the general module grid).
 */
function MoreItem({ module, active, onSelect }: { module: ModuleDef; active: boolean; onSelect: (key: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(module.key)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-xl border p-3 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/5 text-primary"
          : "text-muted-foreground hover:bg-accent/60"
      )}
    >
      <module.icon className="h-5 w-5" aria-hidden />
      {module.shortLabel ?? module.label}
    </button>
  );
}

/** One grid slot for a module (or a quiet placeholder when a role has no match). */
function NavSlot({ module, active, onSelect }: { module: ModuleDef | null; active: boolean; onSelect: (key: string) => void }) {
  if (!module) {
    return (
      <span className="flex items-center justify-center" aria-hidden>
        <span className="h-1 w-1 rounded-full bg-border" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(module.key)}
      aria-current={active ? "page" : undefined}
      className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-[1.4rem] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span
        className={cn(
          "flex h-6 w-10 items-center justify-center rounded-full transition-colors",
          active && "bg-primary/10"
        )}
        aria-hidden
      >
        <module.icon className={cn("h-5 w-5", active ? "text-primary" : "text-muted-foreground")} />
      </span>
      <span className={cn("text-[10px] leading-none font-medium", active ? "text-primary" : "text-muted-foreground")}>
        {module.shortLabel ?? module.label}
      </span>
    </button>
  );
}
