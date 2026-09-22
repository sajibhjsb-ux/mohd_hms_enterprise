"use client";

// MOHD.HMS ENTERPRISE — Global Search full results page (/search?q=…).
//
// This is the "View all results" destination of the INLINE header search —
// it reuses the SAME search APIs (complaints / work orders / customers /
// equipment), the same permission gating and the same case-insensitive
// backend (see src/lib/hms/text-search.ts). It is NOT a second search
// system: the header inline search stays the primary interaction; this page
// simply shows the full result set with the module registry's standard
// routing (ui-store per-module query, see useModuleQuery).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { useModuleQuery } from "@/lib/hms/page-query";
import { PERMISSIONS } from "@/lib/hms/constants";
import { customerLabel } from "@/lib/hms/format";
import { highlight } from "@/components/hms/shell/global-search";
import { PageHeader, EmptyState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AlertTriangle, Building2, ClipboardList, QrCode, RotateCcw, Search,
} from "lucide-react";

type ComplaintHit = { id: string; code: string; title: string; status: string };
type WorkOrderHit = { id: string; code: string; title: string };
type CustomerHit = { id: string; companyName?: string; code?: string; contactPerson?: string };
type EquipmentHit = { id: string; name?: string; assetTag?: string };

const DEBOUNCE_MS = 250;

export function SearchModule() {
  const { user } = useSession();
  const { params, apply } = useModuleQuery("search");
  const urlQ = params.q ?? "";

  const [raw, setRaw] = useState(urlQ);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [runId, setRunId] = useState(0);
  const seq = useRef(0);

  const [complaints, setComplaints] = useState<ComplaintHit[]>([]);
  const [workOrders, setWorkOrders] = useState<WorkOrderHit[]>([]);
  const [customers, setCustomers] = useState<CustomerHit[]>([]);
  const [equipment, setEquipment] = useState<EquipmentHit[]>([]);

  const query = useMemo(() => raw.replace(/\s+/g, " ").trim(), [raw]);
  const valid = query.length >= 2;

  // Keep the field in sync when the URL query changes (View all results,
  // Back/Forward between two searches).
  useEffect(() => {
    const t = setTimeout(() => setRaw(urlQ), 0);
    return () => clearTimeout(t);
  }, [urlQ]);

  const canComplaints = hasPerm(user, PERMISSIONS.complaints_read);
  const canWorkOrders = hasPerm(user, PERMISSIONS.work_orders_read);
  const canCustomers = hasPerm(user, PERMISSIONS.customers_read);
  const canEquipment = hasPerm(user, PERMISSIONS.equipment_read);

  // Same fetch discipline as the inline panel: debounced, stale-proof (seq).
  useEffect(() => {
    if (!valid) return;
    const raf = requestAnimationFrame(() => {
      const t = setTimeout(() => {
        const s = ++seq.current;
        setLoading(true);
        let pending = 4;
        let errs = 0;
        const done = () => {
          if (seq.current !== s) return;
          pending -= 1;
          if (pending === 0) {
            setLoading(false);
            setFailed(errs > 0);
          }
        };
        const grab = <T,>(path: string, set: (v: T[]) => void) => {
          api.get<T[]>(path)
            .then((r) => { if (seq.current === s) set(Array.isArray(r.data) ? r.data : []); })
            .catch(() => { if (seq.current === s) errs += 1; })
            .finally(done);
        };
        grab<ComplaintHit>(`/api/v1/complaints${qs({ search: query, pageSize: 25 })}`, canComplaints ? setComplaints : () => undefined);
        grab<WorkOrderHit>(`/api/v1/work-orders${qs({ search: query, pageSize: 25 })}`, canWorkOrders ? setWorkOrders : () => undefined);
        grab<CustomerHit>(`/api/v1/customers${qs({ search: query, pageSize: 25 })}`, canCustomers ? setCustomers : () => undefined);
        grab<EquipmentHit>(`/api/v1/equipment${qs({ search: query, pageSize: 25 })}`, canEquipment ? setEquipment : () => undefined);
      }, DEBOUNCE_MS);
      return () => clearTimeout(t);
    });
    return () => cancelAnimationFrame(raf);
  }, [query, valid, runId, canComplaints, canWorkOrders, canCustomers, canEquipment]);

  const submit = useCallback(() => {
    if (query) apply({ q: query });
  }, [query, apply]);

  const total = complaints.length + workOrders.length + customers.length + equipment.length;
  const exactTop = useCallback(
    <T,>(rows: T[], codeOf: (r: T) => string | undefined): T[] => {
      const q = query.toLowerCase();
      return rows
        .map((r, i) => ({ r, i, exact: (codeOf(r) ?? "").toLowerCase() === q }))
        .sort((a, b) => Number(b.exact) - Number(a.exact) || a.i - b.i)
        .map((x) => x.r);
    },
    [query]
  );

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto" data-testid="search-page">
      <PageHeader
        title="Search"
        subtitle="Search complaints, work orders, customers and equipment across the platform."
      />

      {/* Refine field — same inline search component family, Enter applies. */}
      <div className="flex items-center gap-2 mb-5">
        <div className="group flex items-center gap-2.5 h-10 w-full max-w-xl rounded-full border border-border/70 bg-muted/40 px-4 focus-within:ring-2 focus-within:ring-ring focus-within:bg-background">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Search equipment, customers, work orders…"
            aria-label="Search query"
            autoFocus={!urlQ}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <Button size="sm" className="h-10 rounded-full px-4" onClick={submit}>Search</Button>
      </div>

      {!valid ? (
        <EmptyState
          title="Type at least 2 characters to search"
          hint="Results respect your role permissions."
        />
      ) : loading && total === 0 ? (
        <LoadingState label="Searching…" />
      ) : failed && total === 0 ? (
        <div className="py-16 text-center" role="alert">
          <p className="text-sm text-muted-foreground">Unable to search right now.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setRunId((r) => r + 1)}>
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Try Again
          </Button>
        </div>
      ) : total === 0 ? (
        <EmptyState
          title={`No results found for “${query}”`}
          hint="Try a different spelling or a shorter keyword."
        />
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground" role="status">
            {total} result{total === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
          </p>

          {canComplaints && complaints.length > 0 ? (
            <ResultGroup heading="Complaints" count={complaints.length}>
              {exactTop(complaints, (c) => c.code).map((c) => (
                <ResultRow key={c.id} onClick={() => navigateTo("complaints", [c.id])}>
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{highlight(c.code, query)}</span>
                  <span className="truncate">{highlight(c.title, query)}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.status}</span>
                </ResultRow>
              ))}
            </ResultGroup>
          ) : null}

          {canWorkOrders && workOrders.length > 0 ? (
            <ResultGroup heading="Work Orders" count={workOrders.length}>
              {exactTop(workOrders, (w) => w.code).map((w) => (
                <ResultRow key={w.id} onClick={() => navigateTo("work-orders", [w.id])}>
                  <ClipboardList className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="font-mono text-xs text-muted-foreground shrink-0">{highlight(w.code, query)}</span>
                  <span className="truncate">{highlight(w.title, query)}</span>
                </ResultRow>
              ))}
            </ResultGroup>
          ) : null}

          {canCustomers && customers.length > 0 ? (
            <ResultGroup heading="Customers" count={customers.length}>
              {exactTop(customers, (c) => c.code).map((c) => (
                <ResultRow key={c.id} onClick={() => navigateTo("customers", [c.id])}>
                  <Building2 className="h-4 w-4 shrink-0 text-teal-600" aria-hidden />
                  <span className="truncate">{highlight(customerLabel(c), query)}</span>
                  {c.code ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{highlight(c.code, query)}</span> : null}
                </ResultRow>
              ))}
            </ResultGroup>
          ) : null}

          {canEquipment && equipment.length > 0 ? (
            <ResultGroup heading="Equipment" count={equipment.length}>
              {exactTop(equipment, (e) => e.assetTag).map((e) => (
                <ResultRow key={e.id} onClick={() => navigateTo("equipment", [e.id])}>
                  <QrCode className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">{highlight(e.name ?? e.id, query)}</span>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{highlight(e.assetTag ?? "", query)}</span>
                </ResultRow>
              ))}
            </ResultGroup>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ResultGroup({ heading, count, children }: { heading: string; count: number; children: ReactNode }) {
  return (
    <section aria-label={`${heading}: ${count} results`}>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80 mb-1.5 flex items-center gap-1.5">
        {heading} <span className="font-normal normal-case tracking-normal">· {count} result{count === 1 ? "" : "s"}</span>
      </h2>
      <div className="rounded-xl border border-border/60 bg-card overflow-hidden divide-y divide-border/40">{children}</div>
    </section>
  );
}

function ResultRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("w-full text-left px-3.5 py-2.5 flex items-center gap-2.5 text-sm hover:bg-accent/60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset")}
    >
      {children}
    </button>
  );
}
