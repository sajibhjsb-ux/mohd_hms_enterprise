"use client";

// MOHD.HMS ENTERPRISE — global search (premium command palette).
// Real backend search only: complaints / customers / equipment via existing
// list APIs (all support server-side ?search=). Result groups are gated by
// the signed-in user's permissions. No mock data, no fake results.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { api, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { MODULES } from "@/components/hms/registry";
import { PERMISSIONS } from "@/lib/hms/constants";
import { Search, Loader2, AlertTriangle, Building2, QrCode } from "lucide-react";

type ComplaintHit = { id: string; code: string; title: string; status: string };
type CustomerHit = { id: string; companyName?: string; code?: string; contactPerson?: string };
type EquipmentHit = { id: string; name?: string; assetTag?: string; customer?: { companyName?: string } | null };

export type SearchNavigateTarget = { module: string; id?: string };

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Goes through the shell's dirty-state guard before switching modules. */
  onNavigate: (target: SearchNavigateTarget) => void;
};

export function GlobalSearch({ open, onOpenChange, onNavigate }: Props) {
  const { user } = useSession();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [complaints, setComplaints] = useState<ComplaintHit[]>([]);
  const [customers, setCustomers] = useState<CustomerHit[]>([]);
  const [equipment, setEquipment] = useState<EquipmentHit[]>([]);
  const seq = useRef(0);

  const canComplaints = hasPerm(user, PERMISSIONS.complaints_read);
  const canCustomers = hasPerm(user, PERMISSIONS.customers_read);
  const canEquipment = hasPerm(user, PERMISSIONS.equipment_read);

  // Reset results when the palette closes so the next open starts clean
  // (event-driven — no setState inside effects).
  const handleOpenChange = useCallback((o: boolean) => {
    if (!o) {
      setQuery("");
      setComplaints([]);
      setCustomers([]);
      setEquipment([]);
      setLoading(false);
    }
    onOpenChange(o);
  }, [onOpenChange]);

  // Global shortcut: Ctrl/⌘ + K opens the palette. Never steals focus from
  // rich-text (contentEditable) fields; plain inputs are fine to interrupt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        const t = e.target as HTMLElement | null;
        if (t && (t.isContentEditable)) return;
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpenChange]);

  // Debounced, permission-gated, real API search. Runs off the synchronous
  // effect path via rAF (React 19 set-state-in-effect rule).
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const q = query.trim();
      const tasks: Promise<unknown>[] = [];
      const s = ++seq.current;

      const pick = <T,>(p: Promise<{ data: T[] }>, set: (v: T[]) => void) =>
        tasks.push(
          p.then((r) => { if (s === seq.current) set(Array.isArray(r.data) ? r.data : []); })
            .catch(() => { if (s === seq.current) set([]); })
        );

      if (q.length >= 2) {
        setLoading(true);
        if (canComplaints) pick(api.get<ComplaintHit[]>(`/api/v1/complaints${qs({ search: q, pageSize: 5 })}`), setComplaints);
        if (canCustomers) pick(api.get<CustomerHit[]>(`/api/v1/customers${qs({ search: q, pageSize: 5 })}`), setCustomers);
        if (canEquipment) pick(api.get<EquipmentHit[]>(`/api/v1/equipment${qs({ search: q, pageSize: 5 })}`), setEquipment);
      } else {
        setComplaints([]);
        setCustomers([]);
        setEquipment([]);
        setLoading(false);
        return;
      }
      Promise.all(tasks).finally(() => { if (s === seq.current) setLoading(false); });
    });
    return () => cancelAnimationFrame(raf);
  }, [query, open, canComplaints, canCustomers, canEquipment]);

  const moduleHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return MODULES.filter((m) => m.label.toLowerCase().includes(q)).slice(0, 5);
  }, [query]);

  const go = useCallback((t: SearchNavigateTarget) => {
    handleOpenChange(false);
    onNavigate(t);
  }, [handleOpenChange, onNavigate]);

  const anyHits = complaints.length + customers.length + equipment.length + moduleHits.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      className="sm:max-w-xl md:top-[12%]"
      title="Global Search"
      description="Search modules, complaints, customers and equipment."
    >
      <div className="relative">
        <CommandInput
          placeholder="Search equipment, customers, work orders…"
          value={query}
          onValueChange={setQuery}
        />
        {loading ? (
          <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground pointer-events-none" aria-hidden />
        ) : null}
      </div>
      <CommandList className="max-h-[22rem]">
        {!anyHits && q2(query) && !loading ? (
          <CommandEmpty>No matches for “{query.trim()}”.</CommandEmpty>
        ) : !anyHits && !q2(query) ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search across the platform.
          </div>
        ) : null}

        {moduleHits.length > 0 ? (
          <CommandGroup heading="Modules">
            {moduleHits.map((m) => (
              <CommandItem key={`mod-${m.key}`} value={`mod-${m.label}`} onSelect={() => go({ module: m.key })}>
                <m.icon className="h-4 w-4 text-primary" aria-hidden />
                <span>{m.label}</span>
                <span className="ml-auto text-xs text-muted-foreground">Go to module</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {complaints.length > 0 ? (
          <CommandGroup heading="Complaints">
            {complaints.map((c) => (
              <CommandItem key={c.id} value={`cpt-${c.code}-${c.title}`} onSelect={() => go({ module: "complaints", id: c.id })}>
                <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
                <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
                <span className="truncate max-w-[16rem]">{c.title}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {customers.length > 0 ? (
          <CommandGroup heading="Customers">
            {customers.map((c) => (
              <CommandItem key={c.id} value={`cus-${c.companyName ?? c.id}`} onSelect={() => go({ module: "customers", id: c.id })}>
                <Building2 className="h-4 w-4 text-teal-600" aria-hidden />
                <span className="truncate">{c.companyName ?? c.id}</span>
                {c.code ? <span className="ml-auto text-xs text-muted-foreground">#{c.code}</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {equipment.length > 0 ? (
          <CommandGroup heading="Equipment">
            {equipment.map((e) => (
              <CommandItem key={e.id} value={`eq-${e.assetTag ?? e.id}-${e.name ?? ""}`} onSelect={() => go({ module: "equipment", id: e.id })}>
                <QrCode className="h-4 w-4 text-primary" aria-hidden />
                <span className="truncate">{e.name ?? e.id}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">{e.assetTag}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {anyHits ? <CommandSeparator className="my-1" /> : null}
        <div className="px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Search className="h-3 w-3" aria-hidden />
          Searching live data — results respect your role permissions.
        </div>
      </CommandList>
    </CommandDialog>
  );
}

function q2(query: string) { return query.trim().length >= 2; }
