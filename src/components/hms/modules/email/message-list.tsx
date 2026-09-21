"use client";

// MOHD.HMS ENTERPRISE — Email message list (§7/§21).
//
// One folder's messages with server-side search + flag filters, star toggles,
// Outbox delivery badges (QUEUED/RETRYING/FAILED/CANCELED — real EmailLog
// state), Draft badges, hover quick-actions and "load older" pagination.
// All data comes from GET /api/v1/email/client/messages (25/page, scoped
// server-side to the user's mailboxes) — nothing is filtered or invented here.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Clock3,
  Loader2,
  Paperclip,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { ErrorState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { navigateTo } from "@/lib/hms/router";
import { MAIL_FOLDER_LABELS, type Bootstrap, type MessageListItem, type MessageListResult } from "./types";

export type MessageFlag = "all" | "unread" | "starred" | "hasAttachment";

const FLAGS: { key: MessageFlag; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "starred", label: "Starred" },
  { key: "hasAttachment", label: "Attachments" },
];

/** Relative date: today → HH:mm, this year → dd MMM, else dd MMM yyyy. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(d);
}

/** Rows in OUT-direction folders address the recipient, not the sender. */
function primaryParty(m: MessageListItem): string {
  if (["SENT", "OUTBOX", "DRAFTS"].includes(m.folder)) {
    const first = m.toEmail.split(",")[0]?.trim();
    return first ? `To: ${first}` : "To: (no recipient)";
  }
  return m.fromName || m.fromEmail || "(unknown sender)";
}

function OutboxStatus({ message, onRetry }: { message: MessageListItem; onRetry: (m: MessageListItem) => void }) {
  if (message.folder !== "OUTBOX") return null;
  switch (message.status) {
    case "RETRYING":
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600">
          <Clock3 className="h-3 w-3" aria-hidden />
          Retrying ({message.attempts})
        </span>
      );
    case "FAILED":
      return (
        <span className="inline-flex items-center gap-1">
          <span
            className="inline-flex max-w-[120px] items-center truncate rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
            title={message.lastError || "Delivery failed"}
          >
            Failed
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(message);
            }}
            aria-label={`Retry delivery of ${message.subject || "(no subject)"}`}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
          </button>
        </span>
      );
    case "CANCELED":
      return (
        <span className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Canceled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
          {message.status === "SENDING" ? "Sending" : "Queued"}
        </span>
      );
  }
}

export function MessageList({
  folder,
  search,
  onSearchChange,
  flag,
  onFlagChange,
  bootstrap,
  selectedId,
  onSelect,
  onChanged,
  refreshKey,
}: {
  folder: string;
  search: string;
  onSearchChange: (q: string) => void;
  flag: MessageFlag;
  onFlagChange: (f: MessageFlag) => void;
  bootstrap: Bootstrap | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
  refreshKey: number;
}) {
  const { toast } = useToast();
  const [input, setInput] = useState(search);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const seqRef = useRef(0);

  // Debounce the search box into the committed (server-side) search value.
  useEffect(() => {
    const t = setTimeout(() => onSearchChange(input.trim()), 400);
    return () => clearTimeout(t);
  }, [input, onSearchChange]);

  const fetchPage = useCallback(
    async (p: number, append: boolean) => {
      const seq = ++seqRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      if (!append) setError(null);
      try {
        const res = await api.get<MessageListResult>(
          `/api/v1/email/client/messages${qs({
            folder,
            q: search || undefined,
            flag: flag !== "all" ? flag : undefined,
            page: p,
          })}`
        );
        if (seq !== seqRef.current) return; // a newer request superseded this one
        setMessages((prev) => (append ? [...prev, ...res.data.messages] : res.data.messages));
        setTotal(res.data.total);
        setPageSize(res.data.pageSize);
        setPage(res.data.page);
      } catch (e) {
        if (seq !== seqRef.current) return;
        if (!append) setError(e instanceof Error ? e.message : "Unable to load emails.");
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [folder, search, flag]
  );

  // Fresh fetch on folder / search / flag / external-refresh change (page resets).
  useEffect(() => {
    void fetchPage(1, false);
  }, [fetchPage, refreshKey]);

  const loadOlder = () => void fetchPage(page + 1, true);

  const toggleStar = async (m: MessageListItem) => {
    setActingId(m.id);
    try {
      await api.patch(`/api/v1/email/client/messages/${m.id}`, { action: m.starred ? "unstar" : "star" });
      setMessages((prev) => prev.map((r) => (r.id === m.id ? { ...r, starred: !r.starred } : r)));
      onChanged();
    } catch (e) {
      toast({
        title: "Could not update the star",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setActingId(null);
    }
  };

  const retryDelivery = async (m: MessageListItem) => {
    setActingId(m.id);
    try {
      await api.post(`/api/v1/email/client/messages/${m.id}/retry`);
      toast({ title: "Email re-queued", description: "The delivery worker will pick it up shortly." });
      onChanged();
      void fetchPage(1, false);
    } catch (e) {
      toast({
        title: "Retry failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setActingId(null);
    }
  };

  const quickAction = async (m: MessageListItem, action: "archive" | "trash") => {
    setActingId(m.id);
    try {
      await api.patch(`/api/v1/email/client/messages/${m.id}`, { action });
      setMessages((prev) => prev.filter((r) => r.id !== m.id));
      setTotal((t) => Math.max(0, t - 1));
      onChanged();
      if (selectedId === m.id) onSelect(null); // reading pane entry is gone
    } catch (e) {
      toast({
        title: "Action failed",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setActingId(null);
    }
  };

  const openRow = (m: MessageListItem) => {
    if (m.folder === "DRAFTS") {
      navigateTo("email", ["compose"], { draft: m.id });
      return;
    }
    onSelect(m.id);
  };

  const isEmpty = !loading && !error && messages.length === 0;
  const searching = input.trim().length > 0 || flag !== "all";

  return (
    <div className="flex h-full flex-col">
      {/* Search + flag filters */}
      <div className="border-b p-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            aria-label="Search email"
            placeholder="Search subject, body, people…"
            className="h-9 pl-8 pr-8"
          />
          {input ? (
            <button
              type="button"
              onClick={() => setInput("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1" role="group" aria-label="Filter messages">
          {FLAGS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => onFlagChange(f.key)}
              aria-pressed={flag === f.key}
              className={cn(
                "min-h-[32px] rounded-full border px-2.5 text-xs transition-colors",
                flag === f.key
                  ? "border-primary/40 bg-primary/10 font-medium text-primary"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
          {total > 0 ? (
            <span className="ml-auto text-xs text-muted-foreground" aria-live="polite">
              {total} email{total === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>

      {/* Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label={`${MAIL_FOLDER_LABELS[folder] ?? folder} messages`}>
        {loading ? (
          <div className="space-y-px p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="space-y-1.5 rounded-md p-3">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-64" />
                <Skeleton className="h-3 w-full max-w-[80%]" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="p-3">
            <ErrorState message={error} onRetry={() => void fetchPage(1, false)} />
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            {folder === "INBOX" && !searching ? (
              <>
                <p className="font-medium">No received email yet</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {bootstrap?.inbound.detail ??
                    "This inbox will fill as soon as inbound email retrieval is configured."}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">{searching ? "No matching emails" : `Nothing in ${MAIL_FOLDER_LABELS[folder] ?? folder}`}</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                  {searching ? "Try a different search term or filter." : "Emails will appear here as they arrive."}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y">
            {messages.map((m) => {
              const unread = !m.readAt;
              const selected = selectedId === m.id;
              const canArchive = !["ARCHIVE", "TRASH", "DRAFTS", "OUTBOX"].includes(m.folder);
              return (
                <div
                  key={m.id}
                  role="listitem"
                  className={cn(
                    "group relative",
                    selected ? "bg-primary/[0.06]" : "hover:bg-accent/50",
                    actingId === m.id && "opacity-60"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => openRow(m)}
                    className="block w-full px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                    aria-label={`${unread ? "Unread email" : "Email"} from ${primaryParty(m)}: ${m.subject || "(no subject)"}`}
                  >
                    <div className="flex items-start gap-2">
                      {unread ? (
                        <span
                          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                          aria-hidden
                          title="Unread"
                        />
                      ) : (
                        <span className="mt-1.5 w-2 shrink-0" aria-hidden />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className={cn("truncate text-sm", unread ? "font-semibold text-foreground" : "text-foreground/90")}>
                          {primaryParty(m)}
                        </p>
                        <p
                          className={cn(
                            "truncate text-sm",
                            unread ? "font-semibold text-foreground" : "text-foreground/70",
                            !m.subject && "italic text-muted-foreground"
                          )}
                        >
                          {m.subject || "(no subject)"}
                        </p>
                        {m.preview ? (
                          <p className="truncate text-xs text-muted-foreground">{m.preview}</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                          {shortDate(m.sentAt ?? m.createdAt)}
                        </span>
                        <span className="flex items-center gap-1.5">
                          {m.folder === "DRAFTS" ? (
                            <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                              Draft
                            </span>
                          ) : null}
                          <OutboxStatus message={m} onRetry={(x) => void retryDelivery(x)} />
                          {m.hasAttachments ? (
                            <Paperclip className="h-3 w-3 text-muted-foreground" aria-label="Has attachments" />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </button>

                  {/* Star (always reachable) + hover quick actions */}
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 bg-card/95 pl-1 shadow-sm group-hover:bg-accent/95">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (actingId !== m.id) void toggleStar(m);
                      }}
                      aria-label={m.starred ? `Unstar ${m.subject || "(no subject)"}` : `Star ${m.subject || "(no subject)"}`}
                      aria-pressed={m.starred}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <Star className={cn("h-4 w-4", m.starred && "fill-current text-primary")} aria-hidden />
                    </button>
                    {canArchive ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (actingId !== m.id) void quickAction(m, "archive");
                        }}
                        aria-label={`Archive ${m.subject || "(no subject)"}`}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
                      >
                        <Archive className="h-4 w-4" aria-hidden />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (actingId !== m.id) void quickAction(m, "trash");
                      }}
                      aria-label={`Move ${m.subject || "(no subject)"} to Trash`}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              );
            })}

            {messages.length < total ? (
              <div className="p-3 text-center">
                <Button variant="ghost" size="sm" disabled={loadingMore} onClick={loadOlder}>
                  {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                  Load {Math.min(total - messages.length, pageSize)} older email
                  {total - messages.length === 1 ? "" : "s"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
