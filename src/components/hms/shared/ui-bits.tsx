"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { humanize, STATUS_TONE } from "@/lib/hms/constants";
import { money } from "@/lib/hms/format";
import { AlertCircle, ArrowUpRight, Inbox, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  if (!status) return <span>—</span>;
  return (
    <Badge variant="outline" className={cn("font-medium border-transparent whitespace-nowrap", STATUS_TONE[status] ?? "bg-stone-100 text-stone-700", className)}>
      {humanize(status)}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  return <StatusBadge status={priority} />;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 no-print">{actions}</div> : null}
    </div>
  );
}

/**
 * KPI stat card. When `href` is provided the whole card is a semantic link
 * (keyboard accessible, Enter to activate) to the drill-down feature page —
 * never a popup. With `onClick` (and no href) the card is a semantic button
 * for in-page drill-down panels. Hover: subtle elevation + green-tinted
 * border; active: press effect. Without either it renders as a plain,
 * non-clickable card.
 */
export function StatCard({ title, value, sub, icon, tone = "default", loading, href, onClick }: { title: string; value: string | number; sub?: string; icon?: ReactNode; tone?: "default" | "warning" | "danger" | "success"; loading?: boolean; href?: string; onClick?: () => void }) {
  const toneCls = {
    default: "text-primary bg-primary/10",
    warning: "text-amber-600 bg-amber-100",
    danger: "text-red-600 bg-red-100",
    success: "text-emerald-600 bg-emerald-100",
  }[tone];
  const interactive = Boolean(href || onClick);
  const card = (
    <Card
      className={cn(
        "shadow-sm relative",
        interactive && "transition-all duration-150 border-border group-hover:border-primary/45 group-hover:shadow-md group-hover:bg-primary/[0.035] group-active:translate-y-0 group-active:shadow-sm"
      )}
    >
      {interactive ? (
        <ArrowUpRight
          className="absolute right-3 top-3 h-4 w-4 text-primary opacity-0 translate-x-0.5 -translate-y-0.5 group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0 transition-all"
          aria-hidden
        />
      ) : null}
      <CardContent className="p-4 sm:p-5 flex items-center gap-4">
        {icon ? <div className={cn("h-10 w-10 rounded-lg flex items-center justify-center shrink-0", toneCls)}>{icon}</div> : null}
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide truncate">{title}</div>
          {loading ? (
            <Skeleton className="h-7 w-20 mt-1" />
          ) : (
            <div className="text-lg sm:text-xl font-semibold leading-tight mt-0.5 truncate" title={String(value)}>{value}</div>
          )}
          {sub && !loading ? <div className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</div> : null}
        </div>
      </CardContent>
    </Card>
  );
  if (href) {
    return (
      <a
        href={href}
        className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={loading ? `${title} — loading` : `${title}, ${value}. View ${title}.`}
      >
        {card}
      </a>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="group block w-full text-left rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-label={loading ? `${title} — loading` : `${title}, ${value}. Show ${title}.`}
      >
        {card}
      </button>
    );
  }
  return card;
}

/** One drill-down filter chip derived from the URL query. */
export type DrilldownChip = { key: string; label: string; value: string };

/**
 * Active-filter chips shown when a list page was opened from a KPI
 * (e.g. Complaints [ Status: Active × ] [ Priority: Urgent ×]). The × on a
 * chip removes that param; “Clear filters” returns to the unfiltered list.
 * Both navigate via the hash router — never a popup.
 */
export function DrilldownChips({ chips, onRemove, onClear }: { chips: DrilldownChip[]; onRemove: (key: string) => void; onClear: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Active filters">
      <span className="text-xs text-muted-foreground">Filtered view:</span>
      {chips.map((c) => (
        <Badge
          key={c.key}
          variant="outline"
          className="gap-1 pr-1 bg-primary/5 border-primary/30 text-foreground"
        >
          <span className="text-muted-foreground">{c.label}:</span> {c.value}
          <button
            type="button"
            onClick={() => onRemove(c.key)}
            aria-label={`Remove ${c.label} filter`}
            className="ml-0.5 rounded-full p-0.5 hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </Badge>
      ))}
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

export function Money({ cents, className }: { cents: number | null | undefined; className?: string }) {
  return <span className={className}>{money(cents)}</span>;
}

export function LoadingState({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label={label}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {label}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title = "Nothing here yet", hint, action }: { title?: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center border rounded-xl bg-muted/30">
      <Inbox className="h-10 w-10 text-muted-foreground/50 mb-3" aria-hidden />
      <p className="font-medium">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground mt-1 max-w-sm">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message = "Something went wrong. Please try again.", onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" className="my-4">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Unable to load</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        {onRetry ? (
          <button onClick={onRetry} className="underline underline-offset-2 font-medium hover:no-underline">
            Retry
          </button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function TwoField({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>;
}
