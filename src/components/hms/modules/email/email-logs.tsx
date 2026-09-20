"use client";

// MOHD.HMS ENTERPRISE — Email delivery logs (Email Configuration → Logs).
// Filterable, paginated log list with a full detail view (never a popup):
// metadata, rendered body in a sandboxed iframe, retry/cancel actions.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, Ban, RefreshCw } from "lucide-react";
import { api, qs } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type EmailMeta = { categories?: string[] };

type LogRow = {
  id: string;
  toEmail: string;
  subject: string | null;
  category: string | null;
  relatedType: string | null;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  sentAt: string | null;
  lastError: string | null;
  isTest: boolean;
  createdAt: string;
};

type LogDetail = LogRow & {
  messageId: string | null;
  cc: string | null;
  bcc: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  templateKey: string | null;
  templateVersion: number | null;
  automation: { id: string; name: string; eventType: string } | null;
  relatedId: string | null;
  scheduledAt: string | null;
  failedAt: string | null;
  providerResponse: string | null;
  attachmentRefs: { kind?: string; label?: string; filename?: string }[] | null; // parsed refs (never raw keys)
  bodyHtml: string | null;
  bodyPruned: boolean;
};

type LogFilters = { status: string; category: string; recipient: string; search: string; from: string; to: string };

const STATUSES = ["QUEUED", "PROCESSING", "SMTP_ACCEPTED", "SENT", "FAILED", "DEAD_LETTER", "CANCELED"];
const PAGE_SIZE = 15;

function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusBadgeClass(s: string): string {
  switch (s) {
    case "SENT": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "QUEUED": return "bg-amber-100 text-amber-800 border-amber-200";
    case "PROCESSING":
    case "SMTP_ACCEPTED": return "border-amber-300 text-amber-800";
    case "FAILED":
    case "DEAD_LETTER": return "bg-red-100 text-red-800 border-red-200";
    default: return "text-muted-foreground"; // CANCELED + anything unknown
  }
}

/** The detail API returns attachment refs as a parsed JSON array (never raw keys). */
function parseAttachments(refs: LogDetail["attachmentRefs"]): { label: string; filename: string }[] {
  if (!refs || !Array.isArray(refs)) return [];
  return refs.map((a) => {
    if (typeof a === "string") return { label: a, filename: a };
    const o = (a ?? {}) as Record<string, unknown>;
    return { label: String(o.label ?? o.kind ?? ""), filename: String(o.filename ?? o.name ?? o.key ?? "") };
  }).filter((a) => a.label !== "" || a.filename !== "");
}

function DetailField({ label, value, mono, wide, tone }: { label: string; value: ReactNode; mono?: boolean; wide?: boolean; tone?: "danger" | "muted" }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={"text-sm break-all " + (mono ? "font-mono text-xs " : "") + (tone === "danger" ? "text-red-700" : tone === "muted" ? "text-muted-foreground" : "font-medium")}>
        {value ?? "—"}
      </p>
    </div>
  );
}

export function EmailLogs() {
  const { user } = useSession();
  const { toast } = useToast();
  const canAct = hasPerm(user, PERMISSIONS.email_actions);

  const [meta, setMeta] = useState<EmailMeta>({});
  const [status, setStatus] = useState("all");
  const [category, setCategory] = useState("all");
  const [recipient, setRecipient] = useState("");
  const [search, setSearch] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);

  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [acting, setActing] = useState<"retry" | "cancel" | null>(null);

  useEffect(() => {
    api.get<EmailMeta>("/api/v1/email/meta")
      .then((res) => setMeta(res.data ?? {}))
      .catch(() => setMeta({})); // category filter is optional — never blocks the log list
  }, []);

  const load = useCallback(async (f: LogFilters, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<LogRow[]>(`/api/v1/email/logs${qs({
        status: f.status !== "all" ? f.status : undefined,
        category: f.category !== "all" ? f.category : undefined,
        recipient: f.recipient || undefined,
        search: f.search || undefined,
        from: f.from || undefined,
        to: f.to || undefined,
        page: p,
        pageSize: PAGE_SIZE,
      })}`);
      setRows(res.data ?? []);
      setTotal(Number(res.meta?.total ?? (res.data?.length ?? 0)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load email logs.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced fetch (covers initial load); page resets when filters change.
  useEffect(() => {
    const t = setTimeout(() => {
      void load({ status, category, recipient, search, from: fromDate, to: toDate }, page);
    }, 350);
    return () => clearTimeout(t);
  }, [load, status, category, recipient, search, fromDate, toDate, page]);

  useEffect(() => {
    setPage(1);
  }, [status, category, recipient, search, fromDate, toDate]);

  const clearFilters = () => {
    setStatus("all");
    setCategory("all");
    setRecipient("");
    setSearch("");
    setFromDate("");
    setToDate("");
    setPage(1);
  };

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await api.get<LogDetail>(`/api/v1/email/logs/${id}`);
      setDetail(res.data);
    } catch (e) {
      setDetail(null);
      setDetailError(e instanceof Error ? e.message : "Unable to load the log entry.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void fetchDetail(selectedId);
    else setDetail(null);
  }, [selectedId, fetchDetail]);

  const retry = async () => {
    if (!detail) return;
    setActing("retry");
    try {
      await api.post(`/api/v1/email/logs/${detail.id}/retry`, {});
      toast({ title: "Email re-queued", description: "The delivery worker will pick it up shortly." });
      await fetchDetail(detail.id);
      await load({ status, category, recipient, search, from: fromDate, to: toDate }, page);
    } catch (e) {
      toast({ title: "Retry failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const cancel = async () => {
    if (!detail) return;
    setActing("cancel");
    try {
      await api.post(`/api/v1/email/logs/${detail.id}/cancel`, {});
      toast({ title: "Email canceled", description: "The queued message will not be delivered." });
      await fetchDetail(detail.id);
      await load({ status, category, recipient, search, from: fromDate, to: toDate }, page);
    } catch (e) {
      toast({ title: "Cancel failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeFrom = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeTo = Math.min(page * PAGE_SIZE, total);

  // ── Detail view (replaces the table area — never a popup) ──
  if (selectedId) {
    const attachments = detail ? parseAttachments(detail.attachmentRefs) : [];
    return (
      <div className="space-y-4" data-testid="email-log-detail">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSelectedId(null)}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to logs
          </Button>
          {detail ? (
            <Badge variant="outline" className={statusBadgeClass(detail.status)}>{detail.status}</Badge>
          ) : null}
          {detail?.isTest ? <Badge variant="outline" className="text-[10px]">TEST</Badge> : null}
          {canAct && detail ? (
            <div className="flex gap-2 sm:ml-auto">
              <Button
                size="sm"
                variant="outline"
                data-testid="email-log-retry"
                disabled={acting !== null || detail.status === "SENT"}
                onClick={() => void retry()}
              >
                <RefreshCw className={"h-3.5 w-3.5 mr-1.5" + (acting === "retry" ? " animate-spin" : "")} /> Retry
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="email-log-cancel"
                disabled={acting !== null || detail.status === "SENT" || detail.status === "CANCELED" || detail.status === "DEAD_LETTER"}
                onClick={() => void cancel()}
              >
                <Ban className="h-3.5 w-3.5 mr-1.5" /> Cancel
              </Button>
            </div>
          ) : null}
        </div>

        {detailLoading ? <LoadingState label="Loading log entry…" /> : null}
        {detailError ? <ErrorState message={detailError} onRetry={() => selectedId && void fetchDetail(selectedId)} /> : null}

        {detail ? (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex flex-wrap items-center gap-2">
                {detail.subject ?? "(no subject)"}
              </CardTitle>
              <CardDescription>Full delivery metadata — nothing simulated, straight from the email log.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                <DetailField label="Message ID" value={detail.messageId} mono />
                <DetailField label="Recipient" value={detail.toEmail} />
                <DetailField label="CC" value={detail.cc || null} />
                <DetailField label="BCC" value={detail.bcc || null} />
                <DetailField label="Sender" value={detail.fromEmail ? `${detail.fromName ?? ""} <${detail.fromEmail}>`.trim() : null} />
                <DetailField label="Reply-To" value={detail.replyTo} />
                <DetailField label="Subject" value={detail.subject} wide />
                <DetailField label="Category" value={detail.category} />
                <DetailField label="Template" value={detail.templateKey ? `${detail.templateKey}${detail.templateVersion ? ` (v${detail.templateVersion})` : ""}` : null} />
                <DetailField label="Automation" value={detail.automation?.name ?? null} />
                <DetailField label="Related" value={detail.relatedType ? `${detail.relatedType}${detail.relatedId ? ` · ${detail.relatedId.slice(0, 12)}…` : ""}` : null} />
                <DetailField label="Status" value={detail.status} />
                <DetailField label="Attempts" value={`${detail.attemptCount}/${detail.maxAttempts}`} />
                <DetailField label="Created" value={when(detail.createdAt)} />
                <DetailField label="Scheduled" value={detail.scheduledAt ? when(detail.scheduledAt) : "—"} />
                <DetailField label="Sent" value={detail.sentAt ? when(detail.sentAt) : "—"} />
                <DetailField label="Failed" value={detail.failedAt ? when(detail.failedAt) : "—"} />
                <div className="md:col-span-2">
                  <p className="text-xs text-muted-foreground">Last error</p>
                  <p className={"text-sm break-all " + (detail.lastError ? "text-red-700" : "text-muted-foreground")}>{detail.lastError ?? "—"}</p>
                </div>
                <div className="md:col-span-2">
                  <p className="text-xs text-muted-foreground">Provider response</p>
                  <p className="text-xs font-mono break-all bg-muted/50 rounded-md p-2 mt-0.5">{detail.providerResponse ?? "—"}</p>
                </div>
                <div className="md:col-span-2">
                  <p className="text-xs text-muted-foreground">Attachments</p>
                  {attachments.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None</p>
                  ) : (
                    <ul className="text-sm space-y-0.5">
                      {attachments.map((a, i) => (
                        <li key={i}>{a.label || a.filename} {a.filename && a.filename !== a.label ? <span className="text-muted-foreground text-xs">— {a.filename}</span> : null}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-1">Rendered body</p>
                {detail.bodyPruned && !detail.bodyHtml ? (
                  <p className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/30">
                    Rendered body pruned after the retention window (metadata retained).
                  </p>
                ) : detail.bodyHtml ? (
                  <iframe title="Rendered body" sandbox="" srcDoc={detail.bodyHtml} className="w-full h-[420px] border rounded-md bg-white" />
                ) : (
                  <p className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/30">
                    No stored body for this entry (metadata retained).
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  }

  // ── List view ──
  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Filter by category"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {(meta.categories ?? []).map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-recipient" className="text-xs">Recipient</Label>
          <Input id="log-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="name@company.com" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-search" className="text-xs">Search</Label>
          <Input id="log-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Subject or text…" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-from" className="text-xs">From date</Label>
          <Input id="log-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="log-to" className="text-xs">To date</Label>
          <Input id="log-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
        <span className="text-xs text-muted-foreground">{loading ? "Loading…" : `${total} entr${total === 1 ? "y" : "ies"}`}</span>
      </div>

      {loading ? (
        <LoadingState label="Loading email logs…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load({ status, category, recipient, search, from: fromDate, to: toDate }, page)} />
      ) : rows.length === 0 ? (
        <EmptyState title="No email logs" hint="No delivery matches the current filters." />
      ) : (
        <Card data-testid="email-logs-table">
          <CardContent className="max-h-[600px] overflow-y-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Recipient</TableHead>
                  <TableHead className="hidden md:table-cell">Subject</TableHead>
                  <TableHead className="hidden lg:table-cell">Category</TableHead>
                  <TableHead className="hidden xl:table-cell">Related</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Attempts</TableHead>
                  <TableHead className="hidden lg:table-cell">Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    tabIndex={0}
                    aria-label={`Open log entry to ${r.toEmail}`}
                    onClick={() => setSelectedId(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(r.id); }
                    }}
                  >
                    <TableCell className="text-xs whitespace-nowrap">{when(r.createdAt)}</TableCell>
                    <TableCell className="text-xs break-all max-w-[180px]">
                      <span className="flex items-center gap-1">
                        {r.lastError && r.status !== "SENT" ? (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" aria-label="Last attempt failed" />
                        ) : null}
                        {r.toEmail}
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs max-w-[220px] truncate">{r.subject ?? "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {r.category ? (
                        <span className="flex items-center gap-1">
                          <Badge variant="outline" className="text-[10px]">{r.category}</Badge>
                          {r.isTest ? <Badge variant="outline" className="text-[10px]">TEST</Badge> : null}
                        </span>
                      ) : "—"}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">{r.relatedType ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={"whitespace-nowrap " + statusBadgeClass(r.status)}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums">{r.attemptCount}/{r.maxAttempts}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs whitespace-nowrap">{r.sentAt ? when(r.sentAt) : "—"}</TableCell>
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
    </div>
  );
}
