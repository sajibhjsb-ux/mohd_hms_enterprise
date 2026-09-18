"use client";

// MOHD.HMS ENTERPRISE — desktop floating navigation (premium reference design).
// One authoritative nav source (MODULES registry, RBAC-filtered upstream).
// Compact slim capsule (44px) that sits proportionally under the header.
// Overflow is a scrollable + slidable strip: hidden scrollbar, drag-to-slide
// with the mouse, wheel-to-slide, and circular edge arrows — never wraps.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type ModuleDef } from "@/components/hms/registry";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  visible: ModuleDef[];
  activeModule: string;
  onSelect: (key: string) => void;
};

const DRAG_THRESHOLD = 6; // px of travel before a press becomes a drag (clicks still work)
const EDGE_EPSILON = 2;   // px tolerance for "at edge" scroll-state detection

export function FloatingNav({ visible, activeModule, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, moved: false, startX: 0, startScroll: 0, pointerId: -1 });
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [grabbing, setGrabbing] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > EDGE_EPSILON);
    setCanScrollRight(max > EDGE_EPSILON && el.scrollLeft < max - EDGE_EPSILON);
  }, []);

  // Re-evaluate whenever the module set changes (RBAC/login changes item widths).
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(updateScrollState);
    return () => cancelAnimationFrame(raf);
  }, [visible, updateScrollState]);

  // Track container resizes + webfont swaps (item widths shift slightly).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => updateScrollState());
    ro.observe(el);
    if (document.fonts?.ready) document.fonts.ready.then(() => updateScrollState()).catch(() => undefined);
    return () => ro.disconnect();
  }, [updateScrollState]);

  // Keep the active module within the visible strip (deep links, search nav…).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const node = el.querySelector<HTMLButtonElement>(`[data-nav-key="${CSS.escape(activeModule)}"]`);
    if (!node) return;
    const left = node.offsetLeft;
    const right = left + node.offsetWidth;
    if (left - 8 < el.scrollLeft) {
      el.scrollTo({ left: Math.max(0, left - 16), behavior: "smooth" });
    } else if (right + 8 > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: Math.max(0, right - el.clientWidth + 16), behavior: "smooth" });
    }
  }, [activeModule, visible]);

  // Mouse wheel → horizontal slide (only while the strip can absorb it, so the
  // page still scrolls normally at the edges and when nothing overflows).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const atStart = el.scrollLeft <= 0 && e.deltaY < 0;
      const atEnd = el.scrollLeft >= max - 1 && e.deltaY > 0;
      if (atStart || atEnd) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drag-to-slide (mouse only — touch devices use native momentum scrolling).
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    drag.current = { active: true, moved: false, startX: e.clientX, startScroll: el.scrollLeft, pointerId: e.pointerId };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scrollRef.current;
    if (!d.active || !el || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) > DRAG_THRESHOLD) {
      d.moved = true;
      setGrabbing(true);
      // Capture only once a real drag begins so plain clicks keep their target.
      try { el.setPointerCapture(d.pointerId); } catch { /* noop */ }
    }
    if (d.moved) el.scrollLeft = d.startScroll - dx;
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active || e.pointerId !== d.pointerId) return;
    d.active = false;
    if (d.moved) setGrabbing(false);
  };

  // Swallow the click that follows a drag so nav buttons don't misfire.
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) {
      e.preventDefault();
      e.stopPropagation();
      drag.current.moved = false;
    }
  };

  const scrollByAmount = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(240, el.clientWidth * 0.5), behavior: "smooth" });
  };

  return (
    <div className="hidden lg:block sticky top-[68px] z-30 mt-2 px-4 sm:px-6 no-print" data-testid="floating-nav">
      <div
        className="relative mx-auto max-w-[1080px] h-11 rounded-full border border-border/60 bg-background/85 backdrop-blur-xl shadow-[0_8px_24px_-10px_rgb(0_0_0/0.12)]"
        role="navigation"
        aria-label="Primary modules"
      >
        <div
          ref={scrollRef}
          onScroll={updateScrollState}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
          onClickCapture={onClickCapture}
          className={cn(
            "h-full rounded-full flex items-center gap-0.5 px-2 overflow-x-auto no-scrollbar select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            grabbing ? "cursor-grabbing" : "cursor-default"
          )}
        >
          {visible.map((m) => {
            const active = activeModule === m.key;
            return (
              <button
                key={m.key}
                data-nav-key={m.key}
                onClick={() => onSelect(m.key)}
                aria-current={active ? "page" : undefined}
                title={m.label}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 h-8 text-[13px] leading-none font-medium whitespace-nowrap transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-primary/10 text-primary font-semibold"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <m.icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground/80")} aria-hidden />
                {m.label}
              </button>
            );
          })}
        </div>

        {canScrollLeft ? (
          <button
            type="button"
            onClick={() => scrollByAmount(-1)}
            aria-label="Scroll modules left"
            title="Scroll left"
            className="absolute left-1 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full border border-border/70 bg-background shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
        ) : null}

        {canScrollRight ? (
          <button
            type="button"
            onClick={() => scrollByAmount(1)}
            aria-label="Scroll modules right"
            title="Scroll right"
            className="absolute right-1 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full border border-border/70 bg-background shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}
