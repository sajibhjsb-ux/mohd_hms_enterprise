"use client";

// MOHD.HMS ENTERPRISE — global search (INLINE, attached to the header bar).
//
// Clicking the header search bar focuses the SAME input — no popup, no modal,
// no page dimming, no second search field. Results render in a floating panel
// anchored directly beneath the bar while the rest of the page stays visible
// and usable.
//
// Real backend search only: complaints / work orders / customers / equipment
// via the existing list APIs (all support server-side ?search=, now
// case-insensitive — see src/lib/hms/text-search.ts). Result groups are gated
// by the signed-in user's permissions; the backend remains authoritative for
// RBAC/object-level access. No mock data, no fake results, no second search
// system.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { MODULES } from "@/components/hms/registry";
import { PERMISSIONS } from "@/lib/hms/constants";
import { customerLabel } from "@/lib/hms/format";
import { cn } from "@/lib/utils";
import {
  Search, X, Loader2, AlertTriangle, Building2, QrCode, ClipboardList,
  ArrowRight, RotateCcw,
} from "lucide-react";

type ComplaintHit = { id: string; code: string; title: string; status: string };
type WorkOrderHit = { id: string; code: string; title: string };
type CustomerHit = { id: string; companyName?: string; code?: string; contactPerson?: string };
type EquipmentHit = { id: string; name?: string; assetTag?: string; customer?: { companyName?: string } | null };

export type SearchNavigateTarget = { module: string; id?: string };

type Results = {
  complaints: ComplaintHit[];
  workOrders: WorkOrderHit[];
  customers: CustomerHit[];
  equipment: EquipmentHit[];
};

const EMPTY_RESULTS: Results = { complaints: [], workOrders: [], customers: [], equipment: [] };
const DEBOUNCE_MS = 250;

type Props = {
  /** Goes through the shell's dirty-state guard before switching modules. */
  onNavigate: (target: SearchNavigateTarget) => void;
  /** desktop → the centered header pill; mobile → full-width inline field. */
  variant: "desktop" | "mobile";
  autoFocus?: boolean;
  /** Mobile search mode exit (Escape with panel closed / result selected). */
  onClose?: () => void;
};

export function GlobalSearch({ onNavigate, variant, autoFocus, onClose }: Props) {
  const { user } = useSession();
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Any fetch failed on the latest completed run — a stale "No results" is
   *  never shown when the API actually errored (§15/§32). */
  const [failed, setFailed] = useState(false);
  const [results, setResults] = useState<Results>(EMPTY_RESULTS);
  const [active, setActive] = useState(-1);
  /** Bump to force a re-run (Try Again) without touching the query. */
  const [runId, setRunId] = useState(0);
  const seq = useRef(0);

  // §19 normalization: trim + collapse repeated spaces; identifiers such as
  // "WO-2026-00452" are preserved (the backend applies the same rule).
  const query = useMemo(() => raw.replace(/\s+/g, " ").trim(), [raw]);
  const valid = query.length >= 2;

  const canComplaints = hasPerm(user, PERMISSIONS.complaints_read);
  const canWorkOrders = hasPerm(user, PERMISSIONS.work_orders_read);
  const canCustomers = hasPerm(user, PERMISSIONS.customers_read);
  const canEquipment = hasPerm(user, PERMISSIONS.equipment_read);

  // Debounced, permission-gated, real API search. The debounce timer lives in
  // a callback so no state is set synchronously in the effect body. The seq
  // ref makes stale responses impossible to overwrite newer results (§25):
  // every callback re-checks seq before touching state.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const t = setTimeout(() => {
        const s = ++seq.current;
        if (!valid) {
          setResults(EMPTY_RESULTS);
          setLoading(false);
          setFailed(false);
          return;
        }
        const endpoints: Array<{ path: string; key: keyof Results }> = [];
        if (canComplaints) endpoints.push({ path: `/api/v1/complaints${qs({ search: query, pageSize: 5 })}`, key: "complaints" });
        if (canWorkOrders) endpoints.push({ path: `/api/v1/work-orders${qs({ search: query, pageSize: 5 })}`, key: "workOrders" });
        if (canCustomers) endpoints.push({ path: `/api/v1/customers${qs({ search: query, pageSize: 5 })}`, key: "customers" });
        if (canEquipment) endpoints.push({ path: `/api/v1/equipment${qs({ search: query, pageSize: 5 })}`, key: "equipment" });

        setLoading(true);
        setResults(EMPTY_RESULTS);
        let pending = endpoints.length;
        let errs = 0;
        endpoints.forEach(({ path, key }) => {
          api.get<Results[typeof key]>(path)
            .then((res) => {
              if (seq.current !== s) return;
              const rows = Array.isArray(res.data) ? res.data : [];
              setResults((prev) => ({ ...prev, [key]: rows }));
            })
            .catch(() => {
              if (seq.current !== s) return;
              errs += 1;
            })
            .finally(() => {
              if (seq.current !== s) return;
              pending -= 1;
              if (pending === 0) {
                setLoading(false);
                setFailed(errs > 0);
              }
            });
        });
      }, DEBOUNCE_MS);
      return () => clearTimeout(t);
    });
    return () => cancelAnimationFrame(raf);
  }, [query, valid, open, runId, canComplaints, canWorkOrders, canCustomers, canEquipment]);

  // Global shortcut: Ctrl/⌘ + K focuses the header search bar (desktop). It
  // never opens a dialog and never steals focus from rich-text fields.
  useEffect(() => {
    if (variant !== "desktop") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const t = e.target as HTMLElement | null;
        if (t && t.isContentEditable) return;
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant]);

  // §11 — close only on a genuine click OUTSIDE the bar/panel (pointerdown,
  // not mousemove/hover). Clicks inside (incl. panel scrolling) never close it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const go = useCallback((target: SearchNavigateTarget) => {
    setOpen(false);
    onNavigate(target);
    if (variant === "mobile") onClose?.();
  }, [onNavigate, onClose, variant]);

  const moduleHits = useMemo(() => {
    if (!valid) return [];
    const q = query.toLowerCase();
    return MODULES.filter((m) => m.label.toLowerCase().includes(q)).slice(0, 5);
  }, [query, valid]);

  /** Exact reference pins to the top of its group (§20) — stable, code-only.
   *  `codeOf` selects the reference field (equipment keys on assetTag). */
  const byExactCode = useCallback(
    <T,>(rows: T[], codeOf: (r: T) => string | undefined): T[] => {
      const q = query.toLowerCase();
      return rows
        .map((r, i) => ({ r, i, exact: (codeOf(r) ?? "").toLowerCase() === q }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.i - b.i)
        .map((x) => x.r);
    },
    [query]
  );

  const entityHits = (results.complaints.length + results.workOrders.length + results.customers.length + results.equipment.length) > 0;
  const anyHits = entityHits || moduleHits.length > 0;

  type FlatItem = { key: string; id: string; node: ReactNode; run: () => void };
  const items = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = [];
    moduleHits.forEach((m) => out.push({
      key: `mod-${m.key}`, id: `hms-gs-mod-${m.key}`,
      run: () => go({ module: m.key }),
      node: (
        <>
          <m.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{highlight(m.label, query)}</span>
          <span className="ml-auto hidden sm:inline text-[11px] text-muted-foreground">Go to module</span>
        </>
      ),
    }));
    byExactCode(results.complaints, (c) => c.code).forEach((c) => out.push({
      key: `cpt-${c.id}`, id: `hms-gs-cpt-${c.id}`,
      run: () => go({ module: "complaints", id: c.id }),
      node: (
        <>
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
          <span className="font-mono text-xs text-muted-foreground shrink-0">{highlight(c.code, query)}</span>
          <span className="truncate">{highlight(c.title, query)}</span>
        </>
      ),
    }));
    byExactCode(results.workOrders, (w) => w.code).forEach((w) => out.push({
      key: `wo-${w.id}`, id: `hms-gs-wo-${w.id}`,
      run: () => go({ module: "work-orders", id: w.id }),
      node: (
        <>
          <ClipboardList className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="font-mono text-xs text-muted-foreground shrink-0">{highlight(w.code, query)}</span>
          <span className="truncate">{highlight(w.title, query)}</span>
        </>
      ),
    }));
    byExactCode(results.customers, (c) => c.code).forEach((c) => out.push({
      key: `cus-${c.id}`, id: `hms-gs-cus-${c.id}`,
      run: () => go({ module: "customers", id: c.id }),
      node: (
        <>
          <Building2 className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
          <span className="truncate">{highlight(customerLabel(c), query)}</span>
          {c.code ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{highlight(c.code, query)}</span> : null}
        </>
      ),
    }));
    byExactCode(results.equipment, (e) => e.assetTag).forEach((e) => out.push({
      key: `eq-${e.id}`, id: `hms-gs-eq-${e.id}`,
      run: () => go({ module: "equipment", id: e.id }),
      node: (
        <>
          <QrCode className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span className="truncate">{highlight(e.name ?? e.id, query)}</span>
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{highlight(e.assetTag ?? "", query)}</span>
        </>
      ),
    }));
    return out;
  }, [moduleHits, results, query, byExactCode, go]);

  const viewAll = useCallback(() => {
    if (!valid) return;
    // The full results page uses the application's existing routing
    // architecture (/search?q=…) and reuses the SAME search APIs.
    navigateTo("search", [], { q: query });
    setOpen(false);
    if (variant === "mobile") onClose?.();
  }, [query, valid, variant, onClose]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => {
        if (a < 0) return e.key === "ArrowDown" ? 0 : items.length - 1;
        return e.key === "ArrowDown" ? (a + 1) % items.length : (a - 1 + items.length) % items.length;
      });
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = active >= 0 ? items[active] : items[0];
      if (item) item.run();
      else if (valid) viewAll(); // no direct hits → open the full search page
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      if (open) setOpen(false);
      else if (variant === "mobile") onClose?.();
    }
  }

  function clearAll() {
    // §12 — clear text + results, keep the field active, stay on this page.
    setRaw("");
    setResults(EMPTY_RESULTS);
    setLoading(false);
    setFailed(false);
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  const desktop = variant === "desktop";

  return (
    <div
      ref={wrapRef}
      className={cn("relative", desktop ? "w-full md:max-w-[560px] min-w-0" : "flex-1 min-w-0")}
      data-testid={desktop ? "global-search-desktop" : "global-search-mobile"}
    >
      {/* The ONE search bar — typing happens directly here (§4/§29). */}
      <div
        className={cn(
          "group flex items-center gap-2.5 rounded-full border border-border/70 bg-muted/40 hover:bg-muted/70 hover:border-border transition-colors duration-200 outline-none focus-within:ring-2 focus-within:ring-ring focus-within:bg-background",
          desktop ? "h-10 md:h-11 px-4" : "h-10 px-3.5"
        )}
      >
        {loading && open ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : (
          <Search className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground group-focus-within:text-foreground transition-colors" aria-hidden />
        )}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="hms-global-search-panel"
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && items[active] ? items[active].id : undefined}
          aria-label="Global search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus={autoFocus}
          value={raw}
          onChange={(e) => { setRaw(e.target.value); setActive(-1); setOpen(true); }}
          onFocus={() => setOpen(true)}
          // Clicking the already-focused bar (e.g. right after selecting a
          // result) must re-open the panel — focus never left, so onFocus
          // alone would not fire (§30.10: search works again immediately).
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search equipment, customers, work orders…"
          data-testid="global-search-input"
          className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
        {raw ? (
          <button
            type="button"
            onClick={clearAll}
            aria-label="Clear search"
            data-testid="global-search-clear"
            className="shrink-0 rounded-full p-1 text-muted-foreground hover:text-foreground hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : desktop ? (
          <kbd className="hidden lg:inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <SearchShortcutHint />
          </kbd>
        ) : null}
      </div>

      {/* Inline results panel — anchored beneath the bar, floating above the
          page (§3): NO overlay, NO dimming, NO modal, page stays usable. */}
      {open ? (
        <div
          id="hms-global-search-panel"
          role="listbox"
          aria-label="Global search results"
          data-testid="global-search-panel"
          className="absolute left-0 right-0 top-full mt-2 z-50 rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-lg overflow-hidden"
        >
          <div className="max-h-[min(60vh,26rem)] overflow-y-auto hms-scroll">
            {loading && anyHits ? (
              <div className="px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5 border-b bg-muted/30" role="status">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Searching…
              </div>
            ) : null}

            {!valid ? (
              <div className="py-7 px-4 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search across the platform.
              </div>
            ) : (
              <>
                {failed && !entityHits ? (
                  <div className="py-7 px-4 text-center" role="alert" data-testid="global-search-error">
                    <p className="text-sm text-muted-foreground">Unable to search right now.</p>
                    <button
                      type="button"
                      onClick={() => setRunId((r) => r + 1)}
                      data-testid="global-search-retry"
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RotateCcw className="h-3 w-3" aria-hidden /> Try Again
                    </button>
                  </div>
                ) : null}

                {!loading && !anyHits && !failed ? (
                  <div className="py-7 px-4 text-center text-sm text-muted-foreground" role="status" data-testid="global-search-no-results">
                    No results found for &ldquo;{query}&rdquo;.
                  </div>
                ) : null}

                {moduleHits.length > 0 ? (
                  <PanelGroup heading="Modules">
                    {moduleHits.map((m) => {
                      const idx = items.findIndex((it) => it.key === `mod-${m.key}`);
                      return (
                        <PanelItem key={`mod-${m.key}`} id={items[idx].id} active={idx === active} onHover={() => setActive(idx)} onClick={() => items[idx].run()}>
                          {items[idx].node}
                        </PanelItem>
                      );
                    })}
                  </PanelGroup>
                ) : null}

                {results.complaints.length > 0 ? (
                  <PanelGroup heading="Complaints">
                    {byExactCode(results.complaints, (c) => c.code).map((c) => {
                      const idx = items.findIndex((it) => it.key === `cpt-${c.id}`);
                      return (
                        <PanelItem key={c.id} id={items[idx].id} active={idx === active} onHover={() => setActive(idx)} onClick={() => items[idx].run()}>
                          {items[idx].node}
                        </PanelItem>
                      );
                    })}
                  </PanelGroup>
                ) : null}

                {results.workOrders.length > 0 ? (
                  <PanelGroup heading="Work Orders">
                    {byExactCode(results.workOrders, (w) => w.code).map((w) => {
                      const idx = items.findIndex((it) => it.key === `wo-${w.id}`);
                      return (
                        <PanelItem key={w.id} id={items[idx].id} active={idx === active} onHover={() => setActive(idx)} onClick={() => items[idx].run()}>
                          {items[idx].node}
                        </PanelItem>
                      );
                    })}
                  </PanelGroup>
                ) : null}

                {results.customers.length > 0 ? (
                  <PanelGroup heading="Customers">
                    {byExactCode(results.customers, (c) => c.code).map((c) => {
                      const idx = items.findIndex((it) => it.key === `cus-${c.id}`);
                      return (
                        <PanelItem key={c.id} id={items[idx].id} active={idx === active} onHover={() => setActive(idx)} onClick={() => items[idx].run()}>
                          {items[idx].node}
                        </PanelItem>
                      );
                    })}
                  </PanelGroup>
                ) : null}

                {results.equipment.length > 0 ? (
                  <PanelGroup heading="Equipment">
                    {byExactCode(results.equipment, (e) => e.assetTag).map((eq) => {
                      const idx = items.findIndex((it) => it.key === `eq-${eq.id}`);
                      return (
                        <PanelItem key={eq.id} id={items[idx].id} active={idx === active} onHover={() => setActive(idx)} onClick={() => items[idx].run()}>
                          {items[idx].node}
                        </PanelItem>
                      );
                    })}
                  </PanelGroup>
                ) : null}

                {failed && entityHits ? (
                  <div className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5 border-t" role="alert">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                    Some categories couldn&apos;t be searched.
                    <button type="button" onClick={() => setRunId((r) => r + 1)} className="ml-1 underline underline-offset-2 hover:text-foreground">
                      Retry
                    </button>
                  </div>
                ) : null}

                {anyHits || failed ? (
                  <button
                    type="button"
                    onClick={viewAll}
                    data-testid="global-search-view-all"
                    className="w-full flex items-center justify-center gap-1.5 border-t border-border/60 px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    View all results <ArrowRight className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </>
            )}
          </div>
          {valid && anyHits ? (
            <div className="px-3 py-1.5 border-t border-border/40 text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Search className="h-3 w-3" aria-hidden />
              Searching live data — results respect your role permissions.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PanelGroup({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={heading}>
      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80">
        {heading}
      </div>
      <div>{children}</div>
    </div>
  );
}

function PanelItem({ id, active, onHover, onClick, children }: {
  id: string; active: boolean; onHover: () => void; onClick: () => void; children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onClick}
      className={cn(
        "cursor-pointer px-3 py-2 flex items-center gap-2.5 text-sm outline-none",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
      )}
    >
      {children}
    </div>
  );
}

/** Case-insensitive highlight — pure React text nodes + <mark>, so database
 *  content is never rendered as HTML (XSS-safe by construction, §14).
 *  Shared with the /search full results page (same feature, same helper). */
export function highlight(text: string, query: string): ReactNode {
  const t = text ?? "";
  const q = query.trim().toLowerCase();
  if (!q || q.length < 2) return t;
  const lower = t.toLowerCase();
  if (!lower.includes(q)) return t;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (let idx = lower.indexOf(q); idx !== -1; idx = lower.indexOf(q, pos)) {
    if (idx > pos) parts.push(t.slice(pos, idx));
    parts.push(
      <mark key={parts.length} className="rounded-[2px] bg-primary/15 px-0.5 font-semibold text-foreground">
        {t.slice(idx, idx + q.length)}
      </mark>
    );
    pos = idx + q.length;
  }
  if (pos < t.length) parts.push(t.slice(pos));
  return parts;
}

function SearchShortcutHint() {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  return <span aria-hidden>{isMac ? "⌘K" : "Ctrl K"}</span>;
}
