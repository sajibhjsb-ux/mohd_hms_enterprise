"use client";

// MOHD.HMS ENTERPRISE — Email module: professional email client (/email).
//
// Three-pane mailbox (folders · list · reading pane) with compose, drafts,
// outbox delivery state, starred/archive/spam/trash, server-side search,
// shared contact groups and attachments. Talks ONLY to
// /api/v1/email/client/* (permission email.client); SMTP administration
// lives in Settings → Email. Bodies render inside a sandboxed iframe and
// arrive pre-sanitized — no scripts, ever.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Archive, ChevronLeft, ChevronRight, Clock4, Forward, Inbox,
  Loader2, Mail, MailOpen, Menu, MoreHorizontal, Paperclip, PenSquare, Pencil,
  Plus, RefreshCw, Reply, ReplyAll, RotateCcw, Search, Send, ShieldAlert, Star,
  Trash2, Users, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ComposeSheet, RecipientField } from "./compose-sheet";
import { parseRefs, type Contact, type ContactGroup, type ComposeInit, type FolderView, type MailDetail, type MailListItem, type MailMeta } from "./types";

// ─── Folder catalog ─────────────────────────────────────────────────────────

const FOLDER_META: Record<FolderView, { label: string; icon: LucideIcon; empty: string }> = {
  INBOX: { label: "Inbox", icon: Inbox, empty: "No mail here. Emails from colleagues and system mailboxes arrive in this inbox." },
  STARRED: { label: "Starred", icon: Star, empty: "Star mail to keep it at your fingertips." },
  SENT: { label: "Sent", icon: Send, empty: "Emails you have sent appear here." },
  DRAFT: { label: "Drafts", icon: Pencil, empty: "Nothing in progress. Unfinished emails are saved here automatically." },
  OUTBOX: { label: "Outbox", icon: Clock4, empty: "No email is waiting for delivery. External deliveries are queued here until SMTP accepts them." },
  ARCHIVE: { label: "Archive", icon: Archive, empty: "Archived mail is kept here, out of your inbox." },
  SPAM: { label: "Spam", icon: ShieldAlert, empty: "No spam. Mail you report lands here." },
  TRASH: { label: "Trash", icon: Trash2, empty: "Trash is empty. Items in trash can be restored or deleted forever." },
};

const FOLDER_ORDER: FolderView[] = ["INBOX", "STARRED", "SENT", "DRAFT", "OUTBOX", "ARCHIVE", "SPAM", "TRASH"];

const AVATAR_TONES = [
  "bg-emerald-100 text-emerald-700", "bg-amber-100 text-amber-700", "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700", "bg-orange-100 text-orange-700", "bg-cyan-100 text-cyan-700",
  "bg-lime-100 text-lime-700", "bg-fuchsia-100 text-fuchsia-700",
];
const GROUP_TONES: Record<string, string> = {
  emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500", teal: "bg-teal-500",
  orange: "bg-orange-500", cyan: "bg-cyan-500", lime: "bg-lime-500", fuchsia: "bg-fuchsia-500",
};

function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function initialsOf(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? "?";
  const b = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (a + b).toUpperCase();
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function splitEmails(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EmailClient() {
  const { user } = useSession();
  const { toast } = useToast();
  const canConfigure = hasPerm(user, PERMISSIONS.email_view);

  const [meta, setMeta] = useState<MailMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [folder, setFolder] = useState<FolderView>("INBOX");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [items, setItems] = useState<MailListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInit, setComposeInit] = useState<ComposeInit | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [groupDlg, setGroupDlg] = useState(false);
  const [editingGroup, setEditingGroup] = useState<ContactGroup | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MailListItem | null>(null);
  const [tick, setTick] = useState(0);

  const bump = useCallback(() => setTick((t) => t + 1), []);

  // ── Data loading ────────────────────────────────────────────────────────
  const loadMeta = useCallback(async () => {
    try {
      const res = await api.get<MailMeta>("/api/v1/email/client/meta");
      setMeta(res.data);
    } catch {
      /* the shell handles auth errors; keep the last known meta */
    } finally {
      setMetaLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMeta();
    const t = setInterval(() => void loadMeta(), 30_000);
    return () => clearInterval(t);
  }, [loadMeta, tick]);

  useEffect(() => {
    api.get<Contact[]>("/api/v1/email/client/contacts").then((r) => setContacts(r.data)).catch(() => undefined);
  }, [tick]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (folder === "STARRED") params.set("starred", "1");
      else params.set("folder", folder);
      if (q) params.set("q", q);
      const res = await api.get<MailListItem[]>(`/api/v1/email/client/messages?${params.toString()}`);
      setItems(res.data);
      setTotal(Number(res.meta?.total ?? res.data.length));
    } catch (e) {
      toast({ title: "Could not load mail", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setListLoading(false);
    }
  }, [folder, q, page, toast]);

  useEffect(() => {
    void loadList();
  }, [loadList, tick]);

  const openMessage = useCallback(async (item: MailListItem) => {
    // Drafts open in the composer, not the reading pane.
    if (item.folder === "DRAFT") {
      openComposeForDraft(item);
      return;
    }
    setSelectedId(item.id);
    setMobileView("detail");
    setDetailLoading(true);
    try {
      const res = await api.get<MailDetail>(`/api/v1/email/client/messages/${item.id}`);
      setDetail(res.data);
      if (!item.readAt) {
        setItems((arr) => arr.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)));
        setMeta((m) => (m && item.folder === "INBOX" ? { ...m, inboxUnread: Math.max(0, m.inboxUnread - 1) } : m));
        void api.patch(`/api/v1/email/client/messages/${item.id}`, { read: true }).catch(() => undefined);
      }
    } catch (e) {
      toast({ title: "Could not open the message", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [toast]);

  // ── Flag / folder actions ───────────────────────────────────────────────
  const toggleStar = async (item: MailListItem) => {
    const next = !item.starredAt;
    setItems((arr) => arr.map((x) => (x.id === item.id ? { ...x, starredAt: next ? new Date().toISOString() : null } : x)));
    if (detail?.id === item.id) setDetail((d) => (d ? { ...d, starredAt: next ? new Date().toISOString() : null } : d));
    try {
      await api.patch(`/api/v1/email/client/messages/${item.id}`, { starred: next });
      bump();
    } catch {
      void loadList();
    }
  };

  const markUnread = async (item: MailListItem) => {
    setItems((arr) => arr.map((x) => (x.id === item.id ? { ...x, readAt: null } : x)));
    try {
      await api.patch(`/api/v1/email/client/messages/${item.id}`, { read: false });
      bump();
    } catch {
      void loadList();
    }
  };

  const moveTo = async (item: MailListItem, target: FolderView) => {
    if (target === "STARRED") return;
    try {
      await api.patch(`/api/v1/email/client/messages/${item.id}`, { folder: target });
      if (detail?.id === item.id) setDetail(null);
      bump();
      if (folder === item.folder || folder === "STARRED") {
        setItems((arr) => arr.filter((x) => x.id !== item.id));
        setTotal((t) => Math.max(0, t - 1));
      }
    } catch (e) {
      toast({ title: "Move failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    }
  };

  const restore = async (item: MailListItem) => {
    const fallback: FolderView = item.direction === "IN" ? "INBOX" : item.status === "SENT" ? "SENT" : "OUTBOX";
    const target = (FOLDER_ORDER.includes(item.originFolder as FolderView) ? item.originFolder : fallback) as FolderView;
    await moveTo(item, target);
  };

  const deleteForever = async (item: MailListItem) => {
    setDeleteTarget(null);
    try {
      await api.del(`/api/v1/email/client/messages/${item.id}`);
      if (detail?.id === item.id) setDetail(null);
      setItems((arr) => arr.filter((x) => x.id !== item.id));
      setTotal((t) => Math.max(0, t - 1));
      bump();
      toast({ title: "Deleted forever" });
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    }
  };

  const deliveryAction = async (item: MailListItem, action: "retry" | "cancel") => {
    try {
      await api.post(`/api/v1/email/client/messages/${item.id}/delivery`, { action });
      toast({ title: action === "retry" ? "Delivery requeued" : "Delivery canceled", description: action === "retry" ? "The email is queued for another attempt." : "The queued email will not be sent." });
      bump();
    } catch (e) {
      toast({ title: "Action failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    }
  };

  // ── Compose builders ────────────────────────────────────────────────────
  const openCompose = (init: ComposeInit) => {
    setComposeInit(init);
    setComposeOpen(true);
  };

  const openComposeForDraft = (item: MailListItem) => {
    void (async () => {
      try {
        const res = await api.get<MailDetail>(`/api/v1/email/client/messages/${item.id}`);
        openCompose({
          mode: "draft",
          draftId: item.id,
          to: splitEmails(res.data.toEmail),
          cc: splitEmails(res.data.ccEmail),
          bcc: splitEmails(res.data.bccEmail),
          subject: res.data.subject,
          bodyHtml: res.data.bodyHtml,
          attachments: res.data.attachments,
          inReplyToId: res.data.inReplyToId || undefined,
        });
      } catch {
        toast({ title: "Could not open the draft", variant: "destructive" });
      }
    })();
  };

  const quoteOf = (d: MailDetail, mode: "reply" | "forward"): string => {
    const when = new Date(d.sentAt ?? d.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    const from = `${escapeHtml(d.fromName || d.fromEmail)} &lt;${escapeHtml(d.fromEmail)}&gt;`;
    if (mode === "forward") {
      return `<p></p><p>---------- Forwarded message ----------<br/>From: ${from}<br/>Date: ${when}<br/>Subject: ${escapeHtml(d.subject || "(no subject)")}<br/>To: ${escapeHtml(d.toEmail)}</p><blockquote>${d.bodyHtml}</blockquote>`;
    }
    return `<p></p><p>On ${when}, ${from} wrote:</p><blockquote>${d.bodyHtml}</blockquote>`;
  };

  const composeReply = (d: MailDetail, all: boolean) => {
    const me = meta?.identity.email.toLowerCase() ?? "";
    const senderEmail = d.direction === "IN" ? d.fromEmail : splitEmails(d.toEmail)[0] ?? "";
    const toList = [senderEmail, ...(all && d.direction === "IN" ? splitEmails(d.toEmail) : [])]
      .map((e) => e.toLowerCase())
      .filter((e, i, arr) => e && e !== me && arr.indexOf(e) === i);
    const ccList = all ? splitEmails(d.ccEmail).map((e) => e.toLowerCase()).filter((e) => e !== me && !toList.includes(e)) : [];
    openCompose({
      mode: all ? "replyAll" : "reply",
      inReplyToId: d.id,
      to: toList,
      cc: ccList,
      bcc: [],
      subject: d.subject.startsWith("Re:") ? d.subject : `Re: ${d.subject || "(no subject)"}`,
      bodyHtml: quoteOf(d, "reply"),
      attachments: [],
    });
  };

  const composeForward = (d: MailDetail) => {
    openCompose({
      mode: "forward",
      to: [],
      cc: [],
      bcc: [],
      subject: d.subject.startsWith("Fwd:") ? d.subject : `Fwd: ${d.subject || "(no subject)"}`,
      bodyHtml: quoteOf(d, "forward"),
      attachments: d.attachments,
    });
  };

  const composeToGroup = (g: ContactGroup) => {
    openCompose({ mode: "new", to: g.members.map((m) => m.email), cc: [], bcc: [], subject: "", bodyHtml: "", attachments: [] });
  };

  // ── Render ──────────────────────────────────────────────────────────────
  const counts = meta?.counts;
  const pageStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageEnd = Math.min(page * pageSize, total);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const sidebar = (
    <SidebarContent
      meta={meta}
      folder={folder}
      onSelect={(f) => {
        setFolder(f);
        setPage(1);
        setSelectedId(null);
        setDetail(null);
        setMobileView("list");
        setSidebarOpen(false);
      }}
      onCompose={() => {
        setSidebarOpen(false);
        openCompose({ mode: "new", to: [], cc: [], bcc: [], subject: "", bodyHtml: "", attachments: [] });
      }}
      onNewGroup={() => { setEditingGroup(null); setGroupDlg(true); setSidebarOpen(false); }}
      onEditGroup={(g) => { setEditingGroup(g); setGroupDlg(true); setSidebarOpen(false); }}
      onComposeGroup={composeToGroup}
      onDeleteGroup={async (g) => {
        try {
          await api.del(`/api/v1/email/client/groups/${g.id}`);
          toast({ title: "Group deleted", description: g.name });
          bump();
        } catch (e) {
          toast({ title: "Could not delete the group", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
        }
      }}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Honest SMTP state banner — configuration lives in Settings → Email */}
      {meta && !meta.smtpConfigured ? (
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <span className="flex-1">
            External delivery is not active — SMTP is not configured. Internal colleagues receive mail normally.{" "}
            {canConfigure ? "Finish the setup in Settings → Email." : "An administrator can finish the setup in Settings → Email."}
          </span>
          {canConfigure ? (
            <Button size="sm" variant="outline" className="border-amber-400 bg-transparent" onClick={() => (window.location.href = "/settings")}>
              Open Settings
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex h-[calc(100dvh-13.5rem)] min-h-[430px] gap-3 lg:h-[calc(100dvh-11rem)]">
        {/* ── Sidebar (xl+) ── */}
        <aside className="hidden xl:flex w-[236px] shrink-0 flex-col rounded-xl border bg-background overflow-y-auto">
          {sidebar}
        </aside>

        {/* ── Message list ── */}
        <section
          className={`min-w-0 flex-col rounded-xl border bg-background ${mobileView === "detail" ? "hidden xl:flex" : "flex"} w-full xl:w-[360px] xl:shrink-0`}
          aria-label="Message list"
        >
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Button variant="ghost" size="icon" className="xl:hidden h-8 w-8" aria-label="Open folders" onClick={() => setSidebarOpen(true)}>
              <Menu className="h-4 w-4" />
            </Button>
            <h2 className="text-sm font-semibold">{FOLDER_META[folder].label}</h2>
            {folder === "INBOX" && meta && meta.inboxUnread > 0 ? (
              <Badge className="h-5 px-1.5 text-[10px]">{meta.inboxUnread} new</Badge>
            ) : null}
            <div className="ml-auto relative w-36 sm:w-52">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search mail"
                className="h-8 pl-7 text-xs"
                aria-label="Search mail"
              />
              {search ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:bg-muted"
                  onClick={() => setSearch("")}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Refresh" onClick={() => { bump(); }}>
              <RefreshCw className={`h-3.5 w-3.5 ${listLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto" role="list">
            {listLoading && items.length === 0 ? (
              <LoadingState label="Loading mail…" />
            ) : items.length === 0 ? (
              <EmptyFolder folder={folder} searching={Boolean(q)} />
            ) : (
              <ul className="divide-y">
                {items.map((item) => (
                  <ListItem
                    key={item.id}
                    item={item}
                    active={item.id === selectedId}
                    onOpen={() => void openMessage(item)}
                    onStar={() => void toggleStar(item)}
                    onArchive={() => void moveTo(item, "ARCHIVE")}
                    onTrash={() => void moveTo(item, "TRASH")}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              {total === 0 ? "0 messages" : `${pageStart}–${pageEnd} of ${total}`}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 1} aria-label="Previous page" onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular-nums">{page}/{totalPages}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages} aria-label="Next page" onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </section>

        {/* ── Reading pane ── */}
        <section className={`min-w-0 flex-1 flex-col rounded-xl border bg-background ${mobileView === "detail" ? "flex" : "hidden xl:flex"}`} aria-label="Reading pane">
          <DetailPane
            detail={detail}
            loading={detailLoading && !detail}
            meta={meta}
            onBack={() => { setMobileView("list"); setSelectedId(null); setDetail(null); }}
            onStar={(d) => void toggleStar(listItemOf(d, items))}
            onArchive={(d) => void moveTo(listItemOf(d, items), "ARCHIVE")}
            onTrash={(d) => void moveTo(listItemOf(d, items), "TRASH")}
            onRestore={(d) => void restore(listItemOf(d, items))}
            onDeleteForever={(d) => setDeleteTarget(listItemOf(d, items))}
            onMarkUnread={(d) => void markUnread(listItemOf(d, items))}
            onReply={(d) => composeReply(d, false)}
            onReplyAll={(d) => composeReply(d, true)}
            onForward={(d) => composeForward(d)}
            onRetry={(d) => void deliveryAction(listItemOf(d, items), "retry")}
            onCancel={(d) => void deliveryAction(listItemOf(d, items), "cancel")}
          />
        </section>
      </div>

      {/* Mobile / tablet sidebar */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="p-0 w-[272px]">
          <SheetHeader className="px-4 py-3 border-b">
            <SheetTitle className="text-sm text-left">Mailboxes</SheetTitle>
          </SheetHeader>
          <div className="h-[calc(100%-3.25rem)] overflow-y-auto">{sidebar}</div>
        </SheetContent>
      </Sheet>

      {/* Compose */}
      <ComposeSheet
        open={composeOpen}
        init={composeInit}
        meta={meta}
        contacts={contacts}
        onClose={() => setComposeOpen(false)}
        onMailChanged={bump}
      />

      {/* Group create / edit */}
      <GroupDialog
        open={groupDlg}
        group={editingGroup}
        contacts={contacts}
        onClose={() => setGroupDlg(false)}
        onSaved={() => { setGroupDlg(false); bump(); }}
      />

      {/* Permanent delete confirmation */}
      <Dialog open={deleteTarget !== null} onOpenChange={(o) => (!o ? setDeleteTarget(null) : undefined)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete forever?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.subject || "(no subject)"}” will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && void deleteForever(deleteTarget)}>Delete forever</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function listItemOf(d: MailDetail, items: MailListItem[]): MailListItem {
  return (
    items.find((i) => i.id === d.id) ?? {
      id: d.id, folder: d.folder, direction: d.direction, status: d.status, fromName: d.fromName,
      fromEmail: d.fromEmail, toEmail: d.toEmail, ccEmail: d.ccEmail, subject: d.subject, excerpt: d.excerpt,
      readAt: d.readAt, starredAt: d.starredAt, threadId: d.threadId, emailLogId: d.emailLogId,
      sentAt: d.sentAt, failedReason: d.failedReason, attachmentRefs: "[]", originFolder: d.originFolder,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    }
  );
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function SidebarContent({
  meta, folder, onSelect, onCompose, onNewGroup, onEditGroup, onComposeGroup, onDeleteGroup,
}: {
  meta: MailMeta | null;
  folder: FolderView;
  onSelect: (f: FolderView) => void;
  onCompose: () => void;
  onNewGroup: () => void;
  onEditGroup: (g: ContactGroup) => void;
  onComposeGroup: (g: ContactGroup) => void;
  onDeleteGroup: (g: ContactGroup) => void;
}) {
  const counts = meta?.counts;
  return (
    <div className="flex flex-col gap-1 p-3">
      <Button onClick={onCompose} className="justify-start gap-2 shadow-sm">
        <PenSquare className="h-4 w-4" /> Compose
      </Button>

      <nav className="mt-2 space-y-0.5" aria-label="Mail folders">
        {FOLDER_ORDER.map((f) => {
          const conf = FOLDER_META[f];
          const Icon = conf.icon;
          const isActive = folder === f;
          const count = f === "STARRED" ? meta?.starred : counts?.[f];
          const unread = f === "INBOX" ? meta?.inboxUnread ?? 0 : 0;
          return (
            <button
              key={f}
              type="button"
              onClick={() => onSelect(f)}
              aria-current={isActive ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                isActive ? "bg-primary/10 font-semibold text-primary" : "text-foreground/80 hover:bg-muted"
              }`}
            >
              <Icon className={`h-4 w-4 ${isActive ? "" : "text-muted-foreground"}`} aria-hidden />
              <span className="flex-1 text-left">{conf.label}</span>
              {unread > 0 ? (
                <Badge className="h-5 min-w-5 px-1.5 text-[10px] tabular-nums">{unread}</Badge>
              ) : typeof count === "number" && count > 0 ? (
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-3 border-t pt-3">
        <div className="mb-1 flex items-center justify-between px-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Groups</span>
          <button type="button" aria-label="New group" className="rounded p-1 hover:bg-muted" onClick={onNewGroup}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        {meta && meta.groups.length > 0 ? (
          <ul className="space-y-0.5">
            {meta.groups.map((g) => (
              <li key={g.id} className="group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-muted">
                <span className={`h-2 w-2 rounded-full shrink-0 ${GROUP_TONES[g.color] ?? "bg-emerald-500"}`} aria-hidden />
                <button type="button" className="flex-1 min-w-0 text-left truncate" onClick={() => onComposeGroup(g)} title={`Compose to ${g.name}`}>
                  {g.name}
                  <span className="ml-1.5 text-xs text-muted-foreground">{g.members.length}</span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label={`Group options for ${g.name}`} className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100">
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => onComposeGroup(g)}>
                      <PenSquare className="h-3.5 w-3.5 mr-2" /> Compose to group
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onEditGroup(g)}>
                      <Pencil className="h-3.5 w-3.5 mr-2" /> Edit members
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => onDeleteGroup(g)}>
                      <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete group
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2.5 pb-1 text-xs text-muted-foreground">
            Create a group to mail the whole team at once.
          </p>
        )}
      </div>

      <div className="mt-auto border-t pt-3 px-2.5 pb-1">
        {meta ? (
          <>
            <p className="truncate text-xs text-muted-foreground" title={meta.identity.email}>
              <span className="font-medium text-foreground">{meta.identity.name}</span>
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${meta.smtpConfigured ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
              {meta.smtpConfigured ? `Sending as ${meta.sendingAs.fromEmail}` : "External delivery not configured"}
            </p>
          </>
        ) : (
          <div className="h-8" />
        )}
      </div>
    </div>
  );
}

// ─── List item ──────────────────────────────────────────────────────────────

function ListItem({
  item, active, onOpen, onStar, onArchive, onTrash,
}: {
  item: MailListItem;
  active: boolean;
  onOpen: () => void;
  onStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const unread = !item.readAt;
  const isDraft = item.folder === "DRAFT";
  const isOut = item.direction === "OUT";
  const name = isDraft ? "Draft" : isOut ? `To ${splitEmails(item.toEmail)[0] ?? (item.toEmail || "…")}` : item.fromName || item.fromEmail;
  const attachCount = parseRefs(item.attachmentRefs).length;
  const starred = Boolean(item.starredAt);

  return (
    <li className={`group relative ${active ? "bg-primary/5" : unread ? "bg-primary/[0.03] hover:bg-muted/60" : "hover:bg-muted/60"}`}>
      <button type="button" onClick={onOpen} className="block w-full px-3 py-2.5 text-left" role="listitem">
        <div className="flex items-start gap-2.5">
          <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${toneFor(isOut ? item.toEmail || item.id : item.fromEmail || item.id)}`} aria-hidden>
            {isDraft ? <Pencil className="h-3.5 w-3.5" /> : initialsOf(isOut ? "" : item.fromName, isOut ? item.toEmail : item.fromEmail)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={`truncate text-[13px] ${unread ? "font-semibold text-foreground" : "text-foreground/90"}`}>{name}</span>
              {unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" /> : null}
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeLabel(item.updatedAt)}</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`truncate text-[13px] ${unread ? "font-medium text-foreground" : "text-foreground/80"}`}>
                {item.subject || "(no subject)"}
              </span>
              <OutboxBadge item={item} compact />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <p className="truncate text-xs text-muted-foreground">{isDraft ? item.excerpt || "No content yet" : item.excerpt || "No content"}</p>
              {attachCount > 0 ? <Paperclip className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" aria-label={`${attachCount} attachment${attachCount === 1 ? "" : "s"}`} /> : null}
            </div>
          </div>
        </div>
      </button>
      {/* Quick actions (hover, desktop) */}
      <div className="absolute right-2 top-2 hidden items-center gap-0.5 group-hover:flex">
        <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={starred ? "Unstar" : "Star"} onClick={onStar}>
          <Star className={`h-3.5 w-3.5 ${starred ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`} />
        </Button>
        {item.folder !== "ARCHIVE" && !isDraft ? (
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Archive" onClick={onArchive}>
            <Archive className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        ) : null}
        {item.folder !== "TRASH" ? (
          <Button variant="ghost" size="icon" className="h-6 w-6" aria-label="Move to trash" onClick={onTrash}>
            <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function OutboxBadge({ item, compact }: { item: MailListItem; compact?: boolean }) {
  if (item.direction !== "OUT" || item.folder === "DRAFT") return null;
  const map: Record<string, { label: string; cls: string; pulse?: boolean }> = {
    QUEUED: { label: "Queued", cls: "bg-amber-100 text-amber-800 border-amber-200" },
    SENDING: { label: "Sending", cls: "bg-amber-100 text-amber-800 border-amber-200", pulse: true },
    FAILED: { label: "Failed", cls: "bg-red-100 text-red-700 border-red-200" },
    CANCELED: { label: "Canceled", cls: "bg-muted text-muted-foreground border-border" },
  };
  const st = map[item.status];
  if (st) {
    return (
      <Badge variant="outline" className={`h-4 shrink-0 px-1 text-[9px] uppercase tracking-wide ${st.cls}`}>
        {st.pulse ? <span className="mr-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden /> : null}
        {st.label}
      </Badge>
    );
  }
  // Delivered: distinguish pure-internal sends (no EmailLog) from SMTP-accepted.
  if (item.status === "SENT") {
    return item.emailLogId ? (
      compact ? null : (
        <Badge variant="outline" className="h-4 shrink-0 bg-emerald-50 px-1 text-[9px] uppercase tracking-wide text-emerald-700 border-emerald-200">Sent</Badge>
      )
    ) : (
      <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] uppercase tracking-wide text-muted-foreground">Internal</Badge>
    );
  }
  return null;
}

function EmptyFolder({ folder, searching }: { folder: FolderView; searching?: boolean }) {
  const conf = FOLDER_META[folder];
  const Icon = conf.icon;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
      </span>
      {searching ? (
        <>
          <p className="text-sm font-medium">No results</p>
          <p className="max-w-[280px] text-xs text-muted-foreground">No mail in {conf.label.toLowerCase()} matches your search.</p>
        </>
      ) : (
        <>
          <p className="text-sm font-medium">Nothing in {conf.label.toLowerCase()}</p>
          <p className="max-w-[280px] text-xs text-muted-foreground">{conf.empty}</p>
        </>
      )}
    </div>
  );
}

// ─── Reading pane ───────────────────────────────────────────────────────────

function DetailPane({
  detail, loading, meta, onBack, onStar, onArchive, onTrash, onRestore, onDeleteForever,
  onMarkUnread, onReply, onReplyAll, onForward, onRetry, onCancel,
}: {
  detail: MailDetail | null;
  loading: boolean;
  meta: MailMeta | null;
  onBack: () => void;
  onStar: (d: MailDetail) => void;
  onArchive: (d: MailDetail) => void;
  onTrash: (d: MailDetail) => void;
  onRestore: (d: MailDetail) => void;
  onDeleteForever: (d: MailDetail) => void;
  onMarkUnread: (d: MailDetail) => void;
  onReply: (d: MailDetail) => void;
  onReplyAll: (d: MailDetail) => void;
  onForward: (d: MailDetail) => void;
  onRetry: (d: MailDetail) => void;
  onCancel: (d: MailDetail) => void;
}) {
  const srcDoc = useMemo(() => {
    if (!detail) return "";
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1f2937;margin:0;padding:18px;background:#fff;word-break:break-word;}img{max-width:100%;height:auto;}blockquote{border-left:2px solid #e5e7eb;margin:8px 0;padding-left:14px;color:#4b5563;}a{color:#0b7a4b;}table{max-width:100%;}</style></head><body>${detail.bodyHtml || "<p style='color:#9ca3af'>(No content)</p>"}</body></html>`;
  }, [detail]);

  if (loading) return <LoadingState label="Opening message…" />;
  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Mail className="h-6 w-6 text-muted-foreground" aria-hidden />
        </span>
        <p className="text-sm font-medium">Select an email to read</p>
        <p className="max-w-[300px] text-xs text-muted-foreground">
          Choose a message from the list, or compose a new email. Replies and forwards keep the conversation threaded.
        </p>
      </div>
    );
  }

  const isOut = detail.direction === "OUT";
  const isTrash = detail.folder === "TRASH";
  const starred = Boolean(detail.starredAt);
  const when = new Date(detail.sentAt ?? detail.createdAt).toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" });
  const toList = splitEmails(detail.toEmail);
  const ccList = splitEmails(detail.ccEmail);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="h-8 w-8 xl:hidden" aria-label="Back to list" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={starred ? "Unstar" : "Star"} onClick={() => onStar(detail)}>
          <Star className={`h-4 w-4 ${starred ? "fill-amber-400 text-amber-500" : "text-muted-foreground"}`} />
        </Button>
        {isTrash ? (
          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Restore" onClick={() => onRestore(detail)}>
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Archive" onClick={() => onArchive(detail)}>
              <Archive className="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Move to trash" onClick={() => onTrash(detail)}>
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </>
        )}

        {/* Quick reply actions — professional clients keep them one click away */}
        <div className="mx-1 hidden sm:flex items-center gap-1.5">
          {detail.folder !== "DRAFT" ? (
            <>
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => onReply(detail)}>
                <Reply className="h-3.5 w-3.5" /> Reply
              </Button>
              {!isOut ? (
                <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => onReplyAll(detail)}>
                  <ReplyAll className="h-3.5 w-3.5" /> Reply all
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => onForward(detail)}>
                <Forward className="h-3.5 w-3.5" /> Forward
              </Button>
            </>
          ) : null}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="ml-auto h-8 w-8" aria-label="More actions">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {!isTrash ? (
              <>
                <DropdownMenuItem onClick={() => onReply(detail)}>
                  <Reply className="h-3.5 w-3.5 mr-2" /> Reply
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onReplyAll(detail)}>
                  <ReplyAll className="h-3.5 w-3.5 mr-2" /> Reply all
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onForward(detail)}>
                  <Forward className="h-3.5 w-3.5 mr-2" /> Forward
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onMarkUnread(detail)}>
                  <MailOpen className="h-3.5 w-3.5 mr-2" /> Mark as unread
                </DropdownMenuItem>
              </>
            ) : null}
            {isTrash ? (
              <DropdownMenuItem onClick={() => onRestore(detail)}>
                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Restore from trash
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onTrash(detail)}>
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Move to trash
              </DropdownMenuItem>
            )}
            {isTrash ? (
              <DropdownMenuItem className="text-red-600 focus:text-red-600" onClick={() => onDeleteForever(detail)}>
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete forever
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Delivery state (outbox) */}
      {isOut && (detail.status === "QUEUED" || detail.status === "SENDING") ? (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Clock4 className="h-3.5 w-3.5 animate-pulse" aria-hidden />
          {detail.status === "SENDING" ? "Delivering now…" : "Queued for delivery — the email will leave the outbox as soon as the mail server accepts it."}
          <Button size="sm" variant="outline" className="ml-auto h-6 border-amber-300 px-2 text-[11px]" onClick={() => onCancel(detail)}>
            Cancel delivery
          </Button>
        </div>
      ) : null}
      {isOut && detail.status === "FAILED" ? (
        <div className="mx-4 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            <span className="font-medium">Delivery failed</span>
            <Button size="sm" variant="outline" className="ml-auto h-6 border-red-300 px-2 text-[11px]" onClick={() => onRetry(detail)}>
              <RotateCcw className="h-3 w-3 mr-1" /> Retry
            </Button>
            <Button size="sm" variant="outline" className="h-6 border-red-300 px-2 text-[11px]" onClick={() => onCancel(detail)}>
              Cancel
            </Button>
          </div>
          {detail.failedReason ? <p className="mt-1 text-red-700">{detail.failedReason}</p> : null}
        </div>
      ) : null}
      {isOut && detail.status === "CANCELED" ? (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground">
          Delivery canceled — this email was not sent.
          <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]" onClick={() => onRetry(detail)}>
            <RotateCcw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </div>
      ) : null}

      {/* Headers */}
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-lg font-semibold leading-snug">{detail.subject || "(no subject)"}</h1>
        <div className="mt-3 flex items-start gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${toneFor(detail.fromEmail || detail.id)}`} aria-hidden>
            {initialsOf(detail.fromName, detail.fromEmail)}
          </span>
          <div className="min-w-0 flex-1 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{detail.fromName || detail.fromEmail}</span>
              <span className="truncate text-xs text-muted-foreground">&lt;{detail.fromEmail}&gt;</span>
              <span className="ml-auto text-xs text-muted-foreground">{when}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isOut ? (
                <>to {toList.join(", ") || "—"}{ccList.length ? `, cc ${ccList.join(", ")}` : ""}{splitEmails(detail.bccEmail).length ? `, bcc ${splitEmails(detail.bccEmail).length} hidden` : ""}</>
              ) : (
                <>to {meta?.identity.email ?? "me"}{ccList.length ? `, cc ${ccList.join(", ")}` : ""}</>
              )}
            </p>
          </div>
        </div>

        {detail.attachments.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {detail.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/v1/email/client/attachments/${a.id}?m=${detail.id}`}
                  className="inline-flex max-w-[260px] items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-xs hover:bg-muted"
                  title={`Download ${a.filename}`}
                >
                  <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-medium">{a.filename}</span>
                  <span className="shrink-0 text-muted-foreground">{fmtBytes(a.size)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Body — sanitized server-side, rendered in a script-less sandbox */}
      <div className="min-h-0 flex-1 px-4 pb-4">
        <iframe
          title="Email body"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={srcDoc}
          className="h-full w-full rounded-lg border bg-white"
        />
      </div>
    </div>
  );
}

// ─── Group dialog ───────────────────────────────────────────────────────────

function GroupDialog({
  open, group, contacts, onClose, onSaved,
}: {
  open: boolean;
  group: ContactGroup | null;
  contacts: Contact[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState("emerald");
  const [members, setMembers] = useState<{ email: string; name?: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setColor(group?.color ?? "emerald");
    setMembers(group?.members.map((m) => ({ email: m.email, name: m.name })) ?? []);
    setConfirmDelete(false);
  }, [open, group]);

  const save = async () => {
    if (!name.trim()) {
      toast({ title: "Give the group a name", variant: "destructive" });
      return;
    }
    if (members.length === 0) {
      toast({ title: "Add at least one member", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = { name: name.trim(), color, members: members.map((m) => ({ name: m.name ?? "", email: m.email })) };
      if (group) await api.patch(`/api/v1/email/client/groups/${group.id}`, payload);
      else await api.post("/api/v1/email/client/groups", payload);
      toast({ title: group ? "Group updated" : "Group created", description: `${name.trim()} · ${members.length} member${members.length === 1 ? "" : "s"}` });
      onSaved();
    } catch (e) {
      toast({ title: "Could not save the group", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!group) return;
    setSaving(true);
    try {
      await api.del(`/api/v1/email/client/groups/${group.id}`);
      toast({ title: "Group deleted", description: group.name });
      onSaved();
    } catch (e) {
      toast({ title: "Could not delete the group", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
          <DialogDescription>Groups let you email the whole team — e.g. “All technicians” — with one click.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="mail-group-name">Group name</Label>
            <Input id="mail-group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Maintenance leads" maxLength={80} />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex gap-2">
              {Object.entries(GROUP_TONES).map(([key, cls]) => (
                <button
                  key={key}
                  type="button"
                  aria-label={`Color ${key}`}
                  aria-pressed={color === key}
                  onClick={() => setColor(key)}
                  className={`h-6 w-6 rounded-full ${cls} ${color === key ? "ring-2 ring-offset-2 ring-foreground/60" : "opacity-80 hover:opacity-100"}`}
                />
              ))}
            </div>
          </div>
          <div>
            <Label className="mb-1 block">Members ({members.length})</Label>
            <RecipientField
              label="Add"
              chips={members}
              onAdd={(raw) => {
                const email = raw.trim().replace(/[;,]+$/, "").toLowerCase();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return false;
                if (members.some((m) => m.email.toLowerCase() === email)) return true;
                setMembers([...members, { email, name: contacts.find((c) => c.email.toLowerCase() === email)?.name }]);
                return true;
              }}
              onRemove={(email) => setMembers(members.filter((m) => m.email !== email))}
              contacts={contacts}
              groups={[]}
            />
          </div>
        </div>
        <DialogFooter className="flex-row items-center gap-2 sm:justify-between">
          {group ? (
            confirmDelete ? (
              <Button variant="destructive" size="sm" disabled={saving} onClick={() => void remove()}>Confirm delete</Button>
            ) : (
              <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-600" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete group
              </Button>
            )
          ) : <span />}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Users className="h-4 w-4 mr-1.5" />}
              {group ? "Save changes" : "Create group"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
