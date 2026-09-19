"use client";

// MOHD.HMS ENTERPRISE — HR Letters home (tab inside the HR module, §50/§51).
// Quick actions (+ Create Letter and per-type shortcuts into the SAME system),
// KPI quick stats (drill down into the history filters), template strip and
// the most recent letters.

import { useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { fmtDate } from "@/lib/hms/format";
import { PERMISSIONS } from "@/lib/hms/constants";
import { StatCard, StatusBadge, EmptyState, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { LETTER_TYPES, letterTypeLabel, type LetterListItemDto, type LetterTemplateDto } from "@/lib/hms/letters/shared";
import { Button } from "@/components/ui/button";
import {
  FilePlus2, FileText, FileClock, Hourglass, CheckCircle2, Send, LayoutTemplate, ArrowRight, Plus,
} from "lucide-react";

type Stats = {
  thisMonth: number;
  drafts: number;
  pendingApproval: number;
  approved: number;
  sent: number;
  templates: number;
};

const QUICK_TYPES = ["LOU", "LOA", "SUBMISSION", "CLARIFICATION", "GENERAL"] as const;

export function LettersHome() {
  const { user } = useSession();
  const canView = hasPerm(user, PERMISSIONS.letters_view);
  const canCreate = hasPerm(user, PERMISSIONS.letters_create);
  const canTemplates = hasPerm(user, PERMISSIONS.letters_templates);

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recent, setRecent] = useState<LetterListItemDto[] | null>(null);
  const [templates, setTemplates] = useState<LetterTemplateDto[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!canView) return;
    let alive = true;
    Promise.all([
      api.get<Stats>("/api/v1/hr/letters/stats"),
      api.get<LetterListItemDto[]>("/api/v1/hr/letters?pageSize=8"),
      api.get<LetterTemplateDto[]>("/api/v1/hr/letters/templates?pageSize=6&status=ACTIVE"),
    ])
      .then(([s, r, t]) => {
        if (!alive) return;
        setStats(s.data);
        setRecent(r.data ?? []);
        setTemplates(t.data ?? []);
        setStatsError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setStatsError(e instanceof Error ? e.message : "Unable to load letters overview.");
      });
    return () => {
      alive = false;
    };
  }, [canView, reloadTick]);

  if (!canView) {
    return (
      <EmptyState
        title="Letters are restricted"
        hint="You need the letters.view permission. The letter system is available to HR and administrative roles."
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Quick actions (§50 — shortcuts into the same system) ── */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {canCreate ? (
            <Button size="sm" onClick={() => navigateTo("hr", ["letters", "new"])}>
              <FilePlus2 className="h-4 w-4 mr-1.5" /> Create Letter
            </Button>
          ) : null}
          {canCreate
            ? QUICK_TYPES.map((t) => (
                <Button key={t} size="sm" variant="outline" onClick={() => navigateTo("hr", ["letters", "new"], { type: t })} aria-label={`Create ${letterTypeLabel(t)}`}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> {letterTypeLabel(t).replace(" Letter", "")}
                </Button>
              ))
            : null}
          {canTemplates ? (
            <Button size="sm" variant="ghost" className="sm:ml-auto" onClick={() => navigateTo("hr", ["letters", "templates"])}>
              <LayoutTemplate className="h-4 w-4 mr-1.5" /> Manage Templates
            </Button>
          ) : null}
        </div>
      </div>

      {/* ── KPI quick stats (§51 — each drills into the history filter) ── */}
      {statsError ? (
        <ErrorState message={statsError} onRetry={() => setReloadTick((t) => t + 1)} />
      ) : !stats ? (
        <LoadingState label="Loading letter statistics…" rows={1} />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <StatCard title="Letters This Month" value={stats.thisMonth} icon={<FileText className="h-5 w-5" />} href="/hr/letters/history" />
          <StatCard title="Drafts" value={stats.drafts} icon={<FileClock className="h-5 w-5" />} href="/hr/letters/history?status=DRAFT" />
          <StatCard title="Pending Approval" value={stats.pendingApproval} icon={<Hourglass className="h-5 w-5" />} tone="warning" href="/hr/letters/history?status=UNDER_REVIEW" />
          <StatCard title="Approved" value={stats.approved} icon={<CheckCircle2 className="h-5 w-5" />} tone="success" href="/hr/letters/history?status=APPROVED" />
          <StatCard title="Sent" value={stats.sent} icon={<Send className="h-5 w-5" />} href="/hr/letters/history?status=SENT" />
          <StatCard title="Templates" value={stats.templates} icon={<LayoutTemplate className="h-5 w-5" />} href="/hr/letters/templates" />
        </div>
      )}

      {/* ── Templates strip ── */}
      {templates && templates.length > 0 ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold">Active Templates</h3>
            <Button size="sm" variant="ghost" onClick={() => navigateTo("hr", ["letters", "templates"])} aria-label="View all templates">
              View all <ArrowRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => navigateTo("hr", ["letters", "templates", t.id])}
                className="rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-primary/40"
                aria-label={`Open template ${t.code}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground">{t.code}</span>
                  <span className="text-[10px] rounded-full bg-primary/10 text-primary px-1.5">v{t.version}</span>
                </div>
                <div className="text-sm font-semibold mt-0.5 leading-snug">{t.name}</div>
                <div className="text-xs text-muted-foreground">{letterTypeLabel(t.letterType)}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Recent letters ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Recent Letters</h3>
          <Button size="sm" variant="ghost" onClick={() => navigateTo("hr", ["letters", "history"])} aria-label="View all letters">
            View all <ArrowRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
        {!recent ? (
          <LoadingState label="Loading letters…" rows={2} />
        ) : recent.length === 0 ? (
          <EmptyState
            title="No letters yet"
            hint="Create the first letter — pick a type, fill in the main information and let the AI draft it."
            action={canCreate ? <Button size="sm" onClick={() => navigateTo("hr", ["letters", "new"])}><FilePlus2 className="h-4 w-4 mr-1.5" /> Create Letter</Button> : undefined}
          />
        ) : (
          <ul className="rounded-xl border bg-card divide-y divide-border overflow-hidden">
            {recent.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  onClick={() => navigateTo("hr", ["letters", l.id])}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
                  aria-label={`Open letter ${l.letterNumber}`}
                >
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs">{l.letterNumber}</span>
                      <StatusBadge status={l.status} />
                    </span>
                    <span className="block text-sm truncate mt-0.5">{l.subject || letterTypeLabel(l.letterType)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">{fmtDate(l.letterDate)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
