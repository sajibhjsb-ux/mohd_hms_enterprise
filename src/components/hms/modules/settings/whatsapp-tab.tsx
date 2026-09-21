"use client";

// MOHD.HMS ENTERPRISE — WhatsApp administration (Settings → WhatsApp).
// Container tab: Connection (live session, QR/pairing, test message, config),
// plus Templates / Automations / Logs / Health panels gated by their own
// permissions. Lives inside the existing Settings module — no separate app.
// The gateway (OpenWA) secrets are write-only — never displayed, only hinted.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, ArrowDownLeft, ArrowUpRight, Ban, KeyRound, Link2, Loader2, MessageSquare,
  Plus, QrCode, RefreshCw, Save, Send, ShieldAlert, ShieldCheck, Smartphone, Trash2, Unlink, Zap,
} from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/* ──────────────────────────────────────────────────────────────────────────── */
/* Types (mirror the real API payloads — nothing invented)                     */
/*────────────────────────────────────────────────────────────────────────────*/

type WhatsAppSession = {
  uiState: string;
  sessionStatus: string;
  sessionName: string;
  phone: string;
  pushName: string;
  error: string;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  webhookRegistered: boolean;
  enabled: boolean;
};

type WhatsAppConfig = {
  gatewayBaseUrl: string;
  sessionName: string;
  enabled: boolean;
  autoReplies: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  hasWebhookSecret: boolean;
  webhookRegistered: boolean;
  testRecipient: string;
  configuredAt: string | null;
};

type ConfigDraft = {
  gatewayBaseUrl: string;
  sessionName: string;
  enabled: boolean;
  autoReplies: boolean;
  testRecipient: string;
};

type WhatsAppMeta = {
  statuses?: string[];
  uiStates?: string[];
  categories?: string[];
  conversationStates?: string[];
  events?: string[];
  templateKeys?: { key: string; name: string; variables: string[] }[];
  recipientKinds?: string[];
  attachmentKinds?: string[];
};

type TemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  body: string;
  editedBy: string;
  createdAt: string;
};

type TemplateRow = {
  id: string;
  key: string;
  name: string;
  category: string;
  description: string;
  body: string;
  variables: string; // JSON string — parsed defensively
  isActive: boolean;
  isSystem: boolean;
  critical: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  versions: TemplateVersion[];
};

type TemplateForm = {
  key: string;
  name: string;
  category: string;
  description: string;
  body: string;
};

type AutomationRow = {
  id: string;
  name: string;
  eventType: string;
  templateKey: string;
  recipientRule: string; // JSON string
  conditions: string; // JSON string
  attachments: string; // JSON string
  delayMinutes: number;
  dedupeHours: number;
  enabled: boolean;
  critical: boolean;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};

type RecipientRule = { kind: string; value?: string };

type AutoForm = {
  name: string;
  eventType: string;
  templateKey: string;
  ruleKind: string;
  ruleValue: string;
  attachment: string; // max 1 per the API schema — "" = none
  dedupeHours: string;
  enabled: boolean;
};

type MessageRow = {
  id: string;
  chatId: string;
  direction: string;
  status: string;
  type: string;
  body: string;
  templateKey: string | null;
  templateVersion: number | null;
  relatedType: string | null;
  relatedId: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  errorClass: string | null;
  isTest: boolean;
  fromMe: boolean | null;
  mediaMimetype: string | null;
  mediaFilename: string | null;
  sentAt: string | null;
  createdAt: string;
  providerMessageId: string | null;
  contact: { waName: string; phone: string; customerId: string | null; kind: string } | null;
  conversation: { state: string } | null;
};

type WhatsAppHealth = {
  configOk: boolean;
  gateway: { reachable: boolean; detail: string };
  apiKeyValid: boolean;
  session: { status: string; phone: string; connected: boolean; lastHeartbeatAt: string | null; lastConnectedAt: string | null };
  webhook: { registered: boolean };
  queue: { queued: number; sending: number; sent: number; delivered: number; read: number; failed: number };
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
};

/* ──────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/*────────────────────────────────────────────────────────────────────────────*/

const PAGE_SIZE = 15;
const ROLES = ["SUPER_ADMIN", "ADMIN", "SUPERVISOR", "TECHNICIAN", "FINANCE", "HR"];
const FALLBACK_ATTACHMENT_KINDS = ["QUOTATION_PDF", "INVOICE_PDF", "WO_PDF", "INSPECTION_PDF", "LETTER_PDF", "PAYMENT_RECEIPT_PDF"];

/** Sample values used for sandboxed template previews (never persisted). */
const SAMPLE_PREVIEW: Record<string, string> = {
  CUSTOMER_NAME: "Tan Mei Ling",
  COMPLAINT_NUMBER: "CPT-2026-0001",
  WORK_ORDER_NUMBER: "WO-2026-0001",
  QUOTATION_NUMBER: "QTN-2026-0001",
  INVOICE_NUMBER: "INV-2026-0001",
  AMOUNT: "B$ 250.00",
  DUE_DATE: "12 Oct 2026",
  STATUS_SUMMARY: "Complaint CPT-2026-0001: IN_PROGRESS",
  INVOICE_SUMMARY: "Invoice INV-2026-0001: SENT — B$ 250.00 (due 12 Oct 2026)",
  COMPANY_NAME: "MOHD.HMS Enterprise",
  NOTIFICATION_TITLE: "Sample title",
  NOTIFICATION_MESSAGE: "Sample message",
  USER_NAME: "Tan Mei Ling",
  PRIORITY: "HIGH",
  COMPLAINT_TITLE: "AC not cooling",
  PHONE: "+6737123456",
  PAYMENT_REFERENCE: "PAY-2026-0001",
};

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Relative time for freshness-sensitive session stamps ("5m ago"). */
function rel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 45_000) return "just now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return when(iso);
}

/** Parse a JSON string defensively — malformed stored data never breaks the UI. */
function parseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Humanized recipient summary from the stored rule JSON. */
function recipientSummary(rule: RecipientRule): string {
  switch (rule.kind) {
    case "CUSTOMER": return "Customer";
    case "RELATED_USER": return "Assigned user";
    case "ROLE": return rule.value ? `Role: ${rule.value}` : "Role: —";
    case "FIXED": return rule.value || "—";
    default: return rule.kind || "—";
  }
}

/** Message delivery states (§29) — mirrors the email log badge idioms. */
function statusBadgeClass(s: string): string {
  switch (s) {
    case "SENT":
    case "DELIVERED":
    case "READ": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "QUEUED":
    case "SENDING": return "bg-amber-100 text-amber-800 border-amber-200";
    case "FAILED": return "bg-red-100 text-red-800 border-red-200";
    default: return "text-muted-foreground"; // RECEIVED, CANCELED + unknown
  }
}

/** UI connection states (§9) — green connected, amber in-between, red error. */
function uiStateBadgeClass(s: string): string {
  switch (s) {
    case "CONNECTED": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "QR_REQUIRED":
    case "CONNECTING":
    case "AUTHENTICATED": return "bg-amber-100 text-amber-800 border-amber-200";
    case "ERROR": return "bg-red-100 text-red-800 border-red-200";
    default: return "text-muted-foreground"; // DISCONNECTED
  }
}

function uiStateLabel(s: string): string {
  switch (s) {
    case "CONNECTED": return "Connected";
    case "QR_REQUIRED": return "QR required";
    case "CONNECTING": return "Connecting…";
    case "AUTHENTICATED": return "Authenticating…";
    case "ERROR": return "Error";
    case "DISCONNECTED": return "Disconnected";
    default: return s;
  }
}

function configToDraft(c: WhatsAppConfig): ConfigDraft {
  return {
    gatewayBaseUrl: c.gatewayBaseUrl ?? "",
    sessionName: c.sessionName ?? "",
    enabled: c.enabled,
    autoReplies: c.autoReplies,
    testRecipient: c.testRecipient ?? "",
  };
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Container — inner tabs, gated like the Email tab                            */
/*────────────────────────────────────────────────────────────────────────────*/

export function WhatsAppTab() {
  const { user } = useSession();
  const canView = hasPerm(user, PERMISSIONS.whatsapp_view); // guaranteed by the parent gate — checked defensively
  const canTemplates = hasPerm(user, PERMISSIONS.whatsapp_templates);
  const canAutomations = hasPerm(user, PERMISSIONS.whatsapp_automations);

  return (
    <Tabs defaultValue="connection">
      <TabsList className="mb-4 flex-wrap h-auto">
        <TabsTrigger value="connection">Connection</TabsTrigger>
        {canView ? <TabsTrigger value="templates">Templates</TabsTrigger> : null}
        {canView ? <TabsTrigger value="automations">Automations</TabsTrigger> : null}
        {canView ? <TabsTrigger value="logs">Logs</TabsTrigger> : null}
        {canView ? <TabsTrigger value="health">Health</TabsTrigger> : null}
      </TabsList>

      <TabsContent value="connection">
        <ConnectionPanel />
      </TabsContent>
      {canView ? (
        <TabsContent value="templates">
          <WhatsAppTemplates canEdit={canTemplates} />
        </TabsContent>
      ) : null}
      {canView ? (
        <TabsContent value="automations">
          <WhatsAppAutomations canManage={canAutomations} />
        </TabsContent>
      ) : null}
      {canView ? (
        <TabsContent value="logs">
          <WhatsAppLogs />
        </TabsContent>
      ) : null}
      {canView ? (
        <TabsContent value="health">
          <WhatsAppHealthPanel />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Connection — live status, session actions, test message, configuration      */
/*────────────────────────────────────────────────────────────────────────────*/

function ConnectionPanel() {
  const { user } = useSession();
  const { toast } = useToast();
  const canConnect = hasPerm(user, PERMISSIONS.whatsapp_connect);
  const canSend = hasPerm(user, PERMISSIONS.whatsapp_send);
  const canConfig = hasPerm(user, PERMISSIONS.whatsapp_config);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<WhatsAppSession | null>(null);
  const [config, setConfig] = useState<WhatsAppConfig | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [clearingSecret, setClearingSecret] = useState(false);
  const [busyAction, setBusyAction] = useState<"connect" | "reconnect" | "disconnect" | null>(null);

  // QR dialog state — `qrWaiting` is the honest "pairing socket re-establishing"
  // state (engine between QR rotations / during reconnect backoff); it is NOT
  // an error. `qrError` is a real failure (gateway down, not configured, …).
  const [qrOpen, setQrOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrWaiting, setQrWaiting] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrFetchedAt, setQrFetchedAt] = useState<number | null>(null);
  const [qrAge, setQrAge] = useState(0);
  const [refreshingPairing, setRefreshingPairing] = useState(false);

  // Pairing code dialog state
  const [pairOpen, setPairOpen] = useState(false);
  const [pairPhone, setPairPhone] = useState("");
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  // Disconnect dialog state
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [logoutDevice, setLogoutDevice] = useState(false);

  // Test message state
  const [testTo, setTestTo] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [sending, setSending] = useState(false);

  const refreshSession = useCallback(async () => {
    // Silent refresh — used by the 15s poll and the QR dialog watcher.
    try {
      const res = await api.get<WhatsAppSession>("/api/v1/whatsapp/session");
      setSession(res.data);
    } catch {
      /* polling errors stay invisible — the last known status remains shown */
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sessionRes = await api.get<WhatsAppSession>("/api/v1/whatsapp/session");
      setSession(sessionRes.data);
      if (canConfig) {
        const cfgRes = await api.get<WhatsAppConfig>("/api/v1/whatsapp/config");
        setConfig(cfgRes.data);
        setDraft(configToDraft(cfgRes.data));
        setTestTo((prev) => prev || cfgRes.data?.testRecipient || "");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load the WhatsApp session status.");
    } finally {
      setLoading(false);
    }
  }, [canConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll the live session status every 15s (gateway probe happens server-side).
  useEffect(() => {
    const t = setInterval(() => void refreshSession(), 15_000);
    return () => clearInterval(t);
  }, [refreshSession]);

  // ── Session actions ──
  const connect = async () => {
    setBusyAction("connect");
    try {
      const res = await api.post<{ ok: boolean; detail: string; qrRequired?: boolean }>("/api/v1/whatsapp/session", {});
      toast({ title: "Session start requested", description: res.data?.detail || "The gateway is bringing the session up." });
      if (res.data?.qrRequired) setQrOpen(true);
      await refreshSession();
    } catch (e) {
      toast({ title: "Connect failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyAction(null);
    }
  };

  const reconnect = async () => {
    setBusyAction("reconnect");
    try {
      const res = await api.post<{ ok: boolean; detail: string }>("/api/v1/whatsapp/session/reconnect", {});
      toast({ title: "Reconnect requested", description: res.data?.detail || "The session is being restarted." });
      await refreshSession();
    } catch (e) {
      toast({ title: "Reconnect failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyAction(null);
    }
  };

  const disconnect = async () => {
    setBusyAction("disconnect");
    try {
      const res = await api.post<{ ok: boolean; detail: string }>("/api/v1/whatsapp/session/disconnect", { logout: logoutDevice });
      toast({ title: logoutDevice ? "Device logged out" : "Session disconnected", description: res.data?.detail || undefined });
      setDisconnectOpen(false);
      setLogoutDevice(false);
      await refreshSession();
    } catch (e) {
      toast({ title: "Disconnect failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyAction(null);
    }
  };

  const fetchQr = useCallback(async () => {
    setQrLoading(true);
    try {
      const res = await api.get<{ qr: string | null; state?: "READY" | "WAITING"; detail?: string }>("/api/v1/whatsapp/session/qr");
      if (res.data?.qr) {
        // Fresh, engine-verified QR (the server only returns one while the
        // session is truly qr_ready — never a stale code from a closed socket).
        setQr(res.data.qr);
        setQrWaiting(null);
        setQrError(null);
        setQrFetchedAt(Date.now());
      } else if (res.data?.state === "WAITING") {
        // The engine is between QR rotations / reconnecting — honest waiting
        // state, not an error. The poll picks up the fresh QR automatically.
        setQr(null);
        setQrWaiting(res.data.detail || "Waiting for a fresh QR…");
        setQrError(null);
      } else {
        setQr(null);
        setQrWaiting(null);
        setQrError(res.data?.detail || "No QR available.");
      }
    } catch (e) {
      setQr(null);
      setQrWaiting(null);
      setQrError(e instanceof Error ? e.message : "No QR available.");
    } finally {
      setQrLoading(false);
    }
  }, []);

  // §15 recovery: stop + start the session through the existing reconnect
  // endpoint — forces a fresh socket and a fresh QR immediately instead of
  // waiting out the engine's reconnect backoff with a dead cached code.
  const refreshPairing = useCallback(async () => {
    setRefreshingPairing(true);
    try {
      await api.post("/api/v1/whatsapp/session/reconnect", {});
      toast({ title: "Pairing refreshed", description: "A fresh QR is being generated." });
    } catch (e) {
      toast({ title: "Refresh failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setRefreshingPairing(false);
    }
    void fetchQr();
  }, [fetchQr, toast]);

  // While the QR dialog is open: refresh the QR every 10s (Baileys rotates its
  // QR every ~20s — a 20s poll could display a one-generation-dead code) and
  // watch the session state — the dialog closes itself once the link succeeds.
  useEffect(() => {
    if (!qrOpen) { setQr(null); setQrError(null); setQrWaiting(null); setQrFetchedAt(null); return; }
    let alive = true;
    void fetchQr();
    const qrTimer = setInterval(() => { if (alive) void fetchQr(); }, 10_000);
    const statusTimer = setInterval(() => { if (alive) void refreshSession(); }, 5_000);
    return () => { alive = false; clearInterval(qrTimer); clearInterval(statusTimer); };
  }, [qrOpen, fetchQr, refreshSession]);

  // Live age of the displayed QR so the user can trust it is fresh.
  useEffect(() => {
    if (!qrOpen || !qrFetchedAt) { setQrAge(0); return; }
    const t = setInterval(() => setQrAge(Math.floor((Date.now() - qrFetchedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [qrOpen, qrFetchedAt]);

  useEffect(() => {
    if (qrOpen && session?.uiState === "CONNECTED") {
      setQrOpen(false);
      toast({ title: "WhatsApp linked", description: "The session is connected — no scan needed anymore." });
      void refreshSession();
    }
  }, [qrOpen, session?.uiState, refreshSession, toast]);

  const requestPairingCode = async () => {
    const phone = pairPhone.trim();
    if (!phone) {
      toast({ title: "Phone required", description: "Enter the phone number including the country code (e.g. +6737123456).", variant: "destructive" });
      return;
    }
    setPairing(true);
    setPairCode(null);
    try {
      const res = await api.post<{ pairingCode: string }>("/api/v1/whatsapp/session/pairing-code", { phone });
      setPairCode(res.data.pairingCode);
    } catch (e) {
      toast({ title: "Pairing code failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPairing(false);
    }
  };

  // ── Test message ──
  const sendTest = async () => {
    const to = testTo.trim();
    if (!to) {
      toast({ title: "Recipient required", description: "Enter the phone number that should receive the test message (e.g. +6737123456).", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await api.post<{ ok: boolean; detail: string; messageId?: string }>("/api/v1/whatsapp/test-send", {
        to,
        message: testMessage.trim() || undefined,
      });
      toast({ title: "Test message accepted", description: res.data?.detail || `Queued for ${to}.` });
    } catch (e) {
      // The API is honest — the failure reason arrives as the error message.
      toast({ title: "Test message failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  // ── Configuration ──
  const saveConfig = async () => {
    if (!draft) return;
    if (draft.sessionName.trim() !== "" && !/^[a-zA-Z0-9-]{1,64}$/.test(draft.sessionName.trim())) {
      toast({ title: "Invalid session name", description: "Use 1–64 letters, digits or dashes.", variant: "destructive" });
      return;
    }
    if (apiKey.trim() !== "" && apiKey.trim().length < 8) {
      toast({ title: "API key too short", description: "The API key looks too short to be valid.", variant: "destructive" });
      return;
    }
    if (webhookSecret.trim() !== "" && webhookSecret.trim().length < 16) {
      toast({ title: "Webhook secret too short", description: "The signing secret must be at least 16 characters.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        enabled: draft.enabled,
        autoReplies: draft.autoReplies,
        sessionName: draft.sessionName.trim(),
        testRecipient: draft.testRecipient.trim(),
      };
      // The gateway URL is validated as a URL server-side — only send a value.
      if (draft.gatewayBaseUrl.trim() !== "") payload.gatewayBaseUrl = draft.gatewayBaseUrl.trim();
      // Stored secrets are never read back — only sent when freshly typed.
      if (apiKey.trim() !== "") payload.apiKey = apiKey.trim();
      if (webhookSecret.trim() !== "") payload.webhookSecret = webhookSecret.trim();
      await api.patch("/api/v1/whatsapp/config", payload);
      setApiKey("");
      setWebhookSecret("");
      toast({ title: "WhatsApp configuration saved" });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const clearApiKey = async () => {
    setClearingKey(true);
    try {
      await api.patch("/api/v1/whatsapp/config", { apiKey: null });
      setApiKey("");
      toast({ title: "Stored API key cleared", description: "Gateway calls will fail until a new key is saved." });
      await load();
    } catch (e) {
      toast({ title: "Could not clear the API key", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setClearingKey(false);
    }
  };

  const clearWebhookSecret = async () => {
    setClearingSecret(true);
    try {
      await api.patch("/api/v1/whatsapp/config", { webhookSecret: null });
      setWebhookSecret("");
      toast({ title: "Stored webhook secret cleared", description: "Webhook deliveries will be rejected until a new secret is saved." });
      await load();
    } catch (e) {
      toast({ title: "Could not clear the webhook secret", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setClearingSecret(false);
    }
  };

  if (loading) return <LoadingState label="Loading WhatsApp session status…" />;
  if (error || !session) return <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />;

  const ui = session.uiState;

  return (
    <div className="space-y-4">
      {/* ── Live session status ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Session status
          </CardTitle>
          <CardDescription>
            Live state of the OpenWA gateway session — probed on the server, refreshed automatically every 15 seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge data-testid="whatsapp-connection-status" variant="outline" className={"whitespace-nowrap " + uiStateBadgeClass(ui)}>
              {uiStateLabel(ui)}
            </Badge>
            {session.webhookRegistered ? (
              <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">Webhook active</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Webhook not registered</Badge>
            )}
            {!session.enabled ? (
              <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">Integration disabled</Badge>
            ) : null}
            <Button variant="outline" size="sm" className="sm:ml-auto" data-testid="whatsapp-refresh-status" onClick={() => void refreshSession()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
          </div>

          {session.error ? (
            <p className="text-xs text-red-700 break-words rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-2.5">{session.error}</p>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Session name</p>
              <p className="font-medium font-mono text-xs break-all">{session.sessionName || "—"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Phone</p>
              <p className="font-medium font-mono text-xs">{session.phone || "—"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Push name</p>
              <p className="font-medium text-xs truncate">{session.pushName || "—"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Gateway status</p>
              <p className="font-medium font-mono text-xs">{session.sessionStatus || "unknown"}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Last connected</p>
              <p className="font-medium text-xs" title={when(session.lastConnectedAt)}>{rel(session.lastConnectedAt)}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Last heartbeat</p>
              <p className="font-medium text-xs" title={when(session.lastHeartbeatAt)}>{rel(session.lastHeartbeatAt)}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Last inbound</p>
              <p className="font-medium text-xs" title={when(session.lastInboundAt)}>{rel(session.lastInboundAt)}</p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-xs text-muted-foreground">Last outbound</p>
              <p className="font-medium text-xs" title={when(session.lastOutboundAt)}>{rel(session.lastOutboundAt)}</p>
            </div>
          </div>

          {/* Actions row */}
          {canConnect ? (
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" data-testid="whatsapp-connect" disabled={busyAction !== null || ui === "CONNECTED"} onClick={() => void connect()}>
                <Link2 className={"h-3.5 w-3.5 mr-1.5" + (busyAction === "connect" ? " animate-pulse" : "")} />
                {busyAction === "connect" ? "Connecting…" : "Connect"}
              </Button>
              <Button size="sm" variant="outline" data-testid="whatsapp-show-qr" disabled={busyAction !== null} onClick={() => setQrOpen(true)}>
                <QrCode className="h-3.5 w-3.5 mr-1.5" /> Show QR
              </Button>
              <Button size="sm" variant="outline" disabled={busyAction !== null} onClick={() => { setPairOpen(true); setPairCode(null); setPairPhone(""); }}>
                <KeyRound className="h-3.5 w-3.5 mr-1.5" /> Pairing code
              </Button>
              <Button size="sm" variant="outline" data-testid="whatsapp-reconnect" disabled={busyAction !== null} onClick={() => void reconnect()}>
                <RefreshCw className={"h-3.5 w-3.5 mr-1.5" + (busyAction === "reconnect" ? " animate-spin" : "")} />
                {busyAction === "reconnect" ? "Reconnecting…" : "Reconnect"}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" data-testid="whatsapp-disconnect" disabled={busyAction !== null || ui === "DISCONNECTED"} onClick={() => setDisconnectOpen(true)}>
                <Unlink className="h-3.5 w-3.5 mr-1.5" /> Disconnect
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground border-t pt-3">
              Connecting, QR pairing and disconnection require the WhatsApp connect permission.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Test message ── */}
      {canSend ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4 text-primary" /> Test message
            </CardTitle>
            <CardDescription>
              Sends one real message through the gateway. The result is honest — sent, queued, or the failure reason.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wa-test-to">To (phone)</Label>
                <Input
                  id="wa-test-to"
                  type="tel"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="+6737123456"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wa-test-message">Message</Label>
                <Textarea
                  id="wa-test-message"
                  rows={2}
                  value={testMessage}
                  onChange={(e) => setTestMessage(e.target.value)}
                  placeholder="Hello from MOHD.HMS Enterprise 👋"
                />
              </div>
            </div>
            <Button data-testid="whatsapp-test-send" disabled={sending} onClick={() => void sendTest()}>
              <Send className="h-4 w-4 mr-1.5" /> {sending ? "Sending…" : "Send test message"}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* ── Configuration ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-primary" /> Configuration
          </CardTitle>
          <CardDescription>
            {canConfig
              ? "OpenWA gateway connection and integration switches. The API key and webhook secret are write-only — they are never sent back to the browser."
              : "Read-only — ask an administrator to change the WhatsApp configuration."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canConfig && draft && config ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wa-cfg-url">Gateway base URL</Label>
                  <Input
                    id="wa-cfg-url"
                    value={draft.gatewayBaseUrl}
                    onChange={(e) => setDraft((d) => d && ({ ...d, gatewayBaseUrl: e.target.value }))}
                    placeholder="http://127.0.0.1:2785"
                  />
                  <p className="text-xs text-muted-foreground">OpenWA REST endpoint — server-side only.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-cfg-session">Session name</Label>
                  <Input
                    id="wa-cfg-session"
                    value={draft.sessionName}
                    onChange={(e) => setDraft((d) => d && ({ ...d, sessionName: e.target.value.replace(/[^a-zA-Z0-9-]/g, "") }))}
                    placeholder="mohd-hms-production"
                  />
                  <p className="text-xs text-muted-foreground">Letters, digits and dashes only.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-cfg-api-key">Gateway API key</Label>
                  <div className="flex gap-2">
                    <Input
                      id="wa-cfg-api-key"
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={config.hasApiKey ? `Stored ${config.apiKeyHint} — leave blank to keep` : "Not set"}
                      autoComplete="new-password"
                    />
                    {config.hasApiKey ? (
                      <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" disabled={clearingKey} onClick={() => void clearApiKey()}>
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">Write-only — blank keeps the stored key.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-cfg-secret">Webhook signing secret</Label>
                  <div className="flex gap-2">
                    <Input
                      id="wa-cfg-secret"
                      type="password"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder={config.hasWebhookSecret ? "Stored — leave blank to keep" : "Not set"}
                      autoComplete="new-password"
                    />
                    {config.hasWebhookSecret ? (
                      <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" disabled={clearingSecret} onClick={() => void clearWebhookSecret()}>
                        Clear
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">Minimum 16 characters. Write-only — blank keeps the stored secret.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-cfg-test-recipient">Test recipient</Label>
                  <Input
                    id="wa-cfg-test-recipient"
                    type="tel"
                    value={draft.testRecipient}
                    onChange={(e) => setDraft((d) => d && ({ ...d, testRecipient: e.target.value }))}
                    placeholder="+6737123456"
                  />
                  <p className="text-xs text-muted-foreground">Pre-fills the test message recipient above.</p>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <Label htmlFor="wa-cfg-enabled" className="text-sm font-medium">Integration enabled</Label>
                      <p className="text-xs text-muted-foreground">Kill switch — off blocks every send and auto-reply.</p>
                    </div>
                    <Switch
                      id="wa-cfg-enabled"
                      checked={draft.enabled}
                      onCheckedChange={(on) => setDraft((d) => d && ({ ...d, enabled: on }))}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div>
                      <Label htmlFor="wa-cfg-auto" className="text-sm font-medium">Auto-replies</Label>
                      <p className="text-xs text-muted-foreground">Inbound intents answered by the bot (HELP, status…).</p>
                    </div>
                    <Switch
                      id="wa-cfg-auto"
                      checked={draft.autoReplies}
                      onCheckedChange={(on) => setDraft((d) => d && ({ ...d, autoReplies: on }))}
                    />
                  </div>
                </div>
              </div>
              <div className="border-t pt-3">
                <Button data-testid="whatsapp-config-save" disabled={saving} onClick={() => void saveConfig()}>
                  <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : "Save configuration"}
                </Button>
              </div>
            </>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Enabled</p><p className="font-medium">{session.enabled ? "Yes" : "No"}</p></div>
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Session</p><p className="font-medium font-mono text-xs">{session.sessionName || "—"}</p></div>
              <div className="rounded-lg border p-2.5"><p className="text-xs text-muted-foreground">Webhook</p><p className="font-medium">{session.webhookRegistered ? "Registered" : "Not registered"}</p></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">Full configuration editing requires the WhatsApp configuration permission.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── QR dialog ── */}
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link a device</DialogTitle>
            <DialogDescription>
              Scan with WhatsApp → Linked devices. Only a live QR is shown — the image refreshes automatically every 10 seconds and the dialog closes on success.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            {qr ? (
              <>
                <img
                  src={qr}
                  alt="WhatsApp session QR code"
                  width={280}
                  height={280}
                  className="rounded-lg border bg-white p-2"
                  style={{ width: 280, height: 280 }}
                  data-testid="whatsapp-qr-image"
                />
                <p className="text-xs text-muted-foreground text-center" aria-live="polite" data-testid="whatsapp-qr-age">
                  {qrAge < 15
                    ? "QR is fresh — scan it now"
                    : "QR may have rotated — a fresh one loads automatically"}
                  {" "}· fetched {qrAge}s ago
                </p>
              </>
            ) : qrWaiting ? (
              <div
                className="h-[280px] w-[280px] rounded-lg border border-amber-300 bg-amber-50 flex flex-col items-center justify-center gap-3 p-6 text-center"
                data-testid="whatsapp-qr-waiting"
              >
                <Loader2 className="h-8 w-8 text-amber-600 animate-spin" aria-hidden />
                <p className="text-sm font-medium text-amber-800">Waiting for a fresh QR</p>
                <p className="text-xs text-amber-700 break-words">{qrWaiting}</p>
              </div>
            ) : qrError ? (
              <div
                className="h-[280px] w-[280px] rounded-lg border bg-muted/30 flex flex-col items-center justify-center gap-2 p-4 text-center"
                data-testid="whatsapp-qr-error"
              >
                <p className="text-sm text-red-700 break-words">{qrError}</p>
                <p className="text-xs text-muted-foreground">A QR exists only while the gateway session waits for a scan (status qr_ready).</p>
              </div>
            ) : (
              <div className="h-[280px] w-[280px] rounded-lg border bg-muted/30 animate-pulse" aria-hidden />
            )}
            <p className="text-xs text-muted-foreground text-center">WhatsApp → Settings → Linked devices → Link a device</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {qr && !qrLoading ? (
                <Button size="sm" variant="outline" onClick={() => void fetchQr()}>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh QR
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => void refreshPairing()} disabled={refreshingPairing} data-testid="whatsapp-qr-refresh-pairing">
                {refreshingPairing
                  ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden />
                  : <RefreshCw className="h-3.5 w-3.5 mr-1.5" aria-hidden />}
                {refreshingPairing ? "Refreshing…" : "Refresh pairing"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setQrOpen(false); setPairOpen(true); }} data-testid="whatsapp-qr-use-pairing-code">
                <Smartphone className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Use pairing code
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground text-center max-w-[340px]">
              If your phone says “No device found”, the code you scanned had already expired — scan only the QR currently displayed, or switch to the pairing code, which does not rely on scanning.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setQrOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Pairing code dialog ── */}
      <Dialog open={pairOpen} onOpenChange={(o) => { setPairOpen(o); if (!o) setPairCode(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pair with a phone number code</DialogTitle>
            <DialogDescription>
              Alternative to the QR — WhatsApp shows the same code under Linked devices → Link with phone number instead.
            </DialogDescription>
          </DialogHeader>
          {pairCode ? (
            <div className="space-y-3 text-center">
              <p className="text-xs text-muted-foreground">Enter this code in WhatsApp on the phone:</p>
              <p data-testid="whatsapp-pairing-code-value" className="font-mono text-4xl font-semibold tracking-[0.3em] select-all break-all">{pairCode}</p>
              <Button variant="outline" size="sm" onClick={() => { setPairCode(null); }}>
                Request another code
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="wa-pair-phone">Phone number (with country code)</Label>
                <Input
                  id="wa-pair-phone"
                  type="tel"
                  value={pairPhone}
                  onChange={(e) => setPairPhone(e.target.value)}
                  placeholder="+6737123456"
                  onKeyDown={(e) => { if (e.key === "Enter") void requestPairingCode(); }}
                />
              </div>
              <p className="text-xs text-muted-foreground">The gateway must be configured and the session initialized for pairing codes.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPairOpen(false)}>Close</Button>
            {!pairCode ? (
              <Button onClick={() => void requestPairingCode()} disabled={pairing}>
                {pairing ? "Requesting…" : "Get pairing code"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Disconnect confirm dialog ── */}
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect the WhatsApp session?</DialogTitle>
            <DialogDescription>
              The gateway stops the session — outbound and inbound WhatsApp traffic stops until it is connected again.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
            <Switch checked={logoutDevice} onCheckedChange={setLogoutDevice} aria-label="Log out device" data-testid="whatsapp-disconnect-logout" />
            <span className="space-y-0.5">
              <span className="text-sm font-medium block">Log out device (requires re-scan)</span>
              <span className="text-xs text-muted-foreground block">
                Unlinks the phone completely — connecting again needs a fresh QR scan or pairing code, not just a reconnect.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDisconnectOpen(false)}>Cancel</Button>
            <Button variant="destructive" data-testid="whatsapp-disconnect-confirm" disabled={busyAction !== null} onClick={() => void disconnect()}>
              <Unlink className="h-4 w-4 mr-1.5" /> {busyAction === "disconnect" ? "Disconnecting…" : logoutDevice ? "Log out device" : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Templates — catalog, versioned editor with sandboxed preview                */
/*────────────────────────────────────────────────────────────────────────────*/

function WhatsAppTemplates({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();

  const [rows, setRows] = useState<TemplateRow[]>([]);
  const [meta, setMeta] = useState<WhatsAppMeta>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<TemplateRow[]>("/api/v1/whatsapp/templates");
      setRows(res.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load WhatsApp templates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api.get<WhatsAppMeta>("/api/v1/whatsapp/meta")
      .then((res) => setMeta(res.data ?? {}))
      .catch(() => setMeta({})); // category list is optional — never blocks the catalog
  }, [load]);

  // ── Editor state (shared by edit + create) ──
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  const [form, setForm] = useState<TemplateForm>({ key: "", name: "", category: "SYSTEM", description: "", body: "" });
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const openEditor = (t: TemplateRow) => {
    setEditing(t);
    setCreateMode(false);
    setPreview(null);
    setForm({ key: t.key, name: t.name, category: t.category ?? "SYSTEM", description: t.description ?? "", body: t.body ?? "" });
    setEditorOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setCreateMode(true);
    setPreview(null);
    setForm({ key: "", name: "", category: meta.categories?.[0] ?? "SYSTEM", description: "", body: "" });
    setEditorOpen(true);
  };

  const insertVar = (v: string) => {
    const el = bodyRef.current;
    const value = form.body;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const next = value.slice(0, start) + "{{" + v + "}}" + value.slice(end);
    setForm((f) => ({ ...f, body: next }));
    const caret = start + v.length + 4;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  };

  const renderPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await api.patch<{ preview: string }>(`/api/v1/whatsapp/templates/${editing?.id ?? ""}`, {
        body: form.body,
        preview: SAMPLE_PREVIEW,
      });
      setPreview(res.data.preview);
    } catch (e) {
      setPreview(null);
      toast({ title: "Preview failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  const saveEditor = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name required", description: "Give the template a display name first.", variant: "destructive" });
      return;
    }
    if (createMode && !/^[A-Z0-9_]{2,60}$/.test(form.key.trim())) {
      toast({ title: "Key invalid", description: "The key must be UPPER_SNAKE_CASE (2–60 characters).", variant: "destructive" });
      return;
    }
    if (!form.body.trim()) {
      toast({ title: "Body required", description: "Write the WhatsApp message body — it cannot be empty.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (createMode) {
        await api.post("/api/v1/whatsapp/templates", {
          key: form.key.trim(),
          name: form.name.trim(),
          category: form.category || "SYSTEM",
          description: form.description.trim(),
          body: form.body,
        });
        toast({ title: "Template created", description: `${form.name.trim()} is ready to use.` });
      } else if (editing) {
        await api.patch(`/api/v1/whatsapp/templates/${editing.id}`, {
          name: form.name.trim(),
          description: form.description.trim(),
          body: form.body,
        });
        toast({ title: "Template saved", description: `${form.name.trim()} updated — the previous body stays in version history.` });
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      // Validation errors from the API are shown verbatim.
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const editingVariables = createMode
    ? [] // variables are extracted server-side from the body once saved
    : parseJson<string[]>(editing?.variables, []).filter((v) => typeof v === "string" && v.trim() !== "");

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <p className="text-sm text-muted-foreground">
          Plain-text WhatsApp message bodies with <code className="font-mono">&apos;{"{{VARIABLE}}"}&apos;</code> placeholders.
        </p>
        {canEdit ? (
          <Button onClick={openCreate} className="sm:ml-auto" size="sm">
            <Plus className="h-4 w-4 mr-1.5" /> New template
          </Button>
        ) : null}
      </div>

      {loading ? (
        <LoadingState label="Loading WhatsApp templates…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No templates" hint="No WhatsApp template exists yet." />
      ) : (
        <Card data-testid="whatsapp-templates-list">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-primary" /> Templates
            </CardTitle>
            <CardDescription>
              {rows.length} template{rows.length === 1 ? "" : "s"}
              {canEdit ? " — edits are versioned automatically." : " — read-only for your role."}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto hms-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead className="hidden lg:table-cell">Version</TableHead>
                  <TableHead className="hidden lg:table-cell">Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium flex flex-wrap items-center gap-1.5">
                        {t.name}
                        {t.isSystem ? <Badge variant="outline" className="text-[10px] text-muted-foreground">system</Badge> : null}
                        {!t.isActive ? <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">inactive</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">{t.key}</div>
                      <div className="text-xs text-muted-foreground sm:hidden">
                        {(t.category || "—") + " · v" + t.version + " · " + when(t.updatedAt)}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {t.category ? <Badge variant="outline">{t.category}</Badge> : "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge variant="outline" className="font-mono">v{t.version}</Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{when(t.updatedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" className="h-7" data-testid="whatsapp-template-edit" onClick={() => openEditor(t)}>
                        {canEdit ? "Edit" : "View"}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Editor / viewer dialog ── */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {createMode ? "New WhatsApp template" : `Template — ${editing?.name ?? ""}`}
              {!createMode && editing ? <Badge variant="outline" className="font-mono">v{editing.version}</Badge> : null}
              {!canEdit ? <Badge variant="outline" className="text-muted-foreground">read-only</Badge> : null}
            </DialogTitle>
            <DialogDescription>
              {canEdit
                ? "Saving a changed body snapshots a new version — the previous body stays in the history below."
                : "You can view this template but not edit it — template management requires the WhatsApp templates permission."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {createMode ? (
                <div className="space-y-1.5">
                  <Label htmlFor="watpl-key">Key (UPPER_SNAKE)</Label>
                  <Input
                    id="watpl-key"
                    value={form.key}
                    disabled={!canEdit}
                    onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "") }))}
                    placeholder="E.g. WO_COMPLETED"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label>Key</Label>
                  <Input value={editing?.key ?? ""} disabled />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="watpl-name">Name</Label>
                <Input
                  id="watpl-name"
                  value={form.name}
                  disabled={!canEdit}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="E.g. Work order completed"
                />
              </div>
              {createMode ? (
                <div className="space-y-1.5">
                  <Label htmlFor="watpl-category">Category</Label>
                  <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                    <SelectTrigger id="watpl-category" disabled={!canEdit}><SelectValue placeholder="Select category" /></SelectTrigger>
                    <SelectContent>
                      {(meta.categories ?? []).map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              <div className={"space-y-1.5 " + (createMode ? "" : "sm:col-span-1")}>
                <div className="space-y-1.5">
                  <Label htmlFor="watpl-desc">Description</Label>
                  <Input
                    id="watpl-desc"
                    value={form.description}
                    disabled={!canEdit}
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="What this template is used for"
                  />
                </div>
              </div>
            </div>

            {/* Variable chips — click inserts {{VAR}} at the caret */}
            {editingVariables.length > 0 ? (
              <div className="space-y-1.5">
                <Label>Variables</Label>
                <div className="flex flex-wrap gap-1.5">
                  {editingVariables.map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={!canEdit}
                      className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs hover:bg-primary/10 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => insertVar(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Body */}
            <div className="space-y-1.5">
              <Label htmlFor="watpl-body">Body (plain text)</Label>
              <Textarea
                id="watpl-body"
                ref={bodyRef}
                className="font-mono text-xs min-h-[200px]"
                value={form.body}
                disabled={!canEdit}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                placeholder={"Hi {{CUSTOMER_NAME}}, your work order {{WORK_ORDER_NUMBER}} is completed."}
              />
              <p className="text-xs text-muted-foreground">
                Unresolved variables are blanked on send — the allowlist is rebuilt from the body automatically.
              </p>
            </div>

            {/* Preview — renders the proposed body with sample data (never persisted) */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="whatsapp-template-preview"
                  disabled={!editing || previewLoading}
                  onClick={() => void renderPreview()}
                >
                  <QrCode className="h-4 w-4 mr-1.5" /> {preview ? "Refresh preview" : "Preview"}
                </Button>
                {preview ? <Badge variant="outline" className="bg-amber-50 text-amber-800 border-amber-200">PREVIEW — sample data</Badge> : null}
              </div>
              {previewLoading ? <LoadingState label="Rendering preview…" rows={2} /> : null}
              {preview ? (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="whitespace-pre-wrap text-sm break-words">{preview}</p>
                </div>
              ) : null}
            </div>

            {/* Version history — included in the list payload */}
            {!createMode && editing && (editing.versions ?? []).length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <Label>Version history</Label>
                <div className="space-y-1.5">
                  {editing.versions.map((v) => (
                    <div key={v.id ?? v.version} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-sm">
                      <Badge variant="outline" className="font-mono">v{v.version}</Badge>
                      <span className="text-xs text-muted-foreground">{when(v.createdAt)}</span>
                      {v.editedBy ? <span className="text-xs text-muted-foreground truncate max-w-[220px]">· {v.editedBy}</span> : null}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">Latest 5 versions are listed; every content edit is snapshotted server-side.</p>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>{canEdit ? "Cancel" : "Close"}</Button>
            {canEdit ? (
              <Button onClick={() => void saveEditor()} data-testid="whatsapp-template-save" disabled={saving}>
                <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : createMode ? "Create template" : "Save template"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Automations — event rules with recipient rules and PDF attachments          */
/*────────────────────────────────────────────────────────────────────────────*/

function WhatsAppAutomations({ canManage }: { canManage: boolean }) {
  const { user } = useSession();
  const { toast } = useToast();
  const isSuper = user?.role === "SUPER_ADMIN";

  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [meta, setMeta] = useState<WhatsAppMeta>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, metaRes] = await Promise.all([
        api.get<AutomationRow[]>("/api/v1/whatsapp/automations"),
        api.get<WhatsAppMeta>("/api/v1/whatsapp/meta").catch(() => ({ data: {} as WhatsAppMeta })),
      ]);
      setRows(list.data ?? []);
      setMeta(metaRes.data ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load WhatsApp automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (a: AutomationRow) => {
    setBusyId(a.id);
    try {
      await api.patch(`/api/v1/whatsapp/automations/${a.id}`, { enabled: !a.enabled });
      toast({ title: !a.enabled ? "Automation enabled" : "Automation paused", description: a.name });
      await load();
    } catch (e) {
      // 403 on critical automations (Super Admin only) — surface the server message verbatim.
      toast({ title: "Could not update automation", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  // ── Create dialog ──
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<AutoForm | null>(null);
  const [saving, setSaving] = useState(false);

  const openCreate = () => {
    setForm({
      name: "",
      eventType: meta.events?.[0] ?? "",
      templateKey: meta.templateKeys?.[0]?.key ?? "",
      ruleKind: meta.recipientKinds?.[0] ?? "CUSTOMER",
      ruleValue: "",
      attachment: "",
      dedupeHours: "0",
      enabled: true,
    });
    setCreateOpen(true);
  };

  const needsRuleValue = form ? ["ROLE", "FIXED"].includes(form.ruleKind) : false;
  const attachmentKinds = meta.attachmentKinds ?? FALLBACK_ATTACHMENT_KINDS;

  const saveCreate = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast({ title: "Name required", description: "Give the automation a name first.", variant: "destructive" });
      return;
    }
    if (!form.eventType) {
      toast({ title: "Event required", description: "Pick the event that triggers this automation.", variant: "destructive" });
      return;
    }
    if (!form.templateKey) {
      toast({ title: "Template required", description: "Pick the WhatsApp template to send.", variant: "destructive" });
      return;
    }
    if (needsRuleValue && form.ruleValue.trim() === "") {
      toast({ title: `${form.ruleKind === "ROLE" ? "Role" : "Phone number"} required`, description: "This recipient rule needs a value.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/v1/whatsapp/automations", {
        name: form.name.trim(),
        eventType: form.eventType,
        templateKey: form.templateKey,
        recipientRule: {
          kind: form.ruleKind,
          ...(needsRuleValue ? { value: form.ruleValue.trim() } : {}),
        },
        attachments: form.attachment ? [form.attachment] : [],
        dedupeHours: Math.max(0, Number(form.dedupeHours) || 0),
        enabled: form.enabled,
      });
      toast({ title: "Automation created", description: `${form.name.trim()} — disable it if it should not run yet.` });
      setCreateOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Create failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ── Delete dialog ──
  const [deleteFor, setDeleteFor] = useState<AutomationRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async () => {
    if (!deleteFor) return;
    setDeleting(true);
    try {
      await api.del(`/api/v1/whatsapp/automations/${deleteFor.id}`);
      toast({ title: "Automation deleted", description: deleteFor.name });
      setDeleteFor(null);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  const templateName = (key: string) => meta.templateKeys?.find((t) => t.key === key)?.name ?? key;

  return (
    <div className="space-y-4">
      {loading ? (
        <LoadingState label="Loading WhatsApp automations…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No WhatsApp automations"
          hint="Automations send WhatsApp messages when events happen. Create the first rule to get started."
          action={canManage ? <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" /> New automation</Button> : undefined}
        />
      ) : (
        <Card data-testid="whatsapp-automations-list">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" /> Automations
            </CardTitle>
            <CardDescription>
              {rows.length} rule{rows.length === 1 ? "" : "s"}
              {canManage ? " — changes apply to future events immediately." : " — read-only for your role."}
              {isSuper ? " Critical rules are Super Admin only." : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-96 overflow-y-auto hms-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead className="hidden md:table-cell">Event</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead className="hidden lg:table-cell">Recipients</TableHead>
                  <TableHead className="hidden xl:table-cell">Dedupe</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const rule = parseJson<RecipientRule>(a.recipientRule, { kind: "" });
                  const switchDisabled = !canManage || (!isSuper && a.critical) || busyId === a.id;
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium flex flex-wrap items-center gap-1.5">
                          {a.name}
                          {a.critical ? (
                            <TooltipProvider delayDuration={150}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className="text-[10px] border-red-300 text-red-700 gap-0.5">
                                    <ShieldAlert className="h-3 w-3" aria-hidden /> critical
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>Super Admin only</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="font-mono text-[11px]">{a.eventType}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm truncate max-w-[180px]">{templateName(a.templateKey)}</div>
                        <div className="text-xs text-muted-foreground font-mono">{a.templateKey}</div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{recipientSummary(rule)}</TableCell>
                      <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
                        {a.dedupeHours > 0 ? `${a.dedupeHours}h` : "—"}
                      </TableCell>
                      <TableCell>
                        <TooltipProvider delayDuration={200}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Switch
                                  checked={a.enabled}
                                  disabled={switchDisabled}
                                  aria-label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`}
                                  onCheckedChange={() => void toggle(a)}
                                  data-testid="whatsapp-automation-toggle"
                                />
                              </span>
                            </TooltipTrigger>
                            {!canManage ? <TooltipContent>Requires the WhatsApp automations permission</TooltipContent> : null}
                            {canManage && !isSuper && a.critical ? <TooltipContent>Critical automations need the Super Admin</TooltipContent> : null}
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right">
                        {canManage ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-destructive hover:text-destructive"
                            data-testid="whatsapp-automation-delete"
                            disabled={busyId === a.id}
                            onClick={() => setDeleteFor(a)}
                          >
                            <Trash2 className="h-3 w-3 mr-1" /> Delete
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {canManage && rows.length > 0 ? (
        <div>
          <Button variant="outline" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> New automation
          </Button>
        </div>
      ) : null}

      {/* ── Create dialog ── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New WhatsApp automation</DialogTitle>
            <DialogDescription>
              When the event fires, the template is rendered with real event data and delivered per the recipient rule.
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wa-auto-name">Name</Label>
                  <Input
                    id="wa-auto-name"
                    value={form.name}
                    onChange={(e) => setForm((f) => f && ({ ...f, name: e.target.value }))}
                    placeholder="E.g. Complaint created — customer confirmation"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wa-auto-event">Event</Label>
                  <Select value={form.eventType} onValueChange={(v) => setForm((f) => f && ({ ...f, eventType: v }))}>
                    <SelectTrigger id="wa-auto-event"><SelectValue placeholder="Select event" /></SelectTrigger>
                    <SelectContent>
                      {(meta.events ?? []).map((ev) => (
                        <SelectItem key={ev} value={ev}><span className="font-mono text-xs">{ev}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="wa-auto-template">Template</Label>
                  <Select value={form.templateKey} onValueChange={(v) => setForm((f) => f && ({ ...f, templateKey: v }))}>
                    <SelectTrigger id="wa-auto-template"><SelectValue placeholder="Select template" /></SelectTrigger>
                    <SelectContent>
                      {(meta.templateKeys ?? []).map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          <span className="font-mono text-xs">{t.key}</span> — {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Recipient rule */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label>Recipients</Label>
                  <Select value={form.ruleKind} onValueChange={(v) => setForm((f) => f && ({ ...f, ruleKind: v, ruleValue: "" }))}>
                    <SelectTrigger aria-label="Recipient rule kind"><SelectValue placeholder="Select rule" /></SelectTrigger>
                    <SelectContent>
                      {(meta.recipientKinds ?? ["CUSTOMER", "RELATED_USER", "ROLE", "FIXED"]).map((k) => (
                        <SelectItem key={k} value={k}>{k}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  {form.ruleKind === "ROLE" ? (
                    <>
                      <Label htmlFor="wa-auto-rule-value">Role</Label>
                      <Select value={form.ruleValue} onValueChange={(v) => setForm((f) => f && ({ ...f, ruleValue: v }))}>
                        <SelectTrigger id="wa-auto-rule-value"><SelectValue placeholder="Select role" /></SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  ) : form.ruleKind === "FIXED" ? (
                    <>
                      <Label htmlFor="wa-auto-rule-value">Phone number</Label>
                      <Input
                        id="wa-auto-rule-value"
                        type="tel"
                        value={form.ruleValue}
                        onChange={(e) => setForm((f) => f && ({ ...f, ruleValue: e.target.value }))}
                        placeholder="+6737123456"
                      />
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-6">
                      {form.ruleKind === "CUSTOMER"
                        ? "Resolved per event — the customer's WhatsApp number on the related record."
                        : form.ruleKind === "RELATED_USER"
                          ? "Resolved per event — the related user's WhatsApp number (e.g. the assignee)."
                          : "Pick a recipient rule first."}
                    </p>
                  )}
                </div>
              </div>

              {/* Attachments — the API allows at most one */}
              <div className="space-y-2">
                <Label>Attachment (optional — at most one)</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {attachmentKinds.map((k) => (
                    <label key={k} className="flex items-center gap-2 rounded-lg border p-2.5 text-sm cursor-pointer hover:bg-muted/40">
                      <Checkbox
                        checked={form.attachment === k}
                        onCheckedChange={(on) => setForm((f) => f && ({ ...f, attachment: on === true ? k : "" }))}
                        aria-label={`Attach ${k}`}
                      />
                      <span className="font-mono text-xs">{k}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  PDFs resolved through the central document engine (quotation, invoice, work order…).
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="wa-auto-dedupe">Dedupe window (hours)</Label>
                  <Input
                    id="wa-auto-dedupe"
                    type="number"
                    min={0}
                    value={form.dedupeHours}
                    onChange={(e) => setForm((f) => f && ({ ...f, dedupeHours: e.target.value }))}
                  />
                  <p className="text-xs text-muted-foreground">0 = no deduplication.</p>
                </div>
                <div className="flex items-center justify-between gap-3 rounded-lg border p-3 mt-6">
                  <div>
                    <Label htmlFor="wa-auto-enabled" className="text-sm font-medium">Enabled</Label>
                    <p className="text-xs text-muted-foreground">Disabled rules never fire.</p>
                  </div>
                  <Switch
                    id="wa-auto-enabled"
                    checked={form.enabled}
                    onCheckedChange={(on) => setForm((f) => f && ({ ...f, enabled: on }))}
                  />
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => void saveCreate()} data-testid="whatsapp-automation-save" disabled={saving || !form}>
              <Save className="h-4 w-4 mr-1.5" /> {saving ? "Creating…" : "Create automation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ── */}
      <Dialog open={deleteFor !== null} onOpenChange={(o) => { if (!o) setDeleteFor(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete automation?</DialogTitle>
            <DialogDescription>
              <span className="font-medium">{deleteFor?.name}</span> stops triggering immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)}>Cancel</Button>
            <Button variant="destructive" data-testid="whatsapp-automation-delete-confirm" disabled={deleting} onClick={() => void confirmDelete()}>
              <Trash2 className="h-4 w-4 mr-1.5" /> {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Logs — filterable message log with detail dialog + retry/cancel             */
/*────────────────────────────────────────────────────────────────────────────*/

function WhatsAppLogs() {
  const { user } = useSession();
  const { toast } = useToast();
  const canAct = hasPerm(user, PERMISSIONS.whatsapp_actions);

  const [meta, setMeta] = useState<WhatsAppMeta>({});
  const [status, setStatus] = useState("all");
  const [direction, setDirection] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<MessageRow | null>(null);
  const [acting, setActing] = useState<"retry" | "cancel" | null>(null);

  useEffect(() => {
    api.get<WhatsAppMeta>("/api/v1/whatsapp/meta")
      .then((res) => setMeta(res.data ?? {}))
      .catch(() => setMeta({})); // status filter list is optional — never blocks the log
  }, []);

  const load = useCallback(async (st: string, dir: string, s: string, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<MessageRow[]>(`/api/v1/whatsapp/messages${qs({
        status: st !== "all" ? st : undefined,
        direction: dir !== "all" ? dir : undefined,
        search: s || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })}`);
      setRows(res.data ?? []);
      setTotal(Number(res.meta?.total ?? (res.data?.length ?? 0)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load WhatsApp messages.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced fetch (covers initial load); page resets when filters change.
  useEffect(() => {
    const t = setTimeout(() => { void load(status, direction, search, page); }, 350);
    return () => clearTimeout(t);
  }, [load, status, direction, search, page]);

  useEffect(() => {
    setPage(1);
  }, [status, direction, search]);

  const clearFilters = () => {
    setStatus("all");
    setDirection("all");
    setSearch("");
    setPage(1);
  };

  const messageAction = async (m: MessageRow, action: "retry" | "cancel") => {
    setActing(action);
    try {
      const res = await api.post<{ id: string; status?: string }>(`/api/v1/whatsapp/messages/${m.id}`, { action });
      toast({
        title: action === "retry" ? "Message re-queued" : "Message canceled",
        description: res.data?.status ? `New status: ${res.data.status}.` : undefined,
      });
      setDetail((d) => (d && d.id === m.id ? { ...d, status: res.data?.status ?? d.status, lastError: null } : d));
      await load(status, direction, search, page);
    } catch (e) {
      toast({ title: action === "retry" ? "Retry failed" : "Cancel failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, total);

  // Retry makes sense for anything not yet delivered; cancel only while it
  // is still pending — the server rejects impossible actions honestly.
  const canRetry = (m: MessageRow) => m.direction === "OUTBOUND" && ["FAILED", "CANCELED", "QUEUED"].includes(m.status);
  const canCancel = (m: MessageRow) => m.direction === "OUTBOUND" && ["FAILED", "QUEUED", "SENDING"].includes(m.status);

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(meta.statuses ?? []).map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Direction</Label>
          <Select value={direction} onValueChange={setDirection}>
            <SelectTrigger aria-label="Filter by direction"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Both directions</SelectItem>
              <SelectItem value="INBOUND">INBOUND</SelectItem>
              <SelectItem value="OUTBOUND">OUTBOUND</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1 col-span-2 sm:col-span-1">
          <Label htmlFor="wa-log-search" className="text-xs">Search</Label>
          <Input id="wa-log-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Message text or chat id…" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
        <span className="text-xs text-muted-foreground">{loading ? "Loading…" : `${total} message${total === 1 ? "" : "s"}`}</span>
      </div>

      {loading ? (
        <LoadingState label="Loading WhatsApp messages…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load(status, direction, search, page)} />
      ) : rows.length === 0 ? (
        <EmptyState title="No WhatsApp messages" hint="No message matches the current filters." />
      ) : (
        <Card data-testid="whatsapp-logs-table">
          <CardContent className="max-h-[600px] overflow-y-auto hms-scroll p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead>Body</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden xl:table-cell">Template</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow
                    key={m.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={`Open message to ${m.contact?.waName || m.contact?.phone || m.chatId}`}
                    onClick={() => setDetail(m)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDetail(m); }
                    }}
                  >
                    <TableCell className="text-xs whitespace-nowrap">{when(m.createdAt)}</TableCell>
                    <TableCell className="text-xs max-w-[140px]">
                      <div className="flex items-center gap-1.5">
                        {m.direction === "INBOUND" ? (
                          <ArrowDownLeft className="h-3.5 w-3.5 text-primary shrink-0" aria-label="Inbound" />
                        ) : (
                          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-label="Outbound" />
                        )}
                        <span className="truncate">{m.contact?.waName || m.contact?.phone || m.chatId}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{m.type}</TableCell>
                    <TableCell className="text-xs max-w-[220px]">
                      <span className="block truncate">{m.body || (m.mediaFilename ? `📎 ${m.mediaFilename}` : "—")}</span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className={"whitespace-nowrap " + statusBadgeClass(m.status)}>{m.status}</Badge>
                        {m.isTest ? <Badge variant="outline" className="text-[10px]">TEST</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-xs font-mono text-muted-foreground max-w-[140px] truncate">
                      {m.templateKey ? `${m.templateKey}${m.templateVersion ? ` v${m.templateVersion}` : ""}` : "—"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums">{m.attemptCount}/{m.maxAttempts}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {total > 0 ? (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {rangeFrom}–{rangeTo} of {total}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Prev</Button>
            <Button size="sm" variant="outline" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      ) : null}

      {/* ── Detail dialog ── */}
      <Dialog open={detail !== null} onOpenChange={(o) => { if (!o) setDetail(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              Message
              {detail ? <Badge variant="outline" className={statusBadgeClass(detail.status)}>{detail.status}</Badge> : null}
              {detail?.isTest ? <Badge variant="outline" className="text-[10px]">TEST</Badge> : null}
            </DialogTitle>
            <DialogDescription>Full metadata of this WhatsApp message — straight from the log.</DialogDescription>
          </DialogHeader>

          {detail ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Contact</p>
                  <p className="font-medium break-all">{detail.contact?.waName || "—"}</p>
                  <p className="text-xs font-mono text-muted-foreground break-all">{detail.contact?.phone || detail.chatId}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Direction</p>
                  <p className="font-medium flex items-center gap-1.5">
                    {detail.direction === "INBOUND" ? (
                      <><ArrowDownLeft className="h-4 w-4 text-primary" aria-hidden /> Inbound</>
                    ) : (
                      <><ArrowUpRight className="h-4 w-4" aria-hidden /> Outbound</>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Type</p>
                  <p className="font-medium">{detail.type}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Attempts</p>
                  <p className="font-medium tabular-nums">{detail.attemptCount}/{detail.maxAttempts}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Template</p>
                  <p className="font-medium font-mono text-xs break-all">
                    {detail.templateKey ? `${detail.templateKey}${detail.templateVersion ? ` (v${detail.templateVersion})` : ""}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Provider message id</p>
                  <p className="font-medium font-mono text-xs break-all">{detail.providerMessageId || "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Related</p>
                  <p className="font-medium text-xs break-all">
                    {detail.relatedType ? `${detail.relatedType}${detail.relatedId ? ` · ${detail.relatedId.slice(0, 12)}…` : ""}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Conversation state</p>
                  <p className="font-medium">{detail.conversation?.state ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="font-medium">{when(detail.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Sent</p>
                  <p className="font-medium">{detail.sentAt ? when(detail.sentAt) : "—"}</p>
                </div>
                {detail.mediaFilename ? (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground">Media</p>
                    <p className="font-medium text-xs break-all">{detail.mediaFilename}{detail.mediaMimetype ? ` · ${detail.mediaMimetype}` : ""}</p>
                  </div>
                ) : null}
                {detail.errorClass ? (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground">Error class</p>
                    <p className="font-medium font-mono text-xs">{detail.errorClass}</p>
                  </div>
                ) : null}
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-1">Body</p>
                <p className="text-sm whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3">{detail.body || "—"}</p>
              </div>

              {detail.lastError ? (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Last error</p>
                  <p className="text-sm break-all rounded-md border border-red-200 bg-red-50 dark:bg-red-950/20 p-3 text-red-700">{detail.lastError}</p>
                </div>
              ) : null}

              {canAct && (canRetry(detail) || canCancel(detail)) ? (
                <div className="flex flex-wrap gap-2 border-t pt-3">
                  {canRetry(detail) ? (
                    <Button size="sm" variant="outline" data-testid="whatsapp-log-retry" disabled={acting !== null} onClick={() => void messageAction(detail, "retry")}>
                      <RefreshCw className={"h-3.5 w-3.5 mr-1.5" + (acting === "retry" ? " animate-spin" : "")} /> Retry
                    </Button>
                  ) : null}
                  {canCancel(detail) ? (
                    <Button size="sm" variant="outline" data-testid="whatsapp-log-cancel" disabled={acting !== null} onClick={() => void messageAction(detail, "cancel")}>
                      <Ban className="h-3.5 w-3.5 mr-1.5" /> Cancel
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {!canAct && detail.direction === "OUTBOUND" && ["FAILED", "CANCELED", "QUEUED"].includes(detail.status) ? (
                <p className="text-xs text-muted-foreground border-t pt-3">Retrying or canceling requires the WhatsApp actions permission.</p>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* Health — honest integration overview                                        */
/*────────────────────────────────────────────────────────────────────────────*/

function WhatsAppHealthPanel() {
  const [health, setHealth] = useState<WhatsAppHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.get<WhatsAppHealth>("/api/v1/whatsapp/health");
      setHealth(res.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load WhatsApp health.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState label="Loading WhatsApp health…" />;
  if (error || !health) return <ErrorState message={error ?? "Unknown error."} onRetry={() => void load()} />;

  const queueTiles: { label: string; value: number; tone: string }[] = [
    { label: "Queued", value: health.queue.queued, tone: health.queue.queued > 0 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Sending", value: health.queue.sending, tone: health.queue.sending > 0 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Sent", value: health.queue.sent, tone: "text-emerald-600" },
    { label: "Delivered", value: health.queue.delivered, tone: "text-emerald-600" },
    { label: "Read", value: health.queue.read, tone: "text-emerald-600" },
    { label: "Failed", value: health.queue.failed, tone: health.queue.failed > 0 ? "text-red-600" : "text-muted-foreground" },
  ];

  return (
    <div className="space-y-4">
      {!health.configOk ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-900 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
          <span>WhatsApp integration is disabled — enable it in Configuration.</span>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden /> Gateway</p>
          <div className="mt-1.5">
            {health.gateway.reachable ? (
              <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Reachable</Badge>
            ) : (
              <Badge variant="outline" className="bg-red-100 text-red-800 border-red-200">Unreachable</Badge>
            )}
            <p className="text-xs text-muted-foreground mt-1.5 break-words">{health.gateway.detail || "—"}</p>
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5 text-primary" aria-hidden /> API key</p>
          <div className="mt-1.5">
            {health.apiKeyValid ? (
              <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Valid</Badge>
            ) : (
              <Badge variant="outline" className="bg-amber-100 text-amber-800 border-amber-200">Not validated</Badge>
            )}
            <p className="text-xs text-muted-foreground mt-1.5">Validated live against the gateway when reachable.</p>
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5 text-primary" aria-hidden /> Session</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className={uiStateBadgeClass(health.session.connected ? "CONNECTED" : "DISCONNECTED")}>
              {health.session.status || "unknown"}
            </Badge>
            <p className="text-xs font-mono text-muted-foreground break-all">{health.session.phone || "—"}</p>
          </div>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-primary" aria-hidden /> Webhook</p>
          <div className="mt-1.5">
            {health.webhook.registered ? (
              <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-emerald-200">Registered</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Not registered</Badge>
            )}
            <p className="text-xs text-muted-foreground mt-1.5">Signed deliveries from OpenWA land here.</p>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" /> Message queue
          </CardTitle>
          <CardDescription>Every stored message by delivery state — receipts (delivered/read) come only from real acks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
            {queueTiles.map((c) => (
              <div key={c.label} className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className={"text-2xl font-semibold tabular-nums " + c.tone}>{c.value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-lg border p-2.5">
              <p className="text-muted-foreground mb-0.5">Last inbound</p>
              <p className="text-foreground">{rel(health.lastInboundAt)} <span className="text-muted-foreground">· {when(health.lastInboundAt)}</span></p>
            </div>
            <div className="rounded-lg border p-2.5">
              <p className="text-muted-foreground mb-0.5">Last outbound (delivered+)</p>
              <p className="text-foreground">{rel(health.lastOutboundAt)} <span className="text-muted-foreground">· {when(health.lastOutboundAt)}</span></p>
            </div>
          </div>
          <div>
            <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}>
              <RefreshCw className={"h-3.5 w-3.5 mr-1.5" + (refreshing ? " animate-spin" : "")} /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
