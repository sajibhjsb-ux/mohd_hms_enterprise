"use client";

// MOHD.HMS ENTERPRISE — reusable workflow timeline (§40/§41).
// Renders the full history of one business record from the authoritative audit
// trail (human actions AND system automation, §38/§39). Used across Complaints,
// Work Orders, Quotations, Invoices, Purchases and IRMS inspection reports.
// Four states handled (loading / empty / error / success); hides itself when the
// viewer lacks audit.read (portal users) instead of showing an error.

import { useEffect, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { humanize } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Bot, CircleUser, Clock, History } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type TimelineEntry = {
  id: string;
  action: string;
  actorName: string | null;
  actorEmail: string;
  createdAt: string;
  metadata: unknown;
};

function isSystemActor(entry: TimelineEntry): boolean {
  const email = entry.actorEmail.toUpperCase();
  return !entry.actorName && (email === "SYSTEM" || email === "");
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function WorkflowTimeline({
  resourceType,
  resourceId,
  title = "Workflow history",
  className,
}: {
  resourceType: string;
  resourceId: string;
  title?: string;
  className?: string;
}) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [failed, setFailed] = useState<"none" | "forbidden" | "error">("none");

  useEffect(() => {
    let cancelled = false;
    // Reset + fetch (async callbacks perform the state updates, not the effect body).
    const reset = () => {
      setEntries(null);
      setFailed("none");
    };
    queueMicrotask(reset);
    api
      .get<TimelineEntry[]>(`/api/v1/audit-logs?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}&pageSize=100`)
      .then((res) => {
        if (!cancelled) setEntries(res.data ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setFailed(msg.toLowerCase().includes("permission") ? "forbidden" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [resourceType, resourceId]);

  if (failed === "forbidden") return null; // no audit.read → no history section

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4 text-primary" aria-hidden />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries === null && !failed ? (
          <div className="space-y-3" data-testid="timeline-loading">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
            ))}
          </div>
        ) : failed === "error" ? (
          <p role="alert" className="text-sm text-destructive">History could not be loaded. Please try again later.</p>
        ) : (entries ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No recorded activity yet.</p>
        ) : (
          <ol className="relative space-y-4 border-l border-border/70 pl-5" data-testid="workflow-timeline">
            {(entries ?? []).map((entry) => {
              const system = isSystemActor(entry);
              return (
                <li key={entry.id} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -left-[30px] flex h-6 w-6 items-center justify-center rounded-full border",
                      system ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"
                    )}
                  >
                    {system ? <Bot className="h-3.5 w-3.5" /> : <CircleUser className="h-3.5 w-3.5" />}
                  </span>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className={cn("text-sm font-medium", system && "text-primary")}>{humanize(entry.action)}</span>
                    {system ? (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">System</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{entry.actorName || entry.actorEmail}</span>
                    )}
                  </div>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" aria-hidden />
                    {formatWhen(entry.createdAt)}
                  </p>
                  {metadataHint(entry.metadata) ? (
                    <p className="mt-0.5 text-xs text-muted-foreground/90">{metadataHint(entry.metadata)}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

/** Small human-readable hint from audit metadata (code, status changes…). */
function metadataHint(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object") return "";
  const m = metadata as Record<string, unknown>;
  const bits: string[] = [];
  if (typeof m.code === "string") bits.push(m.code);
  if (typeof m.invoiceCode === "string") bits.push(`Invoice ${m.invoiceCode}`);
  if (typeof m.workOrderCode === "string") bits.push(`WO ${m.workOrderCode}`);
  if (typeof m.complaintCode === "string") bits.push(`Complaint ${m.complaintCode}`);
  if (typeof m.fromStatus === "string" && typeof m.toStatus === "string") bits.push(`${m.fromStatus} → ${m.toStatus}`);
  if (typeof m.error === "string") bits.push(`Error: ${m.error}`);
  return bits.join(" · ");
}
