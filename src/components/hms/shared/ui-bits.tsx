"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { humanize, STATUS_TONE } from "@/lib/hms/constants";
import { money } from "@/lib/hms/format";
import { AlertCircle, Inbox, Loader2 } from "lucide-react";
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

export function StatCard({ title, value, sub, icon, tone = "default", loading }: { title: string; value: string | number; sub?: string; icon?: ReactNode; tone?: "default" | "warning" | "danger" | "success"; loading?: boolean }) {
  const toneCls = {
    default: "text-primary bg-primary/10",
    warning: "text-amber-600 bg-amber-100",
    danger: "text-red-600 bg-red-100",
    success: "text-emerald-600 bg-emerald-100",
  }[tone];
  return (
    <Card className="shadow-sm">
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
