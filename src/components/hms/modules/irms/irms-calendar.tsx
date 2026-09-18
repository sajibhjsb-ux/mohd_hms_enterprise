"use client";

// MOHD.HMS ENTERPRISE — IRMS inspection calendar (month grid, no new deps).
//
// GET /api/v1/irms/calendar?from&to (visible month ± 6 days, ≤ 62 days per
// contract §12). Day cells carry report chips: code + truncated title + status
// color dot (STATUS_TONE map) + a red ring for URGENT priority. Chip click →
// dedicated report detail. "New inspection" deep-links the builder with the
// pre-filled date (/irms/reports/new?date=YYYY-MM-DD, read via the module
// query). On <640px a compact list-per-day replaces the grid. Responsive,
// keyboard accessible, honest loading/error/empty states.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { hasPerm, useSession } from "@/components/hms/session";
import { PERMISSIONS, STATUS_TONE } from "@/lib/hms/constants";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { IrmsSectionNav } from "./irms-dashboard";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, CalendarDays, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

type CalendarItem = {
  id: string;
  code: string;
  title: string;
  status: string;
  priority?: string | null;
  inspectionDate: string;
  project?: { name: string } | null;
  inspector?: { name?: string | null } | null;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dotClass(status: string): string {
  return (STATUS_TONE[status] ?? "bg-stone-300").split(" ")[0];
}

export function IrmsCalendarPage() {
  const { user } = useSession();
  const canCreate = hasPerm(user, PERMISSIONS.irms_create);
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });

  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch window: first of month − 6 days → last of month + 6 days.
  const from = useMemo(() => ymd(new Date(cursor.y, cursor.m, -5)), [cursor]);
  const to = useMemo(() => ymd(new Date(cursor.y, cursor.m + 1, 6)), [cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<CalendarItem[]>(`/api/v1/irms/calendar${qs({ from, to })}`);
      setItems(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the inspection calendar.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  useRealtimeEventDebounced(MODULE_EVENTS.irms, () => { void load(); });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const it of items ?? []) {
      const key = (it.inspectionDate ?? "").slice(0, 10);
      if (!key) continue;
      map.set(key, [...(map.get(key) ?? []), it]);
    }
    return map;
  }, [items]);

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const startWeekday = (first.getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(cursor.y, cursor.m + 1, 0).getDate();
    const out: { day: number; date: string }[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ day: d, date: ymd(new Date(cursor.y, cursor.m, d)) });
    }
    return { startWeekday, days: out };
  }, [cursor]);

  const todayKey = ymd(new Date());
  const monthLabel = `${MONTHS[cursor.m]} ${cursor.y}`;

  const prevMonth = () => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const nextMonth = () => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });

  const newFor = (date?: string) => navigateTo("irms", ["reports", "new"], date ? { date } : undefined);

  const sortedDaysWithEvents = useMemo(
    () => Array.from(byDay.keys()).sort(),
    [byDay],
  );

  return (
    <div>
      <IrmsSectionNav active="calendar" />
      <PageHeader
        title="Inspection Calendar"
        subtitle="Scheduled and completed inspections by date — click a report to open it"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={prevMonth} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
              <Button variant="outline" size="sm" onClick={goToday}>Today</Button>
              <Button variant="outline" size="sm" onClick={nextMonth} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
            </div>
            {canCreate ? (
              <Button size="sm" onClick={() => newFor(todayKey)}>
                <Plus className="h-4 w-4 mr-1.5" /> New inspection
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-primary" aria-hidden />
        <h2 className="text-lg font-semibold">{monthLabel}</h2>
      </div>

      {loading && items === null ? (
        <LoadingState label="Loading calendar…" rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : (
        <>
          {/* Desktop / tablet: month grid */}
          <div className="hidden overflow-hidden rounded-xl border sm:block">
            <div className="grid grid-cols-7 border-b bg-muted/50 text-center text-xs font-medium text-muted-foreground">
              {WEEKDAYS.map((w) => <div key={w} className="p-2">{w}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {Array.from({ length: cells.startWeekday }).map((_, i) => (
                <div key={`pad-${i}`} className="min-h-[96px] border-b border-r bg-muted/20 p-1.5" aria-hidden />
              ))}
              {cells.days.map(({ day, date }) => {
                const dayItems = byDay.get(date) ?? [];
                const isToday = date === todayKey;
                return (
                  <div key={date} className={cn("min-h-[96px] border-b border-r p-1.5", isToday && "bg-primary/[0.06]")}>
                    <div className="mb-1 flex items-center justify-between gap-1">
                      <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums", isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                        {day}
                      </span>
                      {canCreate ? (
                        <button
                          type="button"
                          onClick={() => newFor(date)}
                          aria-label={`New inspection on ${date}`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                    <div className="space-y-1">
                      {dayItems.slice(0, 3).map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => navigateTo("irms", ["reports", it.id])}
                          aria-label={`Open report ${it.code} — ${it.title}`}
                          className={cn(
                            "block w-full rounded border border-border/60 bg-card px-1.5 py-1 text-left text-[11px] leading-tight transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            it.priority === "URGENT" && "ring-2 ring-red-400",
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(it.status))} aria-hidden />
                            <span className="truncate font-semibold">{it.code}</span>
                          </span>
                          <span className="block truncate text-muted-foreground">{it.title}</span>
                        </button>
                      ))}
                      {dayItems.length > 3 ? (
                        <p className="px-1 text-[10px] text-muted-foreground">+{dayItems.length - 3} more</p>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Mobile: compact list per day */}
          <div className="space-y-3 sm:hidden">
            {sortedDaysWithEvents.length === 0 ? (
              <EmptyState title={`No inspections in ${monthLabel}`} hint="Use + on any day in the desktop view, or the New inspection button, to schedule one." />
            ) : (
              sortedDaysWithEvents.map((date) => (
                <div key={date} className="rounded-xl border bg-card p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className={cn("text-sm font-semibold", date === todayKey && "text-primary")}>
                      {new Date(`${date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}
                      {date === todayKey ? " · Today" : ""}
                    </span>
                    {canCreate ? (
                      <Button variant="ghost" size="sm" onClick={() => newFor(date)} aria-label={`New inspection on ${date}`}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                  <ul className="space-y-1.5">
                    {(byDay.get(date) ?? []).map((it) => (
                      <li key={it.id}>
                        <button
                          type="button"
                          onClick={() => navigateTo("irms", ["reports", it.id])}
                          aria-label={`Open report ${it.code} — ${it.title}`}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-2 text-left text-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            it.priority === "URGENT" && "ring-2 ring-red-400",
                          )}
                        >
                          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotClass(it.status))} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{it.code} · {it.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">{it.project?.name ?? ""}{it.inspector?.name ? ` · ${it.inspector.name}` : ""}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
            {sortedDaysWithEvents.length > 0 ? (
              <p className="text-center text-xs text-muted-foreground">Showing days with inspections in {monthLabel}.</p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
