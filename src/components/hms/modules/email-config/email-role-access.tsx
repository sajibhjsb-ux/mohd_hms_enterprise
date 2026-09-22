"use client";

// MOHD.HMS ENTERPRISE — Role → Email Access mapping editor (email provisioning
// spec §15/§32). Administrator-managed configuration that decides which SHARED
// corporate mailboxes each staff role receives automatically when a corporate
// mailbox is provisioned or a role changes. The mapping is stored server-side
// (Setting store) and validated against REAL shared mailboxes — the UI never
// hardcodes access and never invents mailboxes that do not exist (§16: shared
// mailboxes, not aliases). Saving re-synchronizes every active holder so the
// change applies immediately (§17/§18/§21).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, RefreshCw, Save } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { humanize } from "@/lib/hms/constants";

type MappingData = {
  mapping: Record<string, string[]>;
  roles: string[];
  sharedMailboxes: { email: string; displayName: string; isActive: boolean }[];
};

export function RoleAccessMapping() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<MappingData | null>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MappingData>("/api/v1/email/provisioning/mapping");
      setData(res.data);
      const next: Record<string, Set<string>> = {};
      for (const role of res.data.roles) {
        next[role] = new Set(res.data.mapping[role] ?? []);
      }
      setDraft(next);
    } catch (e) {
      toast({ title: "Could not load the role access mapping", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => {
    if (!data) return false;
    for (const role of data.roles) {
      const current = draft[role] ?? new Set<string>();
      const original = new Set(data.mapping[role] ?? []);
      if (current.size !== original.size) return true;
      for (const v of current) if (!original.has(v)) return true;
    }
    return false;
  }, [data, draft]);

  const toggle = (role: string, mailbox: string) => {
    setDraft((d) => {
      const next = { ...d };
      const set = new Set(next[role] ?? []);
      if (set.has(mailbox)) set.delete(mailbox);
      else set.add(mailbox);
      next[role] = set;
      return next;
    });
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const mapping: Record<string, string[]> = {};
      for (const role of data.roles) {
        mapping[role] = [...(draft[role] ?? [])].sort();
      }
      const res = await api.put<{ resyncedUsers: number }>("/api/v1/email/provisioning/mapping", { mapping });
      toast({ title: "Role access mapping saved", description: `${res.data.resyncedUsers} active mailbox holder(s) re-synchronized.` });
      await load();
    } catch (e) {
      toast({ title: "Could not save the mapping", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="Loading role access mapping…" rows={4} />;
  if (!data) return null;

  const inactive = new Set(data.sharedMailboxes.filter((m) => !m.isActive).map((m) => m.email));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Role → Email access</h3>
          <p className="text-xs text-muted-foreground">
            Shared mailboxes each staff role receives automatically. Personal corporate mailboxes are always owned by their one user.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh mapping">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            <Save className="h-4 w-4" aria-hidden /> {saving ? "Saving…" : "Save mapping"}
          </Button>
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        Saving re-synchronizes shared access for every staff member with an active corporate mailbox: newly mapped mailboxes are
        granted and removed ones revoked. Access an administrator assigned outside this mapping is never touched.
      </p>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Access matrix</CardTitle>
          <CardDescription>Rows are roles (existing + configured). Columns are the real SHARED mailboxes in the mail architecture.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.sharedMailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shared mailboxes exist yet — create them under the Mailboxes tab first.</p>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto rounded-md border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground">Role</th>
                    {data.sharedMailboxes.map((m) => (
                      <th key={m.email} className="px-3 py-2 text-center font-medium text-muted-foreground whitespace-nowrap">
                        {m.email.replace("@mohdhms.com", "")}
                        {inactive.has(m.email) ? <span className="ml-1 text-[10px]">(inactive)</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.roles.map((role) => (
                    <tr key={role} className="hover:bg-muted/30">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge variant="outline" className="font-medium">{humanize(role)}</Badge>
                      </td>
                      {data.sharedMailboxes.map((m) => (
                        <td key={m.email} className="px-3 py-2 text-center">
                          <Checkbox
                            checked={(draft[role] ?? new Set()).has(m.email)}
                            onCheckedChange={() => toggle(role, m.email)}
                            aria-label={`${humanize(role)} access to ${m.email}`}
                            disabled={saving}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
