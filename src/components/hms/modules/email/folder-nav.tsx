"use client";

// MOHD.HMS ENTERPRISE — Email client folder navigation (§6/§7).
//
// Two variants of the SAME navigation vocabulary:
//   • "sidebar" — desktop pane: full-width Compose action on top, folder rows
//     with live counts, then a read-only Mailboxes section (address + kind).
//   • "chips"   — mobile: a horizontally scrollable chip row above the list.
//
// HONEST STATES: counts come from the bootstrap payload only — nothing is
// invented. When no mailbox is assigned the caller renders its own empty card
// (this component simply renders no mailbox rows).

import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  Archive,
  Clock,
  FileText,
  Inbox,
  Mailbox as MailboxIcon,
  PenLine,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { navigateTo } from "@/lib/hms/router";
import { cn } from "@/lib/utils";
import { MAIL_FOLDER_LABELS, type Bootstrap } from "./types";

const FOLDER_ICONS: Record<string, LucideIcon> = {
  INBOX: Inbox,
  STARRED: Star,
  IMPORTANT: AlertCircle,
  SENT: Send,
  DRAFTS: FileText,
  OUTBOX: Clock,
  ARCHIVE: Archive,
  SPAM: ShieldAlert,
  TRASH: Trash2,
};

/** Canonical display order (spec §7). */
export const FOLDER_ORDER = [
  "INBOX",
  "STARRED",
  "IMPORTANT",
  "SENT",
  "DRAFTS",
  "OUTBOX",
  "ARCHIVE",
  "SPAM",
  "TRASH",
] as const;

function countFor(bootstrap: Bootstrap | null, folder: string): number {
  if (!bootstrap) return 0;
  return bootstrap.counts[folder] ?? 0;
}

export function FolderNav({
  bootstrap,
  loading = false,
  activeFolder,
  onFolderChange,
  variant = "sidebar",
}: {
  bootstrap: Bootstrap | null;
  loading?: boolean;
  activeFolder: string;
  onFolderChange: (folder: string) => void;
  variant?: "sidebar" | "chips";
}) {
  if (variant === "chips") {
    return (
      <nav aria-label="Mail folders" className="flex items-center gap-1.5 overflow-x-auto py-0.5">
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => navigateTo("email", ["compose"])}
          aria-label="Compose email"
        >
          <PenLine className="h-4 w-4" aria-hidden /> Compose
        </Button>
        {FOLDER_ORDER.map((folder) => {
          const Icon = FOLDER_ICONS[folder] ?? Inbox;
          const active = activeFolder === folder;
          const count = countFor(bootstrap, folder);
          return (
            <button
              key={folder}
              type="button"
              onClick={() => onFolderChange(folder)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
                active
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "border-border bg-card text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {MAIL_FOLDER_LABELS[folder] ?? folder}
              {count > 0 ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[11px] leading-4 tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-muted text-foreground"
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Mail folders" className="flex flex-col gap-1">
      <Button className="w-full" onClick={() => navigateTo("email", ["compose"])}>
        <PenLine className="h-4 w-4" aria-hidden /> Compose
      </Button>

      <div className="mt-2 flex flex-col gap-0.5">
        {loading
          ? FOLDER_ORDER.slice(0, 6).map((f) => <Skeleton key={f} className="h-9 w-full" />)
          : FOLDER_ORDER.map((folder) => {
              const Icon = FOLDER_ICONS[folder] ?? Inbox;
              const active = activeFolder === folder;
              const count = countFor(bootstrap, folder);
              return (
                <button
                  key={folder}
                  type="button"
                  onClick={() => onFolderChange(folder)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-foreground/80 hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1 truncate text-left">
                    {MAIL_FOLDER_LABELS[folder] ?? folder}
                  </span>
                  {count > 0 ? (
                    <Badge
                      variant={folder === "INBOX" ? "default" : "secondary"}
                      className="h-5 min-w-5 justify-center px-1.5 text-[11px] tabular-nums"
                    >
                      {count > 99 ? "99+" : count}
                    </Badge>
                  ) : null}
                </button>
              );
            })}
      </div>

      {bootstrap && bootstrap.mailboxes.length > 0 ? (
        <div className="mt-3 border-t pt-3">
          <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Mailboxes
          </p>
          <ul className="flex flex-col gap-1.5">
            {bootstrap.mailboxes.map((mb) => (
              <li key={mb.id} className="min-w-0 px-3">
                <div className="flex items-center gap-2">
                  <MailboxIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs" title={mb.email}>
                    {mb.email}
                  </span>
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 px-1 py-0 text-[10px] leading-4 text-muted-foreground"
                  >
                    {mb.kind}
                  </Badge>
                </div>
                {mb.displayName ? (
                  <p className="truncate pl-5 text-[11px] text-muted-foreground">{mb.displayName}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
