"use client";

// MOHD.HMS ENTERPRISE — File Administration (§30/§35/§49) — files.manage_storage
// + files.audit RBAC. Storage statistics (real aggregates), per-user usage,
// quota management, largest files, upload sessions, object-storage health and
// the admin file-audit search.

import { useCallback, useEffect, useState } from "react";
import { Database, HardDrive, ScrollText, ShieldCheck } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { fmtBytes, when } from "./shared";

type AdminStorage = {
  totals: {
    activeFiles: number; activeBytes: number; trashedFiles: number; trashedBytes: number;
    versions: number; oldVersionBytes: number; physicalBytes: number; folders: number; quotaMb: number;
  };
  perUser: {
    userId: string; name: string; email: string; role: string; status: string;
    usedBytes: number; limitBytes: number; availableBytes: number; percentUsed: number;
    warning: "OK" | "HIGH" | "VERY_HIGH" | "REACHED"; trashedBytes: number;
  }[];
  largest: { id: string; name: string; sizeBytes: number; mimeType: string; updatedAt: string; owner: { name: string; email: string } }[];
  meta: { page: number; totalPages: number };
};

type AdminStatus = {
  storage: { ok: boolean; error?: string };
  bucket: string;
  quotaMb: number;
  activeUploadSessions: { id: string; name: string; sizeBytes: number; totalChunks: number; updatedAt: string; user: { name: string; email: string } }[];
};

type AuditRow = {
  id: string; action: string; actorEmail: string; resourceType: string; resourceId: string;
  metadata: string; ip: string; createdAt: string;
};

export function FilesAdmin() {
  const { toast } = useToast();
  const [storage, setStorage] = useState<AdminStorage | null>(null);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [quotaInput, setQuotaInput] = useState("");
  const [savingQuota, setSavingQuota] = useState(false);

  // audit search state (§49)
  const [auditItems, setAuditItems] = useState<AuditRow[]>([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditAction, setAuditAction] = useState("");
  const [auditActor, setAuditActor] = useState("");
  const [auditQ, setAuditQ] = useState("");

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const [st, admin] = await Promise.all([
        api.get<AdminStatus>("/api/v1/files/admin/status"),
        api.get<AdminStorage>(`/api/v1/files/admin/storage?page=${p}&pageSize=10`),
      ]);
      setStatus(st.data);
      setStorage(admin.data);
      setQuotaInput(String(admin.data.totals.quotaMb));
      setPage(admin.data.meta?.page ?? p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load file administration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  const loadAudit = useCallback(async (p: number) => {
    setAuditLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: "25" });
      if (auditAction) params.set("action", auditAction);
      if (auditActor) params.set("actor", auditActor);
      if (auditQ) params.set("q", auditQ);
      const res = await api.get<AuditRow[]>(`/api/v1/files/admin/audit?${params.toString()}`);
      setAuditItems(res.data);
      setAuditTotalPages((res.meta as { totalPages?: number })?.totalPages ?? 1);
      setAuditPage(p);
    } catch (e) {
      toast({ title: "Audit search failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setAuditLoading(false);
    }
  }, [auditAction, auditActor, auditQ, toast]);

  useEffect(() => {
    void loadAudit(1);
  }, [loadAudit]);

  const saveQuota = async () => {
    const mb = Number.parseInt(quotaInput, 10);
    if (!Number.isFinite(mb) || mb < 1) {
      toast({ title: "Invalid quota", description: "Enter the quota in megabytes (a positive number).", variant: "destructive" });
      return;
    }
    setSavingQuota(true);
    try {
      await api.patch("/api/v1/files/admin/storage", { quotaMb: mb });
      toast({ title: "Quota updated", description: `Every user may now store up to ${mb} MB.` });
      await load(page);
    } catch (e) {
      toast({ title: "Could not update quota", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingQuota(false);
    }
  };

  if (loading) return <LoadingState label="Loading file administration…" />;
  if (error || !storage || !status) return (
    <div className="space-y-4">
      <PageHeader title="File Administration" />
      <ErrorState message={error ?? "Unknown error."} onRetry={() => void load(1)} />
    </div>
  );

  const t = storage.totals;
  // §4 — parts always add up: physical = active + trashed + old versions.
  const grandTotal = t.physicalBytes;

  const warningBadge = (w: AdminStorage["perUser"][number]["warning"]) => {
    if (w === "REACHED") return <Badge className="bg-red-100 text-red-700 border-red-200">Storage limit reached</Badge>;
    if (w === "VERY_HIGH") return <Badge className="bg-orange-100 text-orange-800 border-orange-200">Usage very high</Badge>;
    if (w === "HIGH") return <Badge className="bg-amber-100 text-amber-800 border-amber-200">Usage high</Badge>;
    return null;
  };
  const usageBarClass = (w: AdminStorage["perUser"][number]["warning"]) =>
    w === "REACHED" ? "[&>div]:bg-red-500" : w === "VERY_HIGH" ? "[&>div]:bg-orange-500" : w === "HIGH" ? "[&>div]:bg-amber-500" : "";

  return (
    <div className="space-y-4">
      <PageHeader title="File Administration" subtitle="System-wide storage statistics, quotas, health and the file audit trail." />

      <Tabs defaultValue="storage">
        <TabsList className="mb-4 flex-wrap h-auto">
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="audit">File Audit</TabsTrigger>
          <TabsTrigger value="status">System Status</TabsTrigger>
        </TabsList>

        {/* ── Storage (§30) ── */}
        <TabsContent value="storage" className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: "Files (active)", value: String(t.activeFiles) },
              { label: "Active storage", value: fmtBytes(t.activeBytes) },
              { label: "Trash storage", value: `${fmtBytes(t.trashedBytes)} (${t.trashedFiles})` },
              { label: "Old versions", value: fmtBytes(t.oldVersionBytes) },
              { label: "Physical total", value: fmtBytes(grandTotal) },
              { label: "Quota per staff", value: `${(t.quotaMb / 1024).toFixed(0)} GB` },
              { label: "Folders", value: String(t.folders) },
              { label: "Objects (all versions)", value: String(t.versions) },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">{c.label}</p>
                <p className="text-lg font-semibold tabular-nums">{c.value}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><HardDrive className="h-4 w-4 text-primary" /> Staff storage (§5)</CardTitle>
                <CardDescription>
                  Per-staff usage against the {fmtBytes(storage.perUser[0]?.limitBytes ?? 0)} limit · total {fmtBytes(grandTotal)} physical. Warnings at 80 % (high), 90 % (very high) and 100 % (reached).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 max-h-[28rem] overflow-y-auto pr-1">
                {storage.perUser.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No staff storage to show.</p>
                ) : (
                  storage.perUser.map((u) => (
                    <div key={u.userId} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="font-medium truncate">{u.name} <span className="text-muted-foreground font-normal">({u.email})</span></span>
                        <span className="flex items-center gap-2 shrink-0">
                          {warningBadge(u.warning)}
                          <span className="tabular-nums text-xs text-muted-foreground">
                            {fmtBytes(u.usedBytes)} / {fmtBytes(u.limitBytes)} · {fmtBytes(u.availableBytes)} free · {u.percentUsed}%
                          </span>
                        </span>
                      </div>
                      <Progress value={u.percentUsed} aria-label={`${u.name} storage ${u.percentUsed}%`} className={usageBarClass(u.warning)} />
                      {u.trashedBytes > 0 ? (
                        <p className="text-[11px] text-muted-foreground">Includes {fmtBytes(u.trashedBytes)} in trash — purging frees space.</p>
                      ) : null}
                    </div>
                  ))
                )}
                {storage.meta.totalPages > 1 ? (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>Previous</Button>
                    <span className="text-xs text-muted-foreground">Page {page} of {storage.meta.totalPages}</span>
                    <Button variant="outline" size="sm" disabled={page >= storage.meta.totalPages || loading} onClick={() => void load(page + 1)}>Next</Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><Database className="h-4 w-4 text-primary" /> Largest files</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {storage.largest.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing stored yet.</p>
                ) : (
                  storage.largest.map((f) => (
                    <div key={f.id} className="flex items-center justify-between gap-2 text-sm border-b pb-1 last:border-0">
                      <span className="truncate">{f.name}</span>
                      <span className="text-muted-foreground tabular-nums shrink-0">{fmtBytes(f.sizeBytes)} · {f.owner.name}</span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4 text-primary" /> User quota</CardTitle>
                <CardDescription>Backend-enforced on every upload (§29) — browsers are never trusted.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="space-y-1.5">
                  <Label htmlFor="quota-mb">Quota per staff user (MB)</Label>
                  <Input id="quota-mb" type="number" min={1} value={quotaInput} onChange={(e) => setQuotaInput(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Default 15,360 MB (15 GB) — spec §3 hard maximum per staff user.</p>
                </div>
                <Button size="sm" disabled={savingQuota} onClick={() => void saveQuota()}>{savingQuota ? "Saving…" : "Save quota"}</Button>
                <p className="text-xs text-muted-foreground">Changes are audited (FILE_QUOTA_UPDATED) and take effect immediately.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Admin audit (§49) ── */}
        <TabsContent value="audit" className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base"><ScrollText className="h-4 w-4 text-primary" /> File audit search</CardTitle>
              <CardDescription>Append-only records from the central audit system — filter by action, user, keyword and date.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <Input placeholder="Action (e.g. FILE_DOWNLOADED)" value={auditAction} onChange={(e) => setAuditAction(e.target.value)} aria-label="Action filter" />
                <Input placeholder="User email contains…" value={auditActor} onChange={(e) => setAuditActor(e.target.value)} aria-label="Actor filter" />
                <Input placeholder="Keyword in resource/metadata" value={auditQ} onChange={(e) => setAuditQ(e.target.value)} aria-label="Keyword filter" />
              </div>
              <Button size="sm" onClick={() => void loadAudit(1)} disabled={auditLoading}>{auditLoading ? "Searching…" : "Search"}</Button>

              {auditItems.length === 0 ? (
                <EmptyState title="No matching audit records" description="Adjust the filters and search again." />
              ) : (
                <div className="rounded-lg border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead className="hidden sm:table-cell">User</TableHead>
                        <TableHead className="hidden md:table-cell">Resource</TableHead>
                        <TableHead className="hidden lg:table-cell">IP</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditItems.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-muted-foreground whitespace-nowrap">{when(row.createdAt)}</TableCell>
                          <TableCell><Badge variant="outline" className="font-mono text-[10px]">{row.action}</Badge></TableCell>
                          <TableCell className="hidden sm:table-cell text-muted-foreground">{row.actorEmail || "—"}</TableCell>
                          <TableCell className="hidden md:table-cell font-mono text-xs">{row.resourceType}:{row.resourceId.slice(0, 8)}…</TableCell>
                          <TableCell className="hidden lg:table-cell text-muted-foreground">{row.ip || "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {auditTotalPages > 1 ? (
                <div className="flex items-center justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={auditPage <= 1 || auditLoading} onClick={() => void loadAudit(auditPage - 1)}>Previous</Button>
                  <span className="text-xs text-muted-foreground">Page {auditPage} of {auditTotalPages}</span>
                  <Button variant="outline" size="sm" disabled={auditPage >= auditTotalPages || auditLoading} onClick={() => void loadAudit(auditPage + 1)}>Next</Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── System status (§30) ── */}
        <TabsContent value="status" className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${status.storage.ok ? "bg-emerald-500" : "bg-red-500"}`} aria-hidden />
                Object storage — {status.storage.ok ? "CONNECTED" : "CONNECTION ERROR"}
              </CardTitle>
              <CardDescription>
                Private bucket <code className="font-mono">{status.bucket}</code> · quota {status.quotaMb} MB per user
                {status.storage.error ? ` · ${status.storage.error}` : ""}
              </CardDescription>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Active upload sessions (last hour)</CardTitle>
              <CardDescription>Chunked/resumable uploads currently in progress.</CardDescription>
            </CardHeader>
            <CardContent>
              {status.activeUploadSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No active upload sessions.</p>
              ) : (
                <div className="space-y-2">
                  {status.activeUploadSessions.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border p-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{s.name}</p>
                        <p className="text-xs text-muted-foreground">{s.user.name} · {s.totalChunks} chunks · updated {when(s.updatedAt)}</p>
                      </div>
                      <Badge variant="outline" className="shrink-0">{fmtBytes(s.sizeBytes)}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
