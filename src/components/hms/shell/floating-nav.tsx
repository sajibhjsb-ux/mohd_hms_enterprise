"use client";

// MOHD.HMS ENTERPRISE — desktop floating navigation (premium reference design).
// One authoritative nav source (MODULES registry, RBAC-filtered upstream).
// Measures real item widths; items that do not fit move into a "More" menu —
// never wraps, never overflows, single clean row.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MODULES, type ModuleDef } from "@/components/hms/registry";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

type Props = {
  visible: ModuleDef[];
  activeModule: string;
  onSelect: (key: string) => void;
};

const GAP = 4;          // gap-1 between items (px)
const MORE_RESERVE = 108; // approximate width reserved for the "More" control

export function FloatingNav({ visible, activeModule, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const widthsRef = useRef<Map<string, number>>(new Map());
  const [overflowFrom, setOverflowFrom] = useState<number>(visible.length);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const total = visible.length;

    // First pass: cache natural widths while everything is rendered.
    if (widthsRef.current.size !== total) {
      itemRefs.current.forEach((node, i) => {
        const m = visible[i];
        if (node && m) widthsRef.current.set(m.key, node.offsetWidth);
      });
    }

    const avail = el.clientWidth - 4; // container padding safety
    const fits = (reserve: number) => {
      let used = 0;
      let cut = total;
      for (let i = 0; i < total; i++) {
        const w = widthsRef.current.get(visible[i].key) ?? 0;
        used += w + (i > 0 ? GAP : 0);
        if (used > avail - reserve) { cut = i; break; }
      }
      return cut;
    };

    // Two-round computation: try without the More control, then with it reserved.
    let cut = fits(0);
    if (cut < total) cut = fits(MORE_RESERVE);
    setOverflowFrom(cut);
  }, [visible]);

  useLayoutEffect(() => {
    widthsRef.current.clear();
    // rAF keeps the initial measurement off the synchronous effect path
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    // Re-measure once webfonts finish loading (widths can shift slightly).
    if (document.fonts?.ready) document.fonts.ready.then(() => measure()).catch(() => undefined);
    return () => ro.disconnect();
  }, [measure]);

  const primary = visible.slice(0, overflowFrom);
  const overflow = visible.slice(overflowFrom);

  return (
    <div className="hidden lg:block sticky top-[72px] z-30 mt-3 px-4 sm:px-6 no-print" data-testid="floating-nav">
      <div
        ref={containerRef}
        className="mx-auto max-w-[1500px] h-16 rounded-3xl border border-border/60 bg-background/80 backdrop-blur-xl shadow-[0_12px_40px_-12px_rgb(0_0_0/0.14)] flex items-center gap-1 px-3 overflow-hidden"
        role="navigation"
        aria-label="Primary modules"
      >
        {primary.map((m, i) => {
          const active = activeModule === m.key;
          return (
            <button
              key={m.key}
              ref={(node) => { itemRefs.current[i] = node; }}
              onClick={() => onSelect(m.key)}
              aria-current={active ? "page" : undefined}
              title={m.label}
              className={cn(
                "flex items-center gap-2 rounded-xl px-3.5 h-11 text-sm font-medium whitespace-nowrap transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              <m.icon className={cn("h-5 w-5 shrink-0", active ? "text-primary" : "text-muted-foreground/80")} aria-hidden />
              {m.label}
            </button>
          );
        })}

        {overflow.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="ml-auto shrink-0 gap-2 rounded-xl px-3.5 h-11 text-sm font-medium text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
                aria-label={`More modules — ${overflow.length} more`}
              >
                More <ArrowRight className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-h-[26rem] overflow-y-auto hms-scroll">
              <DropdownMenuLabel className="text-xs">All modules</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {visible.map((m) => (
                <DropdownMenuItem
                  key={m.key}
                  onClick={() => onSelect(m.key)}
                  className={cn("gap-2.5 py-2.5", activeModule === m.key && "bg-primary/5 text-primary font-medium")}
                >
                  <m.icon className="h-4 w-4" aria-hidden />
                  {m.label}
                  {activeModule === m.key ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" aria-hidden /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
