"use client";

// MOHD.HMS ENTERPRISE — Email client contact groups manager (compose).
// Compact dialog to create, edit and delete shared distribution lists and to
// insert a whole group into the compose recipients with one click. Talks to
// /api/v1/email/client/groups (permission email.client — every staff member
// can manage and use groups; members are validated server-side).

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type MailGroup = {
  id: string;
  name: string;
  color: string;
  members: { name: string; email: string }[];
};

const TONES: Record<string, string> = {
  emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500", teal: "bg-teal-500",
  orange: "bg-orange-500", cyan: "bg-cyan-500", lime: "bg-lime-500", fuchsia: "bg-fuchsia-500",
};

export function GroupsManager({ onInsert }: { onInsert?: (members: { name: string; email: string }[]) => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<MailGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [memberText, setMemberText] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<MailGroup[]>("/api/v1/email/client/groups");
      setGroups(res.data);
    } catch (e) {
      toast({ title: "Could not load groups", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const resetForm = () => {
    setCreating(false);
    setEditingId(null);
    setName("");
    setMemberText("");
  };

  const parseMemberText = (raw: string): { name: string; email: string }[] => {
    const out: { name: string; email: string }[] = [];
    for (const part of raw.split(/[,;\n]+/)) {
      const v = part.trim();
      if (!v) continue;
      out.push({ name: "", email: v });
    }
    return out;
  };

  const save = async () => {
    const members = parseMemberText(memberText);
    if (!name.trim()) {
      toast({ title: "Give the group a name", variant: "destructive" });
      return;
    }
    if (members.length === 0) {
      toast({ title: "Add at least one member", description: "Enter comma- or newline-separated email addresses.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const payload = { name: name.trim(), color: "emerald", members };
      if (editingId) await api.patch(`/api/v1/email/client/groups/${editingId}`, payload);
      else await api.post("/api/v1/email/client/groups", payload);
      toast({ title: editingId ? "Group updated" : "Group created", description: `${name.trim()} · ${members.length} member${members.length === 1 ? "" : "s"}` });
      resetForm();
      void load();
    } catch (e) {
      toast({ title: "Could not save the group", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (g: MailGroup) => {
    setBusy(true);
    try {
      await api.del(`/api/v1/email/client/groups/${g.id}`);
      toast({ title: "Group deleted", description: g.name });
      if (editingId === g.id) resetForm();
      void load();
    } catch (e) {
      toast({ title: "Could not delete the group", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (g: MailGroup) => {
    setCreating(true);
    setEditingId(g.id);
    setName(g.name);
    setMemberText(g.members.map((m) => m.email).join(", "));
  };

  const insert = (g: MailGroup) => {
    onInsert?.(g.members);
    toast({ title: `Inserted ${g.name}`, description: `${g.members.length} recipient${g.members.length === 1 ? "" : "s"} added to To.` });
    setOpen(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <Users className="h-3.5 w-3.5" aria-hidden /> Groups
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" aria-hidden /> Contact groups
            </DialogTitle>
            <DialogDescription>
              Distribution lists for one-click addressing — e.g. “All technicians”. Insert a group into the To field, or manage its members.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[46vh] min-h-[120px] space-y-2 overflow-y-auto py-1" role="list">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading groups…
              </div>
            ) : groups.length === 0 && !creating ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No groups yet — create one to mail the whole team at once.
              </p>
            ) : (
              groups.map((g) => (
                <div key={g.id} className="rounded-lg border p-3" role="listitem">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", TONES[g.color] ?? "bg-emerald-500")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{g.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{g.members.length} member{g.members.length === 1 ? "" : "s"}</span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground" title={g.members.map((m) => m.email).join(", ")}>
                    {g.members.map((m) => m.email).join(", ")}
                  </p>
                  <div className="mt-2 flex gap-1.5">
                    {onInsert ? (
                      <Button type="button" size="sm" className="h-7 px-2.5 text-xs" onClick={() => insert(g)}>
                        Insert into To
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => startEdit(g)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-7 px-2 text-xs text-red-600 hover:text-red-600"
                      disabled={busy}
                      onClick={() => void remove(g)}
                      aria-label={`Delete group ${g.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          {creating ? (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
              <div className="space-y-1.5">
                <Label htmlFor="mail-group-name">{editingId ? "Rename group" : "New group name"}</Label>
                <Input
                  id="mail-group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Maintenance leads"
                  maxLength={80}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mail-group-members">Members</Label>
                <Input
                  id="mail-group-members"
                  value={memberText}
                  onChange={(e) => setMemberText(e.target.value)}
                  placeholder="name@company.com, other@company.com"
                />
                <p className="text-[11px] text-muted-foreground">Comma- or newline-separated email addresses (max 200).</p>
              </div>
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden />}
                  {editingId ? "Save changes" : "Create group"}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={resetForm} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden /> New group
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
