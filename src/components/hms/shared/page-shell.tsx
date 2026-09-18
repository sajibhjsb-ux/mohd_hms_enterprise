"use client";

// MOHD.HMS ENTERPRISE — PageShell: consistent chrome for every dedicated page
// (create / detail / edit / manage). Per navigation architecture:
//   ← Back to {list}        (clear back action)
//   List / Sub / Current    (breadcrumbs — links navigate normally)
//   Title + description     (+ right-side actions, e.g. Save Draft / Create)
//
// Back links and breadcrumbs are plain hash anchors: navigation flows through
// the central router so the unsaved-changes guard applies automatically.

import { PageHeader } from "@/components/hms/shared/ui-bits";
import { cn } from "@/lib/utils";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

export type Crumb = { label: string; href?: string };

type Props = {
  /** e.g. "Back to Complaints" — rendered as the prominent back row. */
  backLabel?: string;
  backHref?: string;
  /** Breadcrumb trail, first = list page. Last crumb renders as current page. */
  crumbs?: Crumb[];
  title: string;
  description?: string;
  /** Right-side header actions (Save Draft, Create, Print…). */
  actions?: ReactNode;
  /** Extra classes on the root wrapper. */
  className?: string;
  children: ReactNode;
};

export function PageShell({ backLabel, backHref, crumbs, title, description, actions, className, children }: Props) {
  return (
    <div className={cn("space-y-4", className)} data-page-shell>
      {(backHref || (crumbs && crumbs.length > 0)) && (
        <div className="flex flex-col gap-1.5 no-print">
          {backHref ? (
            <a
              href={backHref}
              className="inline-flex items-center gap-1.5 self-start text-sm text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring -ml-0.5 px-0.5 min-h-[32px]"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {backLabel ?? "Back"}
            </a>
          ) : null}
          {crumbs && crumbs.length > 0 ? (
            <nav aria-label="Breadcrumb" className="flex items-center flex-wrap gap-1 text-xs text-muted-foreground">
              {crumbs.map((c, i) => {
                const last = i === crumbs.length - 1;
                return (
                  <span key={`${c.label}-${i}`} className="inline-flex items-center gap-1">
                    {i > 0 ? <ChevronRight className="h-3 w-3 opacity-60" aria-hidden /> : null}
                    {c.href && !last ? (
                      <a href={c.href} className="hover:text-foreground hover:underline underline-offset-2 transition-colors">
                        {c.label}
                      </a>
                    ) : (
                      <span className={cn(last && "text-foreground font-medium")} aria-current={last ? "page" : undefined}>
                        {c.label}
                      </span>
                    )}
                  </span>
                );
              })}
            </nav>
          ) : null}
        </div>
      )}

      <PageHeader title={title} subtitle={description} actions={actions} />
      {children}
    </div>
  );
}
