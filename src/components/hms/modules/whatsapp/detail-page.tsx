"use client";

// MOHD.HMS ENTERPRISE — WhatsApp conversation detail (dedicated page, /whatsapp/{id}).
// Chat-bubble transcript (OUTBOUND right / INBOUND left), human-handoff state
// control and the staff reply box. Opens over the same hash-router mechanism
// as every other module page: navigateTo("whatsapp", [conversationId]).
//
// Media messages display filename only — bytes live in MinIO and are NOT
// downloadable in this phase. Opening the conversation clears the unread
// badge server-side (GET resets unreadCount).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { navigateTo } from "@/lib/hms/router";
import { PageHeader, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft, Bot, Building2, FileText, Image as ImageIcon, Loader2, Paperclip, Send, UserRound,
} from "lucide-react";

// ── Types (mirror of the API selects — read-only contract) ──

type WaMessage = {
  id: string; direction: string; status: string; type: string; body: string;
  mediaMimetype: string; mediaFilename: string; mediaSize: number;
  templateKey: string; relatedType: string; relatedId: string;
  isTest: boolean; sentAt: string | null; createdAt: string; lastError: string | null;
};

type WaConversation = {
  id: string; chatId: string; state: string; unreadCount: number; assignedAgentId: string | null;
  lastMessageAt: string | null; lastInboundAt: string | null;
  contact: { id: string; waName: string; phone: string; kind: string; automationEnabled: boolean; customerId: string | null };
  customer: { id: string; code: string; companyName: string; contactPerson: string } | null;
};

type WaConversationDetail = WaConversation & { messages: WaMessage[] };

// ── Small shared renderers ──

const STATE_LABEL: Record<string, string> = { BOT: "Bot", HUMAN: "Human", CLOSED: "Closed" };
const STATE_CLASS: Record<string, string> = {
  BOT: "bg-stone-100 text-stone-600",
  HUMAN: "bg-amber-100 text-amber-800",
  CLOSED: "bg-stone-200 text-stone-700",
};

export function ConvStateBadge({ state }: { state: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-medium whitespace-nowrap", STATE_CLASS[state] ?? "bg-stone-100 text-stone-600")}
    >
      {STATE_LABEL[state] ?? state}
    </Badge>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function msgWhen(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function MediaGlyph({ type }: { type: string }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (type === "image") return <ImageIcon className={cls} aria-hidden />;
  if (type === "document") return <FileText className={cls} aria-hidden />;
  return <Paperclip className={cls} aria-hidden />; // audio / video / location / unknown
}

// Outbound delivery status — small colored dot + label (RECEIVED inbound: none).
const STATUS_DOT: Record<string, string> = {
  QUEUED: "bg-amber-500",
  SENDING: "bg-amber-500",
  SENT: "bg-emerald-500",
  DELIVERED: "bg-emerald-600",
  READ: "bg-emerald-700",
  FAILED: "bg-red-600",
  CANCELED: "bg-stone-400",
};

function StatusChip({ m }: { m: WaMessage }) {
  if (m.direction !== "OUTBOUND") return null;
  const failed = m.status === "FAILED";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 uppercase tracking-wide whitespace-nowrap",
        failed ? "text-red-600 cursor-help" : "text-muted-foreground"
      )}
      title={failed ? (m.lastError ?? "Send failed") : undefined}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[m.status] ?? "bg-stone-400")} aria-hidden />
      {m.status}
    </span>
  );
}

function MessageBubble({ m }: { m: WaMessage }) {
  const out = m.direction === "OUTBOUND";
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")} data-testid="whatsapp-message-item">
      <div
        className={cn(
          "max-w-[85%] sm:max-w-[70%] rounded-2xl border px-3.5 py-2",
          out ? "bg-primary/10 border-primary/20 rounded-br-sm" : "bg-muted border-transparent rounded-bl-sm"
        )}
      >
        {m.type !== "text" ? (
          // Media bytes are NOT downloadable in this phase — filename display only.
          <p className="flex items-center gap-1.5 mb-1 text-xs text-muted-foreground underline underline-offset-2 decoration-muted-foreground/40">
            <MediaGlyph type={m.type} />
            <span className="truncate">{m.mediaFilename || "Attachment"}</span>
          </p>
        ) : null}
        {m.body ? <p className="text-sm whitespace-pre-wrap break-words">{m.body}</p> : null}
        <div className="mt-1 flex items-center justify-end gap-2 text-[10px] leading-none">
          {m.isTest ? <Badge variant="outline" className="h-auto px-1 py-0 text-[9px]">TEST</Badge> : null}
          {m.templateKey ? <span className="max-w-[140px] truncate text-muted-foreground/70">{m.templateKey}</span> : null}
          <span className="whitespace-nowrap text-muted-foreground">{msgWhen(m.createdAt)}</span>
          <StatusChip m={m} />
        </div>
      </div>
    </div>
  );
}

// ── Page ──

export function WhatsAppDetailPage({ id }: { id: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const canSend = hasPerm(user, PERMISSIONS.whatsapp_send);
  const canReadCustomers = hasPerm(user, PERMISSIONS.customers_read);

  const [conv, setConv] = useState<WaConversation | null>(null);
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [handingOff, setHandingOff] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<WaConversationDetail>(`/api/v1/whatsapp/conversations/${encodeURIComponent(id)}`);
      const { messages: msgs, ...rest } = res.data;
      setConv(rest);
      setMessages(msgs ?? []);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Could not load this conversation.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Auto-scroll to the newest message on load and after each appended reply.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, conv?.id]);

  async function toggleHandoff() {
    if (!conv) return;
    const next = conv.state === "HUMAN" ? "BOT" : "HUMAN";
    setHandingOff(true);
    try {
      await api.patch(`/api/v1/whatsapp/conversations/${encodeURIComponent(conv.id)}`, { state: next });
      setConv({ ...conv, state: next });
      toast({
        title: next === "HUMAN" ? "Human handoff active" : "Bot automation resumed",
        description:
          next === "HUMAN"
            ? "You reply manually — automated responses are paused for this chat."
            : "Automated responses continue for this chat.",
      });
    } catch (e) {
      toast({
        title: "Could not update the conversation",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setHandingOff(false);
    }
  }

  async function sendReply() {
    if (!conv) return;
    const message = reply.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      const res = await api.post<{ ok: boolean; messageId: string | null }>(
        `/api/v1/whatsapp/conversations/${encodeURIComponent(conv.id)}`,
        { message }
      );
      // Optimistic append — the worker moves it QUEUED → SENT/… later.
      setMessages((prev) => [
        ...prev,
        {
          id: res.data.messageId ?? `local-${Date.now()}`,
          direction: "OUTBOUND", status: "QUEUED", type: "text", body: message,
          mediaMimetype: "", mediaFilename: "", mediaSize: 0,
          templateKey: "", relatedType: "", relatedId: "",
          isTest: false, sentAt: null, createdAt: new Date().toISOString(), lastError: null,
        },
      ]);
      setReply("");
      toast({ title: "Reply queued", description: "The WhatsApp worker will deliver it shortly." });
    } catch (e) {
      toast({
        title: "Could not send the reply",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  }

  const back = (
    <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigateTo("whatsapp", [])}>
      <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to inbox
    </Button>
  );

  if (loading && !conv) {
    return (
      <div className="space-y-4">
        {back}
        <LoadingState label="Loading conversation…" rows={5} />
      </div>
    );
  }

  if (error && !conv) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }

  if (!conv) return null;

  const name = conv.contact.waName || conv.customer?.contactPerson || conv.contact.phone;
  const closed = conv.state === "CLOSED";

  return (
    <div className="space-y-4">
      {back}

      <PageHeader
        title={name}
        subtitle={`WhatsApp conversation · ${conv.contact.phone}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ConvStateBadge state={conv.state} />
            {canSend && !closed ? (
              <Button
                variant="outline"
                size="sm"
                data-testid="whatsapp-handoff-toggle"
                disabled={handingOff}
                onClick={() => void toggleHandoff()}
              >
                {conv.state === "HUMAN" ? (
                  <><Bot className="h-4 w-4 mr-1.5" /> Resume bot</>
                ) : (
                  <><UserRound className="h-4 w-4 mr-1.5" /> Human handoff</>
                )}
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Identity strip — contact + linked customer */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:p-5">
          <div
            aria-hidden
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
          >
            {initials(name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {conv.contact.phone}
              {conv.customer ? ` · ${conv.customer.code} ${conv.customer.companyName || conv.customer.contactPerson}` : ""}
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground/70">{conv.chatId}</p>
          </div>
          {canReadCustomers && conv.customer ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 self-start px-2 text-xs sm:self-auto"
              onClick={() => conv.customer && navigateTo("customers", [conv.customer.id])}
            >
              <Building2 className="h-3.5 w-3.5 mr-1" /> View customer
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* Transcript + reply */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Messages</CardTitle>
          <CardDescription>
            {messages.length} message{messages.length === 1 ? "" : "s"} · newest at the bottom
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="hms-scroll max-h-[60vh] space-y-3 overflow-y-auto rounded-lg border bg-muted/20 p-3 sm:p-4"
            data-testid="whatsapp-message-list"
          >
            {messages.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No messages in this conversation yet.</p>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} m={m} />)
            )}
            <div ref={bottomRef} aria-hidden />
          </div>

          <Separator />

          {closed ? (
            <div className="space-y-2" aria-live="polite">
              <Textarea
                data-testid="whatsapp-reply-input"
                rows={2}
                disabled
                placeholder="Conversation closed"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">Conversation closed — replies are disabled.</p>
                <Button data-testid="whatsapp-reply-send" size="sm" disabled>
                  <Send className="h-4 w-4 mr-1.5" /> Send
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea
                data-testid="whatsapp-reply-input"
                rows={3}
                maxLength={2000}
                disabled={sending || !canSend}
                placeholder={canSend ? "Type a reply… (Ctrl+Enter to send)" : "You don't have permission to send WhatsApp messages."}
                value={reply}
                aria-label="Reply message"
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendReply(); }
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{reply.length}/2000 characters</p>
                <Button
                  size="sm"
                  data-testid="whatsapp-reply-send"
                  disabled={sending || !canSend || reply.trim().length === 0}
                  onClick={() => void sendReply()}
                >
                  {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
                  {sending ? "Sending…" : "Send"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
