"use client";

// MOHD.HMS ENTERPRISE — Share dialog (§13): grant an exact permission to an
// exact user, optional expiry, revoke existing grants. Uses the minimal
// share-targets picker (no user-management data leaks).

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { when } from "./shared";

type ShareRow = {
  id: string;
  permission: string;
  expiresAt: string | null;
  createdAt: string;
  sharedWith: { id: string; name: string; email: string };
  sharedBy?: { id: string; name: string };
};

type TargetUser = { id: string; name: string; email: string; role: string };

export function ShareDialog({
  targetType, targetId, targetName, open, onOpenChange, onChanged,
}: {
  targetType: "FILE" | "FOLDER";
  targetId: string;
  targetName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [q, setQ] = useState("");
  const [targets, setTargets] = useState<TargetUser[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [permission, setPermission] = useState("VIEW");
  const [expires, setExpires] = useState("");
  const [saving, setSaving] = useState(false);

  const base = targetType === "FILE" ? `/api/v1/files/${targetId}/shares` : `/api/v1/files/folders/${targetId}/shares`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ shares: ShareRow[] }>(base);
      setShares(res.data.shares);
    } catch {
      setShares([]);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      void api
        .get<{ users: TargetUser[] }>(`/api/v1/files/share-targets?q=${encodeURIComponent(q)}`)
        .then((res) => setTargets(res.data.users))
        .catch(() => setTargets([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]);

  const grant = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post(base, { userId: selected, permission, expiresAt: expires ? new Date(expires).toISOString() : null });
      toast({ title: "Shared", description: "The recipient has been notified." });
      setSelected("");
      setExpires("");
      await load();
      onChanged?.();
    } catch (e) {
      toast({ title: "Share failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (shareId: string) => {
    try {
      await api.del(`${base}/${shareId}`);
      toast({ title: "Access revoked", description: "The recipient lost access immediately." });
      await load();
      onChanged?.();
    } catch (e) {
      toast({ title: "Revoke failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const selectedUser = targets.find((t) => t.id === selected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{targetName}”</DialogTitle>
          <DialogDescription>
            Grant exact permissions to specific users. Recipients are notified; revocation is immediate.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Existing grants */}
          <div className="space-y-1.5">
            <Label>People with access</Label>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : shares.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not shared with anyone yet.</p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1.5">
                {shares.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{s.sharedWith.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{s.sharedWith.email}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0">{s.permission}</Badge>
                    {s.expiresAt ? <span className="text-[10px] text-muted-foreground shrink-0">exp {when(s.expiresAt)}</span> : null}
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-red-600" aria-label={`Revoke access for ${s.sharedWith.name}`} onClick={() => void revoke(s.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* New grant */}
          <div className="space-y-2.5 border-t pt-3">
            <div className="space-y-1.5">
              <Label htmlFor="share-search">Add people</Label>
              <Input id="share-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" />
            </div>
            <div className="max-h-36 overflow-y-auto space-y-1">
              {targets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelected(t.id)}
                  className={`w-full rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${selected === t.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
                >
                  <span className="font-medium">{t.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{t.email}</span>
                  <span className="ml-2 text-[10px] uppercase text-muted-foreground">{t.role}</span>
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Permission</Label>
                <Select value={permission} onValueChange={setPermission}>
                  <SelectTrigger aria-label="Permission"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="VIEW">View only</SelectItem>
                    <SelectItem value="DOWNLOAD">View + download</SelectItem>
                    <SelectItem value="EDIT">Edit</SelectItem>
                    <SelectItem value="MANAGE">Manage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Expires (optional)</Label>
                <Input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} aria-label="Expiry" />
              </div>
              <div className="flex items-end">
                <Button className="w-full" disabled={!selected || saving} onClick={() => void grant()}>
                  {saving ? "Sharing…" : `Share with ${selectedUser?.name.split(" ")[0] ?? "user"}`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
