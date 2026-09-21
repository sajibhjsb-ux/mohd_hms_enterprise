"use client";

// MOHD.HMS ENTERPRISE — Email automation administration (Email Configuration → Automations).
// Rule-based email automations wired to template keys: enable/disable, full
// editor (recipient rules, conditions, attachments, retry policy), duplicate
// and per-automation delivery history. Critical rules are Super Admin only.

import { useCallback, useEffect, useState } from "react";
import { Copy, History, Paperclip, Plus, Save, Timer, Zap } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type EmailMeta = {
  events?: string[];
  templates?: { key: string; name: string; category?: string | null }[];
  roles?: string[];
  recipientKinds?: string[];
  conditionOps?: string[];
  attachmentKinds?: string[];
  moduleMailboxes?: { key: string; label: string; value: string }[];
};

type AutomationRow = {
  id: string;
  name: string;
  eventType: string;
  templateKey: string;
  template: { key: string; name: string; category: string | null } | null;
  recipientRule: string; // JSON string
  senderName: string | null;
  senderEmail: string | null;
  replyTo: string | null;
  delayMinutes: number;
  conditions: string; // JSON string
  attachments: string; // JSON string
  enabled: boolean;
  critical: boolean;
  maxAttempts: number;
  dedupeHours: number;
  recent: { sent: number; failed: number; queued: number };
};

type RecipientRule = { kind: string; value?: string };
type CondRow = { field: string; op: string; value: string };
type HistoryRow = {
  id: string;
  toEmail: string;
  subject: string | null;
  status: string;
  attemptCount: number;
  lastError?: string | null;
  createdAt: string;
};

type AutoForm = {
  name: string;
  eventType: string;
  templateKey: string;
  ruleKind: string;
  ruleValue: string;
  senderName: string;
  senderEmail: string;
  replyTo: string;
  delayMinutes: string;
  maxAttempts: string;
  dedupeHours: string;
  conditions: CondRow[];
  attachments: string[];
};

const PAGE_SIZE = 10;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Parse a JSON string defensively — malformed data never breaks the UI. */
function parseRule(json: string | null | undefined): RecipientRule {
  if (!json) return { kind: "" };
  try {
    const p = JSON.parse(json) as unknown;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const o = p as Record<string, unknown>;
      let value: string | undefined;
      if (Array.isArray(o.value)) value = o.value.map(String).join(", ");
      else if (o.value != null) value = String(o.value);
      return { kind: String(o.kind ?? ""), value };
    }
    if (typeof p === "string") return { kind: p };
    return { kind: "" };
  } catch {
    return { kind: json };
  }
}

function parseConditions(json: string | null | undefined): CondRow[] {
  if (!json) return [];
  try {
    const p: unknown = JSON.parse(json);
    if (!Array.isArray(p)) return [];
    return p.map((c) => {
      const o = (c ?? {}) as Record<string, unknown>;
      return { field: String(o.field ?? ""), op: String(o.op ?? ""), value: o.value == null ? "" : String(o.value) };
    });
  } catch {
    return [];
  }
}

function parseAttachments(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const p: unknown = JSON.parse(json);
    if (!Array.isArray(p)) return [];
    return p.map((a) => {
      if (typeof a === "string") return a;
      if (a && typeof a === "object") {
        const o = a as Record<string, unknown>;
        return String(o.kind ?? o.key ?? o.name ?? "");
      }
      return "";
    }).filter((s) => s !== "");
  } catch {
    return [];
  }
}

/** Humanized recipient summary from the stored rule JSON. */
function recipientSummary(rule: RecipientRule, mailboxes: { key: string; label: string; value: string }[]): string {
  const value = rule.value ?? "";
  switch (rule.kind) {
    case "CUSTOMER": return "Customer email";
    case "RELATED_USER": return "Related user";
    case "ROLE": return value ? `Role: ${value}` : "Role: —";
    case "MODULE_MAILBOX": {
      if (!value) return "Mailbox: —";
      const mb = mailboxes.find((m) => m.key === value);
      return `Mailbox: ${mb?.label ?? value}`;
    }
    case "FIXED": return value || "—";
    default: return rule.kind || value || "—";
  }
}

export function EmailAutomations() {
  const { user } = useSession();
  const { toast } = useToast();
  const isSuper = user?.role === "SUPER_ADMIN";
  const canManage = hasPerm(user, PERMISSIONS.email_automations);

  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [meta, setMeta] = useState<EmailMeta>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, metaRes] = await Promise.all([
        api.get<AutomationRow[]>("/api/v1/email/automations"),
        api.get<EmailMeta>("/api/v1/email/meta").catch(() => ({ data: {} as EmailMeta })),
      ]);
      setRows(list.data ?? []);
      setMeta(metaRes.data ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load email automations.");
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
      await api.patch(`/api/v1/email/automations/${a.id}`, { enabled: !a.enabled });
      toast({ title: !a.enabled ? "Automation enabled" : "Automation paused", description: a.name });
      await load();
    } catch (e) {
      // 403 on critical automations (Super Admin only) — surface the server message verbatim.
      toast({ title: "Could not update automation", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const duplicate = async (a: AutomationRow) => {
    setBusyId(a.id);
    try {
      const rule = parseRule(a.recipientRule);
      await api.post("/api/v1/email/automations", {
        name: `${a.name} (copy)`,
        eventType: a.eventType,
        templateKey: a.templateKey,
        recipientRule: { kind: rule.kind, ...(rule.value !== undefined ? { value: rule.value } : {}) },
        senderName: a.senderName ?? "",
        senderEmail: a.senderEmail ?? "",
        replyTo: a.replyTo ?? "",
        delayMinutes: a.delayMinutes ?? 0,
        conditions: parseConditions(a.conditions),
        attachments: parseAttachments(a.attachments).map((kind) => ({ kind })),
        maxAttempts: a.maxAttempts ?? 3,
        dedupeHours: a.dedupeHours ?? 0,
      });
      toast({ title: "Automation duplicated", description: `${a.name} (copy) created — review it and enable when ready.` });
      await load();
    } catch (e) {
      toast({ title: "Duplicate failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  // ── Editor state ──
  const [editorOpen, setEditorOpen] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [editing, setEditing] = useState<AutomationRow | null>(null);
  const [form, setForm] = useState<AutoForm | null>(null);
  const [saving, setSaving] = useState(false);

  const openEditor = (a: AutomationRow) => {
    const rule = parseRule(a.recipientRule);
    setEditing(a);
    setCreateMode(false);
    setForm({
      name: a.name,
      eventType: a.eventType,
      templateKey: a.templateKey,
      ruleKind: rule.kind || ((meta.recipientKinds ?? [])[0] ?? "CUSTOMER"),
      ruleValue: rule.value ?? "",
      senderName: a.senderName ?? "",
      senderEmail: a.senderEmail ?? "",
      replyTo: a.replyTo ?? "",
      delayMinutes: String(a.delayMinutes ?? 0),
      maxAttempts: String(a.maxAttempts ?? 3),
      dedupeHours: String(a.dedupeHours ?? 0),
      conditions: parseConditions(a.conditions),
      attachments: parseAttachments(a.attachments),
    });
    setEditorOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setCreateMode(true);
    setForm({
      name: "",
      eventType: (meta.events ?? [])[0] ?? "",
      templateKey: (meta.templates ?? [])[0]?.key ?? "",
      ruleKind: (meta.recipientKinds ?? [])[0] ?? "CUSTOMER",
      ruleValue: "",
      senderName: "",
      senderEmail: "",
      replyTo: "",
      delayMinutes: "0",
      maxAttempts: "3",
      dedupeHours: "0",
      conditions: [],
      attachments: [],
    });
    setEditorOpen(true);
  };

  const needsRuleValue = form ? ["ROLE", "MODULE_MAILBOX", "FIXED"].includes(form.ruleKind) : false;

  const saveEditor = async () => {
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
      toast({ title: "Template required", description: "Pick the email template to send.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        eventType: form.eventType,
        templateKey: form.templateKey,
        recipientRule: {
          kind: form.ruleKind,
          ...(needsRuleValue && form.ruleValue.trim() !== "" ? { value: form.ruleValue.trim() } : {}),
        },
        senderName: form.senderName.trim(),
        senderEmail: form.senderEmail.trim(),
        replyTo: form.replyTo.trim(),
        delayMinutes: Number(form.delayMinutes) || 0,
        conditions: form.conditions
          .filter((c) => c.field.trim() !== "")
          .map((c) => ({ field: c.field.trim(), op: c.op, value: c.value })),
        attachments: form.attachments.map((kind) => ({ kind })),
        maxAttempts: Number(form.maxAttempts) || 3,
        dedupeHours: Number(form.dedupeHours) || 0,
      };
      if (createMode) {
        await api.post("/api/v1/email/automations", payload);
        toast({ title: "Automation created", description: `${payload.name} — enable it when ready.` });
      } else if (editing) {
        await api.patch(`/api/v1/email/automations/${editing.id}`, payload);
        toast({ title: "Automation saved", description: payload.name });
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ── History state ──
  const [historyFor, setHistoryFor] = useState<AutomationRow | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (!historyFor) { setHistoryRows([]); setHistoryTotal(0); setHistoryPage(1); setHistoryError(null); return; }
    let alive = true;
    setHistoryLoading(true);
    setHistoryError(null);
    api.get<HistoryRow[]>(`/api/v1/email/automations/${historyFor.id}/history${qs({ page: historyPage, pageSize: PAGE_SIZE })}`)
      .then((res) => {
        if (!alive) return;
        setHistoryRows(res.data ?? []);
        setHistoryTotal(Number(res.meta?.total ?? (res.data?.length ?? 0)));
      })
      .catch((e) => { if (alive) setHistoryError(e instanceof Error ? e.message : "Unable to load history."); })
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
  }, [historyFor, historyPage]);

  const mailboxes = meta.moduleMailboxes ?? [];
  const historyPages = Math.max(1, Math.ceil(historyTotal / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {loading ? (
        <LoadingState label="Loading email automations…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No email automations"
          hint="Automations send emails when events happen. Create the first rule to get started."
          action={canManage ? <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" /> New automation</Button> : undefined}
        />
      ) : (
        <Card data-testid="email-automations-list">
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
          <CardContent className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead className="hidden md:table-cell">Event</TableHead>
                  <TableHead>Template</TableHead>
                  <TableHead className="hidden lg:table-cell">Recipients</TableHead>
                  <TableHead className="hidden xl:table-cell">Delay</TableHead>
                  <TableHead className="hidden xl:table-cell">Attach.</TableHead>
                  <TableHead className="hidden md:table-cell">Recent</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const rule = parseRule(a.recipientRule);
                  const atts = parseAttachments(a.attachments);
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
                                  <Badge variant="outline" className="text-[10px] border-red-300 text-red-700">critical</Badge>
                                </TooltipTrigger>
                                <TooltipContent>Super Admin only</TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          ) : null}
                        </div>
                        {(a.senderName || a.senderEmail) ? (
                          <div className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {a.senderName ? `${a.senderName} ` : ""}{a.senderEmail ? `<${a.senderEmail}>` : ""}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="outline" className="font-mono text-[11px]">{a.eventType}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{a.template?.name ?? a.templateKey}</div>
                        <div className="text-xs text-muted-foreground font-mono">{a.templateKey}</div>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs">{recipientSummary(rule, mailboxes)}</TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {a.delayMinutes > 0 ? (
                          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                            <Timer className="h-3 w-3" aria-hidden />+{a.delayMinutes}m
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden xl:table-cell">
                        {atts.length > 0 ? (
                          <span className="text-xs inline-flex items-center gap-1" title={atts.join(", ")}>
                            <Paperclip className="h-3 w-3 text-muted-foreground" aria-hidden />{atts.length}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">✓ {a.recent?.sent ?? 0}</Badge>
                          <Badge variant="outline" className={"text-[10px] " + ((a.recent?.failed ?? 0) > 0 ? "bg-red-50 text-red-700 border-red-200" : "text-muted-foreground")}>✗ {a.recent?.failed ?? 0}</Badge>
                          <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">◷ {a.recent?.queued ?? 0}</Badge>
                        </div>
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
                                  data-testid="email-automation-toggle"
                                />
                              </span>
                            </TooltipTrigger>
                            {!canManage ? <TooltipContent>Requires the email automations permission</TooltipContent> : null}
                            {canManage && !isSuper && a.critical ? <TooltipContent>Critical automations need the Super Admin</TooltipContent> : null}
                          </Tooltip>
                        </TooltipProvider>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1">
                          {canManage ? (
                            <>
                              <Button size="sm" variant="outline" className="h-7" data-testid="email-automation-edit" onClick={() => openEditor(a)}>
                                Edit
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7" disabled={busyId === a.id} onClick={() => void duplicate(a)}>
                                <Copy className="h-3 w-3 mr-1" /> Copy
                              </Button>
                            </>
                          ) : null}
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => { setHistoryFor(a); setHistoryPage(1); }}>
                            <History className="h-3 w-3 mr-1" /> History
                          </Button>
                        </div>
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

      {/* ── Editor / create dialog ── */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {createMode ? "New email automation" : `Edit automation — ${editing?.name ?? ""}`}
            </DialogTitle>
            <DialogDescription>
              When the event fires, the selected template is rendered and delivered per the recipient rule.
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="auto-name">Name</Label>
                  <Input id="auto-name" value={form.name} onChange={(e) => setForm((f) => f && ({ ...f, name: e.target.value }))} placeholder="E.g. Work order completion notice" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-event">Event</Label>
                  <Select value={form.eventType} onValueChange={(v) => setForm((f) => f && ({ ...f, eventType: v }))}>
                    <SelectTrigger id="auto-event"><SelectValue placeholder="Select event" /></SelectTrigger>
                    <SelectContent>
                      {(meta.events ?? []).map((ev) => (
                        <SelectItem key={ev} value={ev}><span className="font-mono text-xs">{ev}</span></SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="auto-template">Template</Label>
                  <Select value={form.templateKey} onValueChange={(v) => setForm((f) => f && ({ ...f, templateKey: v }))}>
                    <SelectTrigger id="auto-template"><SelectValue placeholder="Select template" /></SelectTrigger>
                    <SelectContent>
                      {(meta.templates ?? []).map((t) => (
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
                    <SelectTrigger><SelectValue placeholder="Select rule" /></SelectTrigger>
                    <SelectContent>
                      {(meta.recipientKinds ?? []).map((k) => (
                        <SelectItem key={k} value={k}>{k}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  {form.ruleKind === "ROLE" ? (
                    <>
                      <Label htmlFor="auto-rule-value">Role</Label>
                      <Select value={form.ruleValue} onValueChange={(v) => setForm((f) => f && ({ ...f, ruleValue: v }))}>
                        <SelectTrigger id="auto-rule-value"><SelectValue placeholder="Select role" /></SelectTrigger>
                        <SelectContent>
                          {(meta.roles ?? []).map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  ) : form.ruleKind === "MODULE_MAILBOX" ? (
                    <>
                      <Label htmlFor="auto-rule-value">Module mailbox</Label>
                      <Select value={form.ruleValue} onValueChange={(v) => setForm((f) => f && ({ ...f, ruleValue: v }))}>
                        <SelectTrigger id="auto-rule-value"><SelectValue placeholder="Select mailbox" /></SelectTrigger>
                        <SelectContent>
                          {mailboxes.map((m) => (
                            <SelectItem key={m.key} value={m.key}>{m.label} ({m.value})</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  ) : form.ruleKind === "FIXED" ? (
                    <>
                      <Label htmlFor="auto-rule-value">Fixed address</Label>
                      <Input id="auto-rule-value" type="email" value={form.ruleValue} onChange={(e) => setForm((f) => f && ({ ...f, ruleValue: e.target.value }))} placeholder="name@company.com" />
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-6">
                      {form.ruleKind === "CUSTOMER"
                        ? "Resolved per event — the customer's email on the related record."
                        : form.ruleKind === "RELATED_USER"
                          ? "Resolved per event — the related user's email (e.g. the assignee)."
                          : "Pick a recipient rule first."}
                    </p>
                  )}
                </div>
              </div>

              {/* Sender identity */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="auto-sender-name">Sender name</Label>
                  <Input id="auto-sender-name" value={form.senderName} onChange={(e) => setForm((f) => f && ({ ...f, senderName: e.target.value }))} placeholder="Blank = company default" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-sender-email">Sender email</Label>
                  <Input id="auto-sender-email" type="email" value={form.senderEmail} onChange={(e) => setForm((f) => f && ({ ...f, senderEmail: e.target.value }))} placeholder="Blank = company default" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-reply-to">Reply-To</Label>
                  <Input id="auto-reply-to" type="email" value={form.replyTo} onChange={(e) => setForm((f) => f && ({ ...f, replyTo: e.target.value }))} placeholder="Blank = none" />
                </div>
              </div>

              {/* Timing / retry policy */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="auto-delay">Delay (minutes)</Label>
                  <Input id="auto-delay" type="number" min={0} value={form.delayMinutes} onChange={(e) => setForm((f) => f && ({ ...f, delayMinutes: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-max-attempts">Max attempts</Label>
                  <Input id="auto-max-attempts" type="number" min={1} value={form.maxAttempts} onChange={(e) => setForm((f) => f && ({ ...f, maxAttempts: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-dedupe">Dedupe window (hours)</Label>
                  <Input id="auto-dedupe" type="number" min={0} value={form.dedupeHours} onChange={(e) => setForm((f) => f && ({ ...f, dedupeHours: e.target.value }))} />
                  <p className="text-xs text-muted-foreground">0 = no deduplication.</p>
                </div>
              </div>

              {/* Conditions */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Conditions (all must match)</Label>
                  <Button type="button" size="sm" variant="outline" className="h-7"
                    onClick={() => setForm((f) => f && ({ ...f, conditions: [...f.conditions, { field: "", op: (meta.conditionOps ?? ["EQ"])[0] ?? "EQ", value: "" }] }))}>
                    <Plus className="h-3 w-3 mr-1" /> Add condition
                  </Button>
                </div>
                {form.conditions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No conditions — the automation runs on every matching event.</p>
                ) : (
                  <div className="space-y-2">
                    {form.conditions.map((c, i) => (
                      <div key={i} className="flex flex-col sm:flex-row gap-2">
                        <Input aria-label={`Condition ${i + 1} field`} className="sm:flex-1" value={c.field} placeholder="field (e.g. priority)"
                          onChange={(e) => setForm((f) => f && ({ ...f, conditions: f.conditions.map((x, xi) => (xi === i ? { ...x, field: e.target.value } : x)) }))} />
                        <Select value={c.op} onValueChange={(v) => setForm((f) => f && ({ ...f, conditions: f.conditions.map((x, xi) => (xi === i ? { ...x, op: v } : x)) }))}>
                          <SelectTrigger className="sm:w-32" aria-label={`Condition ${i + 1} operator`}><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(meta.conditionOps ?? []).map((op) => (
                              <SelectItem key={op} value={op} className="font-mono text-xs">{op}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input aria-label={`Condition ${i + 1} value`} className="sm:flex-1" value={c.value} placeholder="value"
                          onChange={(e) => setForm((f) => f && ({ ...f, conditions: f.conditions.map((x, xi) => (xi === i ? { ...x, value: e.target.value } : x)) }))} />
                        <Button type="button" size="sm" variant="ghost" className="h-9 text-destructive hover:text-destructive" aria-label={`Remove condition ${i + 1}`}
                          onClick={() => setForm((f) => f && ({ ...f, conditions: f.conditions.filter((_, xi) => xi !== i) }))}>
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Attachments */}
              {(meta.attachmentKinds ?? []).length > 0 ? (
                <div className="space-y-2">
                  <Label>Attachments</Label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(meta.attachmentKinds ?? []).map((k) => (
                      <label key={k} className="flex items-center gap-2 rounded-lg border p-2.5 text-sm cursor-pointer hover:bg-muted/40">
                        <Checkbox
                          checked={form.attachments.includes(k)}
                          onCheckedChange={(on) =>
                            setForm((f) => f && ({ ...f, attachments: on === true ? [...f.attachments, k] : f.attachments.filter((x) => x !== k) }))
                          }
                        />
                        <span className="font-mono text-xs">{k}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button onClick={() => void saveEditor()} data-testid="email-automation-save" disabled={saving || !form}>
              <Save className="h-4 w-4 mr-1.5" /> {saving ? "Saving…" : createMode ? "Create automation" : "Save automation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delivery history dialog ── */}
      <Dialog open={historyFor !== null} onOpenChange={(o) => { if (!o) setHistoryFor(null); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Delivery history — {historyFor?.name}</DialogTitle>
            <DialogDescription>Emails this automation produced, newest first.</DialogDescription>
          </DialogHeader>
          {historyLoading ? <LoadingState label="Loading history…" rows={2} /> : null}
          {historyError ? <ErrorState message={historyError} /> : null}
          {!historyLoading && !historyError ? (
            historyRows.length === 0 ? (
              <EmptyState title="No emails yet" hint="This automation has not sent any email so far." />
            ) : (
              <div className="space-y-2">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>To</TableHead>
                      <TableHead className="hidden sm:table-cell">Subject</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Attempts</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {historyRows.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-xs whitespace-nowrap">{when(h.createdAt)}</TableCell>
                        <TableCell className="text-xs break-all max-w-[160px]">{h.toEmail}</TableCell>
                        <TableCell className="hidden sm:table-cell text-xs max-w-[200px] truncate">{h.subject ?? "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={
                            h.status === "SENT" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : h.status === "FAILED" || h.status === "DEAD_LETTER" ? "bg-red-50 text-red-700 border-red-200"
                                : h.status === "CANCELED" ? "text-muted-foreground"
                                  : "bg-amber-50 text-amber-700 border-amber-200"
                          }>
                            {h.status}
                          </Badge>
                          {h.lastError ? <div className="text-[10px] text-red-700 mt-1 break-all max-w-[180px]">{h.lastError}</div> : null}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{h.attemptCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    {(historyPage - 1) * PAGE_SIZE + 1}–{Math.min(historyPage * PAGE_SIZE, historyTotal)} of {historyTotal}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={historyPage <= 1} onClick={() => setHistoryPage((p) => p - 1)}>Prev</Button>
                    <Button size="sm" variant="outline" disabled={historyPage >= historyPages} onClick={() => setHistoryPage((p) => p + 1)}>Next</Button>
                  </div>
                </div>
              </div>
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
