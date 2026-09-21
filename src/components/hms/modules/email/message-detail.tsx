"use client";

// MOHD.HMS ENTERPRISE — Email message detail (§15/§22–§27).
//
// MessageDetailPage  — dedicated full page for mobile + deep links (the
//                      MAIL_MESSAGE notification route lands here).
// MessageDetailView  — the same reader embedded in the desktop reading pane.
//
// The message body is rendered inside a SANDBOXED IFRAME (sandbox="",
// srcDoc + base styles) — the exact technique the Email Configuration logs
// viewer uses; untrusted HTML can never touch the application DOM. Attachment
// downloads are plain cookie-authenticated <a> links (server streams with
// attachment disposition). Every successful action reports back through
// onChanged?.() so the parent refreshes counts + list.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Clock3,
  Download,
  FileText,
  FolderInput,
  Forward,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Reply,
  ReplyAll,
  ShieldAlert,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { PageHeader, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { navigateTo } from "@/lib/hms/router";
import { cn } from "@/lib/utils";
import { MAIL_FOLDER_LABELS, type MessageDetail } from "./types";

// ─── helpers ────────────────────────────────────────────────────────────────

function fullDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(d);
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitAddresses(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function statusTone(status: string): string {
  switch (status) {
    case "QUEUED":
      return "border-amber-200 bg-amber-100 text-amber-800";
    case "RETRYING":
    case "SENDING":
      return "border-amber-300 text-amber-800";
    case "FAILED":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    default:
      return "text-muted-foreground"; // CANCELED + unknown
  }
}

/** Sandboxed body frame — same technique as email-config/email-logs.tsx:
 *  sandbox="" (no scripts, opaque origin), srcDoc with base styles; dynamic
 *  height via contentDocument scrollHeight when accessible, capped 1200px. */
function SanitizedBodyFrame({ html, subject }: { html: string; subject: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(420);

  const handleLoad = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      const h = doc?.body?.scrollHeight ?? doc?.documentElement?.scrollHeight ?? 0;
      if (h > 0) setHeight(Math.min(1200, Math.max(180, h + 24)));
    } catch {
      /* sandboxed frame — the fixed fallback height stays */
    }
  };

  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8"><base target="_blank">` +
    `<style>html,body{margin:0;padding:12px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;` +
    `font-size:14px;line-height:1.55;color:#1f2937;word-break:break-word;}` +
    `img{max-width:100%;height:auto;}a{color:#0f766e;}</style></head>` +
    `<body>${html}</body></html>`;

  return (
    <iframe
      ref={frameRef}
      title={`Message body — ${subject}`}
      sandbox=""
      srcDoc={srcDoc}
      loading="lazy"
      onLoad={handleLoad}
      className="w-full rounded-md border bg-white"
      style={{ height }}
    />
  );
}

function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── dedicated page (mobile / deep links) ───────────────────────────────────

export function MessageDetailPage({ messageId }: { messageId: string }) {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigateTo("email", [])}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back
          </Button>
        }
      />
      <MessageDetailView
        messageId={messageId}
        onNavigate={(seg, query) => navigateTo("email", seg, query)}
      />
    </div>
  );
}

// ─── the reader (shared by page + reading pane) ─────────────────────────────

export function MessageDetailView({
  messageId,
  onChanged,
  onNavigate,
}: {
  messageId: string;
  onChanged?: () => void;
  onNavigate?: (seg: string[], query?: Record<string, string>) => void;
}) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"spam" | "purge" | null>(null);
  const readAppliedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    setError(null);
    try {
      const res = await api.get<MessageDetail>(`/api/v1/email/client/messages/${messageId}`);
      setDetail(res.data);
      // Reading an INBOX email marks it read server-side (§15).
      if (!res.data.readAt && res.data.folder === "INBOX" && !readAppliedRef.current) {
        readAppliedRef.current = true;
        try {
          await api.patch(`/api/v1/email/client/messages/${messageId}`, { action: "read" });
          setDetail((prev) => (prev ? { ...prev, readAt: new Date().toISOString() } : prev));
          onChanged?.();
        } catch {
          /* read receipt is best-effort — the email still renders */
        }
      }
    } catch (e) {
      if (e instanceof ClientApiError && e.status === 404) setNotFound(true);
      else setError(e instanceof Error ? e.message : "Unable to load this email.");
    } finally {
      setLoading(false);
    }
  }, [messageId, onChanged]);

  useEffect(() => {
    readAppliedRef.current = false;
    void load();
  }, [load]);

  /** Persist an action, refresh the detail and tell the parent. */
  const act = useCallback(
    async (action: string, targetFolder?: string, opts?: { silent?: boolean }) => {
      setBusy(true);
      try {
        await api.patch(`/api/v1/email/client/messages/${messageId}`, {
          action,
          ...(targetFolder ? { folder: targetFolder } : {}),
        });
        await load();
        onChanged?.();
        return true;
      } catch (e) {
        if (!opts?.silent) {
          toast({
            title: "Action failed",
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          });
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    [messageId, load, onChanged, toast]
  );

  const go = useCallback(
    (seg: string[], query?: Record<string, string>) => {
      if (onNavigate) onNavigate(seg, query);
      else navigateTo("email", seg, query);
    },
    [onNavigate]
  );

  if (loading) {
    return (
      <div className="space-y-4 p-4" role="status" aria-label="Loading email">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Separator />
        <LoadingState label="Loading email…" rows={4} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="p-4">
        <ErrorState message="Email not found or no longer accessible." onRetry={() => void load()} />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="p-4">
        <ErrorState message={error ?? "Unable to load this email."} onRetry={() => void load()} />
      </div>
    );
  }

  const folder = detail.folder;
  const isDraft = folder === "DRAFTS";
  const starred = detail.starred;
  const important = detail.important;
  const toChips = splitAddresses(detail.toEmail);
  const ccChips = splitAddresses(detail.ccEmail);
  const bccChips = splitAddresses(detail.bccEmail);
  const failedOutbox = folder === "OUTBOX" && detail.status === "FAILED";
  const isTrashed = folder === "TRASH";
  const canReply = !isDraft;
  const canArchive = !["ARCHIVE", "TRASH", "DRAFTS", "OUTBOX"].includes(folder);
  const canSpam = !["SPAM", "TRASH", "DRAFTS"].includes(folder);
  const canMove = !isDraft && !isTrashed;

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.del(`/api/v1/email/client/messages/${messageId}`);
      onChanged?.();
      go([]); // back to the list (Trash row vanished or moved to Trash)
    } catch (e) {
      toast({
        title: "Could not delete the email",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const doPurge = async () => {
    setBusy(true);
    try {
      await api.del(`/api/v1/email/client/messages/${messageId}?permanent=1`);
      toast({ title: "Email permanently deleted" });
      onChanged?.();
      go([]);
    } catch (e) {
      toast({
        title: "Could not delete the email",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const doRetry = async () => {
    setBusy(true);
    try {
      await api.post(`/api/v1/email/client/messages/${messageId}/retry`);
      toast({ title: "Email re-queued", description: "The delivery worker will pick it up shortly." });
      await load();
      onChanged?.();
    } catch (e) {
      toast({
        title: "Retry failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="space-y-4 p-4">
      {/* Header block */}
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1
            className={cn(
              "min-w-0 flex-1 text-lg font-semibold leading-snug",
              !detail.subject && "italic text-muted-foreground"
            )}
          >
            {detail.subject || "(no subject)"}
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={starred ? "Unstar this email" : "Star this email"}
              aria-pressed={starred}
              disabled={busy}
              onClick={() => void act(starred ? "unstar" : "star", undefined, { silent: true })}
              className="h-9 w-9 text-muted-foreground hover:text-foreground"
            >
              <Star className={cn("h-4 w-4", starred && "fill-current text-primary")} aria-hidden />
            </Button>
            {!isDraft ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={important ? "Mark as normal priority" : "Mark as important"}
                aria-pressed={important}
                disabled={busy}
                onClick={() => void act(important ? "normal" : "important", undefined, { silent: true })}
                className="h-9 w-9 text-muted-foreground hover:text-foreground"
              >
                <AlertCircle
                  className={cn("h-4 w-4", important && "fill-current text-amber-600")}
                  aria-hidden
                />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="text-[11px]">
            {MAIL_FOLDER_LABELS[folder] ?? folder}
          </Badge>
          {isDraft ? (
            <>
              <Badge variant="secondary" className="text-[11px]">
                Draft
              </Badge>
              <Button size="sm" className="h-8" onClick={() => go(["compose"], { draft: detail.id })}>
                <FileText className="h-3.5 w-3.5" aria-hidden /> Edit draft
              </Button>
            </>
          ) : null}
          {folder === "OUTBOX" ? (
            <>
              <Badge variant="outline" className={cn("text-[11px]", statusTone(detail.status))}>
                {detail.status === "SENDING" ? "SENDING" : detail.status}
              </Badge>
              {detail.lastError ? (
                <span className="max-w-full truncate text-xs text-amber-600" title={detail.lastError}>
                  {detail.lastError}
                </span>
              ) : null}
              {failedOutbox ? (
                <Button size="sm" variant="outline" className="h-8" disabled={busy} onClick={() => void doRetry()}>
                  <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} aria-hidden /> Retry
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {/* Address block */}
      <section aria-label="Addresses" className="space-y-1 text-sm">
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-xs text-muted-foreground">From</span>
          <span className="font-medium">
            {detail.fromName ? `${detail.fromName} ` : ""}
            <span className="text-muted-foreground">&lt;{detail.fromEmail}&gt;</span>
          </span>
        </p>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          <span className="text-xs text-muted-foreground">To</span>
          <span className="flex flex-wrap gap-1">
            {toChips.length === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              toChips.map((a) => (
                <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                  {a}
                </span>
              ))
            )}
          </span>
        </div>
        {ccChips.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="text-xs text-muted-foreground">Cc</span>
            <span className="flex flex-wrap gap-1">
              {ccChips.map((a) => (
                <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                  {a}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        {bccChips.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="text-xs text-muted-foreground">Bcc</span>
            <span className="flex flex-wrap gap-1">
              {bccChips.map((a) => (
                <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 text-xs">
                  {a}
                </span>
              ))}
            </span>
          </div>
        ) : null}
        <p className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-xs text-muted-foreground">Date</span>
          <span className="text-muted-foreground">{fullDate(detail.sentAt ?? detail.createdAt)}</span>
        </p>
      </section>

      {/* Attachments */}
      {detail.attachments.length > 0 ? (
        <section aria-label="Attachments" className="flex flex-wrap items-center gap-2">
          <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          {detail.attachments.map((att) => (
            <a
              key={att.id}
              href={`/api/v1/email/client/messages/${detail.id}/attachments/${att.id}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Download attachment ${att.filename} (${fmtBytes(att.sizeBytes)})`}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="max-w-[220px] truncate">{att.filename}</span>
              <span className="shrink-0 text-muted-foreground">{fmtBytes(att.sizeBytes)}</span>
              <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </a>
          ))}
        </section>
      ) : null}

      {/* Conversation thread */}
      {detail.thread.length > 1 ? (
        <section aria-label="Conversation" className="rounded-lg border">
          <p className="border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            Conversation ({detail.thread.length})
          </p>
          <ul className="divide-y">
            {detail.thread.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  disabled={t.isCurrent}
                  onClick={() => (t.isCurrent ? undefined : go(["m", t.id]))}
                  className={cn(
                    "block w-full px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                    t.isCurrent
                      ? "bg-primary/[0.06]"
                      : "hover:bg-accent/60 focus-visible:ring-0"
                  )}
                  aria-label={
                    t.isCurrent
                      ? `Current email from ${t.fromName || t.fromEmail}`
                      : `Open email from ${t.fromName || t.fromEmail}: ${t.subject || "(no subject)"}`
                  }
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-xs font-medium">
                      {t.fromName || t.fromEmail}
                      {t.fromName ? <span className="font-normal text-muted-foreground"> ({t.fromEmail})</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{shortDate(t.createdAt)}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">{t.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Body — sandboxed iframe, never injected into the app DOM */}
      <section aria-label="Message body">
        {detail.bodyHtml ? (
          <SanitizedBodyFrame html={detail.bodyHtml} subject={detail.subject || "(no subject)"} />
        ) : detail.bodyText ? (
          <div className="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">
            {detail.bodyText}
          </div>
        ) : (
          <p className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            This email has no body content.
          </p>
        )}
      </section>

      {/* Action toolbar */}
      <section aria-label="Actions" className="flex flex-wrap items-center gap-2 border-t pt-3">
        {canReply ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => go(["compose"], { reply: detail.id })}
            >
              <Reply className="h-3.5 w-3.5" aria-hidden /> Reply
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => go(["compose"], { replyAll: detail.id })}
            >
              <ReplyAll className="h-3.5 w-3.5" aria-hidden /> Reply all
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => go(["compose"], { forward: detail.id })}
            >
              <Forward className="h-3.5 w-3.5" aria-hidden /> Forward
            </Button>
          </>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void act(starred ? "unstar" : "star")}
        >
          <Star className={cn("h-3.5 w-3.5", starred && "fill-current text-primary")} aria-hidden />
          {starred ? "Unstar" : "Star"}
        </Button>

        {detail.readAt && !isDraft ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const okFlag = await act("unread");
              if (okFlag) {
                onChanged?.();
                go([]); // back to the list — the unread row is visible there
              }
            }}
          >
            <Mail className="h-3.5 w-3.5" aria-hidden /> Mark unread
          </Button>
        ) : (
          !isDraft && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("read")}>
              <MailOpen className="h-3.5 w-3.5" aria-hidden /> Mark read
            </Button>
          )
        )}

        {!isDraft ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void act(important ? "normal" : "important")}
          >
            <AlertCircle className={cn("h-3.5 w-3.5", important && "fill-current text-amber-600")} aria-hidden />
            {important ? "Normal" : "Important"}
          </Button>
        ) : null}

        {canArchive ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("archive")}>
            <Archive className="h-3.5 w-3.5" aria-hidden /> Archive
          </Button>
        ) : null}

        {canSpam ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm("spam")}>
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Spam
          </Button>
        ) : null}

        {isTrashed ? (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("restore")}>
            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Restore
          </Button>
        ) : canMove ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={busy}>
                <FolderInput className="h-3.5 w-3.5" aria-hidden /> Move to…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Move to folder</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(["ARCHIVE", "SPAM", "TRASH"] as const).map((target) => (
                <DropdownMenuItem
                  key={target}
                  disabled={folder === target}
                  onClick={() => void act("move", target)}
                >
                  {MAIL_FOLDER_LABELS[target]}
                  {folder === target ? " (current)" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => (isTrashed ? setConfirm("purge") : void doDelete())}
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
        </Button>
      </section>

      {confirm === "spam" ? (
        <ConfirmDialog
          open
          busy={busy}
          title="Mark as spam?"
          body="The email moves to the Spam folder. You can restore it later from there."
          confirmLabel="Mark as spam"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act("spam").then(() => setConfirm(null))}
        />
      ) : null}

      {confirm === "purge" ? (
        <ConfirmDialog
          open
          busy={busy}
          title="Permanently delete this email?"
          body="This email is already in Trash. Permanent deletion also removes its attachments from storage — this cannot be undone."
          confirmLabel="Delete permanently"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doPurge()}
        />
      ) : null}

      {folder === "OUTBOX" && ["QUEUED", "RETRYING", "SENDING"].includes(detail.status) ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Clock3 className="h-3.5 w-3.5" aria-hidden />
          Delivery in progress — the Outbox status updates automatically.
        </p>
      ) : null}
    </article>
  );
}
