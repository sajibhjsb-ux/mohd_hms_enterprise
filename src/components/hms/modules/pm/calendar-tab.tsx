"use client";

// MOHD.HMS ENTERPRISE — PM Calendar tab (month grid, mirrors the IRMS
// calendar pattern). Fed by GET /api/v1/pm/calendar?from&to (4-a endpoint).
// Day cells carry occurrence chips: code + plan + status dot; chip click →
// task execution page. On <640px a compact list-per-day replaces the grid.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "@/lib/hms/api-client";
import { useRealtimeEventDebounced } from "@/lib/hms/realtime/hooks";
import { MODULE_EVENTS } from "@/lib/hms/realtime/matrix";
import { navigateTo } from "@/lib/hms/router";
import { STATUS_TONE } from "@/lib/hms/constants";
import { fmtDate } from "@/lib/hms/format";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type CalendarTask = {
  id: string; code: string; dueDate: string; status: string; priority: string | null;
  plan?: { name: string; code: string } | null;
  equipment?: { name: string; assetTag: string } | null;
  technician?: { user?: { name: string } | null } | null;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dotClass(status: string): string {
  return (STATUS_TONE[status] ?? "bg-stone-300").split(" ")[0];
}

export function PmCalendarTab() {
  const today = new Date();
  const [cursor, setCursor] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState<CalendarTask[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch window: first of month − 6 days → last of month + 6 days.
  const from = useMemo(() => ymd(new Date(cursor.y, cursor.m, -5)), [cursor]);
  const to = useMemo(() => ymd(new Date(cursor.y, cursor.m + 1, 6)), [cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<CalendarTask[]>(`/api/v1/pm/calendar${qs({ from, to })}`);
      setItems(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the PM calendar.");
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);
  useRealtimeEventDebounced(MODULE_EVENTS.pm, () => { void load(); });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarTask[]>();
    for (const it of items ?? []) {
      const key = (it.dueDate ?? "").slice(0, 10);
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
    for (let d = 1; d <= daysInMonth; d++) out.push({ day: d, date: ymd(new Date(cursor.y, cursor.m, d)) });
    return { startWeekday, days: out };
  }, [cursor]);

  const todayKey = ymd(new Date());
  const monthLabel = `${MONTHS[cursor.m]} ${cursor.y}`;
  const prevMonth = () => setCursor((c) => (c.m === 0 ? { y: c.y - 1, m: 11 } : { y: c.y, m: c.m - 1 }));
  const nextMonth = () => setCursor((c) => (c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }));
  const goToday = () => setCursor({ y: today.getFullYear(), m: today.getMonth() });
  const sortedDaysWithEvents = useMemo(() => Array.from(byDay.keys()).sort(), [byDay]);

  return (
    <div>
      <PageHeader
        title="PM Calendar"
        subtitle="Scheduled occurrences by due date — click one to open the execution page"
        actions={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={prevMonth} aria-label="Previous month"><ChevronLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={goToday}>Today</Button>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={nextMonth} aria-label="Next month"><ChevronRight className="h-4 w-4" /></Button>
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
                      {dayItems.length > 0 ? <span className="text-[10px] text-muted-foreground tabular-nums">{dayItems.length}</span> : null}
                    </div>
                    <div className="space-y-1">
                      {dayItems.slice(0, 3).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => navigateTo("pm", ["tasks", t.id])}
                          aria-label={`Open ${t.code} — ${t.plan?.name ?? "PM occurrence"}`}
                          className={cn(
                            "block w-full rounded border border-border/60 bg-card px-1.5 py-1 text-left text-[11px] leading-tight transition-colors hover:border-primary/50 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            t.priority === "CRITICAL" && "ring-2 ring-red-400",
                          )}
                        >
                          <span className="flex items-center gap-1">
                            <span className={cn("h-2 w-2 shrink-0 rounded-full", dotClass(t.status))} aria-hidden />
                            <span className="truncate font-semibold font-mono">{t.code}</span>
                          </span>
                          <span className="block truncate text-muted-foreground">{t.plan?.name ?? t.equipment?.name ?? ""}</span>
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
              <EmptyState title={`No occurrences in ${monthLabel}`} hint="Generate occurrences from the Plans tab to fill the calendar." />
            ) : (
              sortedDaysWithEvents.map((date) => (
                <div key={date} className="rounded-xl border bg-card p-3">
                  <p className={cn("mb-2 text-sm font-semibold", date === todayKey && "text-primary")}>
                    {fmtDate(date)}
                    {date === todayKey ? " · Today" : ""}
                  </p>
                  <ul className="space-y-1.5">
                    {(byDay.get(date) ?? []).map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => navigateTo("pm", ["tasks", t.id])}
                          aria-label={`Open ${t.code}`}
                          className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-2.5 min-h-[44px] text-left text-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotClass(t.status))} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{t.code} · {t.plan?.name ?? "PM"}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {t.equipment?.name ?? ""}
                              {t.technician?.user?.name ? ` · ${t.technician.user.name}` : ""}
                            </span>
                          </span>
                          <StatusBadge status={t.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
