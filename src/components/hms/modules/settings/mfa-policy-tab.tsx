"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Save, RefreshCw, Search } from "lucide-react";

type PolicyRow = { role: string; policyMode: string; gracePeriodDays: number };
type MfaUser = { id: string; name: string; email: string; role: string; status: string; state: string; policyMode: string };
type AuditRow = { id: string; actorName: string | null; actorEmail: string; action: string; resourceType: string; resourceId: string; metadata: unknown; ip: string; createdAt: string };

const MODES = ["MANDATORY", "OPTIONAL", "DISABLED"] as const;

function StatCard({ title, value, sub }: { title: string; value: number | string; sub: string }) {
  return (
    <Card className="rounded-lg border p-3">
      <CardHeader className="flex flex-row items-center justify-between py-2 px-0">
        <div className="space-y-0.5">
          <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">{title}</CardTitle>
          <div className="text-2xl font-semibold">{value}</div>
        </div>
        <div className="text-muted-foreground text-xs">{sub}</div>
      </CardHeader>
    </Card>
  );
}

export function MfaPolicyTab() {
  const { user } = useSession();
  const { toast } = useToast();
  const canManage = hasPerm(user, PERMISSIONS.mfa_policy_manage);
  const [policies, setPolicies] = useState<PolicyRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { policyMode: string; gracePeriodDays: number }>>({});
  const [mfaUsers, setMfaUsers] = useState<MfaUser[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetUser, setResetUser] = useState<MfaUser | null>(null);
  const [resetWorking, setResetWorking] = useState(false);
  const [resetReason, setResetReason] = useState("");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [pRes, uRes, lRes] = await Promise.all([
        api.get<{ policies: PolicyRow[]; compliance: any }>("/api/v1/admin/security/mfa-policy"),
        api.get<{ users: MfaUser[]; compliance: any }>("/api/v1/admin/security/mfa-users"),
        api.get<{ items: AuditRow[] }>("/api/v1/audit-logs?action=MFA_&pageSize=20"),
      ]);
      setPolicies(pRes.data.policies);
      setCompliance(pRes.data.compliance);
      setMfaUsers(uRes.data.users);
      setLogs(lRes.data.items);
    } catch (e) {
      toast({ title: "Couldn't load MFA settings", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const dirty = policies.some((p) => {
    const d = drafts[p.role];
    return d && (d.policyMode !== p.policyMode || d.gracePeriodDays !== p.gracePeriodDays);
  });

  function edit(role: string, key: "policyMode" | "gracePeriodDays", value: string | number) {
    setDrafts((d) => ({ ...d, [role]: { ...(d[role] ?? {}), [key]: key === "gracePeriodDays" ? Number(value) : value } }));
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const rows = Object.entries(drafts).map(([role, d]) => ({ role, policyMode: d.policyMode, gracePeriodDays: d.gracePeriodDays }));
      await api.put("/api/v1/admin/security/mfa-policy", { policies: rows });
      setDrafts({});
      toast({ title: "MFA policy saved" });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function openReset(u: MfaUser) { setResetUser(u); setResetReason(""); }
  async function doReset() {
    if (!resetUser || resetWorking) return;
    setResetWorking(true);
    try {
      await api.post("/api/v1/admin/security/mfa-reset", { userId: resetUser.id, reason: resetReason });
      toast({ title: `MFA reset for ${resetUser.email}` });
      setResetUser(null);
      setResetReason("");
      await load();
    } catch (e) {
      toast({ title: "Reset failed", description: e instanceof ClientApiError ? e.message : "Please try again.", variant: "destructive" });
    } finally {
      setResetWorking(false);
    }
  }

  const filtered = mfaUsers.filter((u) => (!stateFilter || u.state === stateFilter) && (u.name + " " + u.email + " " + u.role).toLowerCase().includes(search));

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">MFA Policy &amp; Compliance</CardTitle>
          <CardDescription>Role-based MFA policy, enrolment status and admin reset.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? <div className="h-24 flex items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin" /></div> : null}
          {!loading && compliance && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatCard title="Compliance" value={`${compliance.percent ?? 0}%`} sub="of mandatory-role users enrolled" />
              <StatCard title="Enrolled" value={compliance.enrolled} sub="MFA enabled" />
              <StatCard title="Required" value={compliance.required} sub="Mandatory, not enrolled" />
              <StatCard title="Pending" value={compliance.pending} sub="Enrolment started" />
              <StatCard title="Grace" value={compliance.grace} sub="Inside grace window" />
              <StatCard title="Not enrolled" value={compliance.notEnrolled} sub="Optional / disabled roles" />
            </div>
          )}
          {!loading && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2"><Search className="h-4 w-4 shrink-0" aria-hidden /><Input placeholder="Search users…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" /></div>
                <Select value={stateFilter} onValueChange={setStateFilter} className="w-32">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">All states</SelectItem>
                    <SelectItem value="enrolled">Enrolled</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="grace">Grace</SelectItem>
                    <SelectItem value="required">Required</SelectItem>
                    <SelectItem value="not_enrolled">Not enrolled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead className="w-20">State</TableHead>
                      <TableHead className="w-20">Policy</TableHead>
                      {canManage ? <TableHead className="text-right w-20">Actions</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell>{u.name}</TableCell>
                        <TableCell className="text-muted-foreground">{u.role}</TableCell>
                        <TableCell><Badge variant={u.state === "enrolled" ? "default" : u.state === "not_enrolled" ? "secondary" : "outline"}>{u.state.replace("_", " ")}</Badge></TableCell>
                        <TableCell className="text-muted-foreground">{u.policyMode}</TableCell>
                        {canManage && (
                          <TableCell className="text-right"><Button size="sm" variant="destructive" onClick={() => void openReset(u)}>Reset MFA</Button></TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!resetUser} onOpenChange={(open) => { if (!open) setResetUser(null); }}>
        <DialogTrigger asChild><button className="hidden" /></DialogTrigger>
        <DialogContent>
          <DialogHeader><DialogTitle>Reset MFA for {resetUser?.email}</DialogTitle><DialogDescription>Enter a reason. The user will be signed out everywhere and asked to set up MFA again at next sign-in.</DialogDescription></DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); void doReset(); }} className="space-y-3">
            <div className="space-y-1">
              <Label>Reason</Label>
              <Textarea value={resetReason} onChange={(e) => setResetReason(e.target.value)} placeholder="e.g. lost authenticator device" required minLength={5} className="h-24" />
            </div>
            <DialogFooter>
              <Button onClick={() => setResetUser(null)}>Cancel</Button>
              <Button type="submit" variant="destructive" disabled={resetWorking || resetReason.trim().length < 5}>
                {resetWorking ? <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : null} Reset
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {canManage && policies.length > 0 && (
        <Card className="mt-5">
          <CardHeader className="pb-3"><CardTitle className="text-lg">Role Policies</CardTitle><CardDescription>Save only changes you make; unchanged rows are not sent.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            <div className="rounded-md border">
              <Table>
                <TableHeader><TableRow><TableHead className="w-32">Role</TableHead><TableHead className="w-24">Mode</TableHead><TableHead className="w-28">Grace (days)</TableHead><TableHead className="text-right w-20">Save</TableHead></TableRow></TableHeader>
                <TableBody>
                  {policies.map((p) => (
                    <TableRow key={p.role}>
                      <TableCell className="font-medium">{p.role}</TableCell>
                      <TableCell>
                        <Select value={drafts[p.role]?.policyMode ?? p.policyMode} onValueChange={(v) => edit(p.role, "policyMode", v)}>
                          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                          <SelectContent>{MODES.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Input type="number" min={0} max={365} value={String(drafts[p.role]?.gracePeriodDays ?? p.gracePeriodDays)} onChange={(e) => edit(p.role, "gracePeriodDays", e.target.value)} className="w-20" />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" onClick={() => edit(p.role, "policyMode", p.policyMode)} disabled={!drafts[p.role]}>
                          Reset
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex justify-end pt-3"><Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : <><Save className="h-3.5 w-3.5 mr-1.5" aria-hidden /> Save policy changes</>}</Button></div>
          </CardContent>
        </Card>
      )}

      <Card className="mt-5">
        <CardHeader className="pb-3"><CardTitle className="text-lg">Recent MFA audit events</CardTitle></CardHeader>
        <CardContent>
          <div className="rounded-md border overflow-x-auto max-h-60 overflow-y-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="w-48">Time</TableHead><TableHead className="w-32">Actor</TableHead><TableHead>Action</TableHead><TableHead className="w-32">IP</TableHead></TableRow></TableHeader>
              <TableBody>
                {logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground font-mono">{new Date(l.createdAt).toLocaleString()}</TableCell>
                    <TableCell className="text-sm">{l.actorName || l.actorEmail}</TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{l.action}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.ip}</TableCell>
                  </TableRow>
                ))}
                {logs.length === 0 && <TableRow><TableCell colSpan={4} className="text-center text-xs text-muted-foreground py-4">No MFA audit events yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
