"use client";

// MOHD.HMS ENTERPRISE — WhatsApp Inbox module (list page).
// Conversation list with state filter, unread badges and admin-initiated new
// conversations. Same navigation architecture as Customers (no giant modal):
//   []    → this list page          (/whatsapp)
//   [id]  → WhatsAppDetailPage      (/whatsapp/{id})
// via the hash router (ui-store pages["whatsapp"]).

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError, qs } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, pageFromSeg } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { PageHeader, LoadingState, EmptyState, ErrorState } from "@/components/hms/shared/ui-bits";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronRight, MessageCircle, Plus } from "lucide-react";
import { ConvStateBadge, WhatsAppDetailPage } from "./detail-page";

// ── Types (mirror of the API list select — read-only contract) ──

type ConvRow = {
  id: string; chatId: string; state: string; unreadCount: number; assignedAgentId: string | null;
  lastMessageAt: string | null; lastMessagePreview: string | null; lastInboundAt: string | null;
  contact: { id: string; waName: string; phone: string; kind: string; automationEnabled: boolean };
  customer: { id: string; code: string; companyName: string; contactPerson: string } | null;
};

const PAGE_SIZE = 20;

// ── Module router ──

export function WhatsAppModule() {
  const seg = useUi((s) => s.pages["whatsapp"]) ?? [];
  const page = pageFromSeg(seg);

  if (page.view === "detail" && page.id) return <WhatsAppDetailPage id={page.id} />;
  return <WhatsAppInbox />;
}

// ── Row helpers ──

function convName(r: ConvRow): string {
  return r.contact.waName || r.customer?.contactPerson || r.contact.phone;
}

function convSub(r: ConvRow): string {
  return r.customer
    ? `${r.customer.code} · ${r.customer.companyName || r.customer.contactPerson}`
    : r.contact.phone;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Time-only for today, otherwise a short date — chat-list convention. */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function ConversationRow({ r, onOpen }: { r: ConvRow; onOpen: (id: string) => void }) {
  const name = convName(r);
  const unread = r.unreadCount ?? 0;
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="whatsapp-conversation-row"
      aria-label={`Open conversation with ${name}`}
      onClick={() => onOpen(r.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r.id); }
      }}
      className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
    >
      <div
        aria-hidden
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
      >
        {initials(name)}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm", unread > 0 ? "font-semibold" : "font-medium")}>{name}</p>
        <p className="truncate text-xs text-muted-foreground">{convSub(r)}</p>
        {r.lastMessagePreview ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground/80">{r.lastMessagePreview}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="whitespace-nowrap text-[11px] text-muted-foreground">{shortWhen(r.lastMessageAt)}</span>
        <div className="flex items-center gap-1.5">
          {unread > 0 ? (
            <Badge
              aria-label={`${unread} unread message${unread === 1 ? "" : "s"}`}
              className="min-w-5 border-transparent bg-emerald-600 px-1.5 text-[11px] text-white hover:bg-emerald-600"
            >
              {unread > 99 ? "99+" : unread}
            </Badge>
          ) : null}
          <ConvStateBadge state={r.state} />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            data-testid="whatsapp-conversation-open"
            aria-label={`Open ${name}`}
            onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── List page ──

function WhatsAppInbox() {
  const { user } = useSession();
  const { toast } = useToast();
  const canSend = hasPerm(user, PERMISSIONS.whatsapp_send);

  const [rows, setRows] = useState<ConvRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [stateFilter, setStateFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New conversation dialog
  const [newOpen, setNewOpen] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [creating, setCreating] = useState(false);

  const open = useCallback((id: string) => navigateTo("whatsapp", [id]), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<ConvRow[]>(`/api/v1/whatsapp/conversations${qs({
        state: stateFilter !== "all" ? stateFilter : undefined,
        page,
        pageSize: PAGE_SIZE,
      })}`);
      setRows(res.data ?? []);
      setTotal(Number(res.meta?.total ?? (res.data?.length ?? 0)));
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Could not load conversations.");
    } finally {
      setLoading(false);
    }
  }, [stateFilter, page]);

  useEffect(() => { void load(); }, [load]);

  async function submitNew() {
    const phone = newPhone.trim();
    if (phone.length < 6 || creating) return;
    setCreating(true);
    try {
      const res = await api.put<{ ok: boolean; conversationId: string; chatId: string }>(
        "/api/v1/whatsapp/conversations",
        { phone }
      );
      setNewOpen(false);
      setNewPhone("");
      navigateTo("whatsapp", [res.data.conversationId]);
    } catch (e) {
      toast({
        title: "Could not start the conversation",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, total);

  return (
    <div data-testid="whatsapp-inbox">
      <PageHeader
        title="WhatsApp Inbox"
        subtitle="WhatsApp conversations, bot handoffs and staff replies"
        actions={
          canSend ? (
            <Button data-testid="whatsapp-new-conversation" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> New conversation
            </Button>
          ) : null
        }
      />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Conversations</CardTitle>
              <CardDescription>
                {loading ? "Loading…" : `${total} conversation${total === 1 ? "" : "s"}`}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Label htmlFor="wa-state-filter" className="text-xs text-muted-foreground">State</Label>
              <Select
                value={stateFilter}
                onValueChange={(v) => { setStateFilter(v); setPage(1); }}
              >
                <SelectTrigger id="wa-state-filter" className="w-[130px]" aria-label="Filter by conversation state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="BOT">BOT</SelectItem>
                  <SelectItem value="HUMAN">HUMAN</SelectItem>
                  <SelectItem value="CLOSED">CLOSED</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="p-4"><ErrorState message={error} onRetry={() => void load()} /></div>
          ) : loading ? (
            <div className="p-4"><LoadingState label="Loading conversations…" rows={5} /></div>
          ) : rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={stateFilter === "all" ? "No conversations yet" : "No conversations in this state"}
                hint={
                  stateFilter === "all"
                    ? "WhatsApp chats appear here as soon as a contact messages the business number or you start one."
                    : "Try switching the state filter back to All."
                }
              />
            </div>
          ) : (
            <div className="divide-y border-t">
              {rows.map((r) => (
                <ConversationRow key={r.id} r={r} onOpen={open} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > 0 ? (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {rangeFrom}–{rangeTo} of {total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
              Prev
            </Button>
            <Button size="sm" variant="outline" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {/* New conversation — confirm-free create dialog, then straight to detail */}
      <Dialog open={newOpen} onOpenChange={(o) => { if (!o) { setNewOpen(false); setNewPhone(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4 text-primary" aria-hidden /> New conversation
            </DialogTitle>
            <DialogDescription>
              Start a WhatsApp chat with a contact phone number (international format, e.g. 6731234567).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="wa-new-phone">WhatsApp phone number</Label>
            <Input
              id="wa-new-phone"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitNew(); } }}
              placeholder="e.g. 6731234567"
              inputMode="tel"
              autoFocus
              aria-describedby="wa-new-phone-hint"
            />
            <p id="wa-new-phone-hint" className="text-xs text-muted-foreground">
              Country code digits only — the number is normalised server-side.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={creating} onClick={() => { setNewOpen(false); setNewPhone(""); }}>
              Cancel
            </Button>
            <Button disabled={creating || newPhone.trim().length < 6} onClick={() => void submitNew()}>
              {creating ? "Starting…" : "Start conversation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
