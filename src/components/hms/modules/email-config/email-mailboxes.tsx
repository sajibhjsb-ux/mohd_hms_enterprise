"use client";

// MOHD.HMS ENTERPRISE — Mailbox administration (Email Configuration module).
// §28: the user↔mailbox mapping is CONFIGURABLE — not every user has a
// corporate mailbox. Administrators create PERSONAL (one owner) or SHARED
// (team, e.g. info@/service@/accounts@) mailboxes and manage members here.
// Membership is what grants Email client access — never a role alone (§36).

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Search, Trash2, UserPlus, X } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { PERMISSIONS } from "@/lib/hms/constants";
import { hasPerm, useSession } from "@/components/hms/session";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/hms/shared/ui-bits";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type Member = {
  userId: string;
  canSend: boolean;
  user: { id: string; name: string; email: string; role: string };
};

type Mailbox = {
  id: string;
  email: string;
  displayName: string;
  description: string;
  kind: string;
  isActive: boolean;
  messageCount: number;
  owner: { id: string; name: string; email: string } | null;
  members: Member[];
};

type UserLite = { id: string; name: string; email: string; role: string };

export function MailboxesAdmin() {
  const { user } = useSession();
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Mailbox[]>("/api/v1/email/mailboxes");
      setMailboxes(res.data);
    } catch (e) {
      toast({ title: "Could not load mailboxes", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Mailboxes</h3>
          <p className="text-xs text-muted-foreground">
            Corporate mailboxes for the Email client. A user sees the client only when assigned here — assign carefully.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh mailboxes">
            <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New Mailbox
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingState label="Loading mailboxes…" rows={3} />
      ) : mailboxes.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No mailboxes yet. Create the first corporate mailbox (e.g. info@, service@, or a personal address for a user).
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {mailboxes.map((mailbox) => (
            <MailboxCard
              key={mailbox.id}
              mailbox={mailbox}
              onChanged={() => void load()}
              onEdit={() => setEditing(mailbox)}
            />
          ))}
        </div>
      )}

      <CreateMailboxDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={() => { setCreateOpen(false); void load(); }} />
      <EditMailboxDialog mailbox={editing} onOpenChange={(open) => !open && setEditing(null)} onChanged={() => { setEditing(null); void load(); }} />
    </div>
  );
}

function MailboxCard({ mailbox, onChanged, onEdit }: { mailbox: Mailbox; onChanged: () => void; onEdit: () => void }) {
  const { toast } = useToast();
  const { user } = useSession();
  const canConfig = hasPerm(user, PERMISSIONS.email_config);
  const [memberSearch, setMemberSearch] = useState("");
  const [candidates, setCandidates] = useState<UserLite[]>([]);
  const [busy, setBusy] = useState(false);

  const searchUsers = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setCandidates([]); return; }
    try {
      const res = await api.get<UserLite[]>(`/api/v1/users?search=${encodeURIComponent(q.trim())}`);
      const existing = new Set(mailbox.members.map((m) => m.userId));
      setCandidates(res.data.filter((u) => !existing.has(u.id)).slice(0, 6));
    } catch { setCandidates([]); }
  }, [mailbox.members]);

  useEffect(() => {
    const t = setTimeout(() => void searchUsers(memberSearch), 250);
    return () => clearTimeout(t);
  }, [memberSearch, searchUsers]);

  const addMember = async (userId: string, canSend: boolean) => {
    setBusy(true);
    try {
      await api.post(`/api/v1/email/mailboxes/${mailbox.id}/members/${userId}`, { canSend });
      toast({ title: "Member added" });
      setMemberSearch("");
      setCandidates([]);
      onChanged();
    } catch (e) {
      toast({ title: "Could not add member", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const removeMember = async (userId: string) => {
    setBusy(true);
    try {
      await api.del(`/api/v1/email/mailboxes/${mailbox.id}/members/${userId}`);
      toast({ title: "Member removed" });
      onChanged();
    } catch (e) {
      toast({ title: "Could not remove member", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const toggleMemberSend = async (userId: string, canSend: boolean) => {
    setBusy(true);
    try {
      await api.post(`/api/v1/email/mailboxes/${mailbox.id}/members/${userId}`, { canSend });
      onChanged();
    } catch (e) {
      toast({ title: "Could not update member", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="truncate text-base">
              {mailbox.displayName || mailbox.email}
              {!mailbox.isActive ? <Badge variant="secondary" className="ml-2">Inactive</Badge> : null}
            </CardTitle>
            <CardDescription className="truncate">{mailbox.email} · {mailbox.messageCount} message(s)</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${mailbox.email}`}>Edit</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{mailbox.kind}</Badge>
          {mailbox.owner ? (
            <span className="text-muted-foreground">Owner: {mailbox.owner.name || mailbox.owner.email}</span>
          ) : null}
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Members ({mailbox.members.length})</Label>
          <ul className="mt-1 space-y-1">
            {mailbox.members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-sm">
                <span className="min-w-0 truncate">
                  {m.user.name || m.user.email}
                  <span className="ml-1 text-xs text-muted-foreground">({m.user.email})</span>
                </span>
                <span className="flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    Send
                    <Switch checked={m.canSend} disabled={busy} onCheckedChange={(v) => void toggleMemberSend(m.userId, v)} aria-label={`Toggle send for ${m.user.email}`} />
                  </label>
                  {mailbox.owner?.id !== m.userId ? (
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={busy} onClick={() => void removeMember(m.userId)} aria-label={`Remove ${m.user.email}`}>
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
            {mailbox.members.length === 0 ? <li className="text-sm text-muted-foreground">No members assigned.</li> : null}
          </ul>
        </div>

        {canConfig ? (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <Input
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Add member — search users…"
              className="pl-8"
              aria-label="Search users to add as mailbox member"
            />
            {candidates.length > 0 ? (
              <ul className="absolute z-10 mt-1 w-full rounded-md border bg-popover shadow-md">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void addMember(c.id, true)}
                    >
                      <span className="truncate">{c.name || c.email}<span className="ml-1 text-xs text-muted-foreground">({c.email})</span></span>
                      <UserPlus className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreateMailboxDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [kind, setKind] = useState("PERSONAL");
  const [ownerQuery, setOwnerQuery] = useState("");
  const [owner, setOwner] = useState<UserLite | null>(null);
  const [candidates, setCandidates] = useState<UserLite[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setEmail(""); setDisplayName(""); setKind("PERSONAL"); setOwnerQuery(""); setOwner(null); setCandidates([]); }
  }, [open]);

  useEffect(() => {
    const q = ownerQuery.trim();
    if (kind !== "PERSONAL" || q.length < 2) { setCandidates([]); return; }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<UserLite[]>(`/api/v1/users?search=${encodeURIComponent(q)}`);
        setCandidates(res.data.slice(0, 6));
      } catch { setCandidates([]); }
    }, 250);
    return () => clearTimeout(t);
  }, [ownerQuery, kind]);

  const submit = async () => {
    setBusy(true);
    try {
      await api.post("/api/v1/email/mailboxes", {
        email, displayName, kind,
        ownerUserId: kind === "PERSONAL" ? owner?.id ?? null : null,
      });
      toast({ title: "Mailbox created" });
      onCreated();
    } catch (e) {
      toast({ title: "Could not create mailbox", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Mailbox</DialogTitle>
          <DialogDescription>Corporate mailbox for the Email client. PERSONAL mailboxes have one owner; SHARED mailboxes are managed through members.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mb-email">Address</Label>
            <Input id="mb-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@mohdhms.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-name">Display name</Label>
            <Input id="mb-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="MOHD HMS Service" />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => { setKind(v); if (v !== "PERSONAL") setOwner(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PERSONAL">Personal — one owner</SelectItem>
                <SelectItem value="SHARED">Shared — team mailbox</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "PERSONAL" ? (
            <div className="relative space-y-1.5">
              <Label htmlFor="mb-owner">Owner (gets full access)</Label>
              {owner ? (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{owner.name || owner.email} <span className="text-xs text-muted-foreground">({owner.email})</span></span>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setOwner(null)} aria-label="Clear owner"><X className="h-3.5 w-3.5" aria-hidden /></Button>
                </div>
              ) : (
                <>
                  <Input id="mb-owner" value={ownerQuery} onChange={(e) => setOwnerQuery(e.target.value)} placeholder="Search users…" />
                  {candidates.length > 0 ? (
                    <ul className="absolute z-10 w-full rounded-md border bg-popover shadow-md">
                      {candidates.map((c) => (
                        <li key={c.id}>
                          <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => { setOwner(c); setCandidates([]); setOwnerQuery(""); }}>
                            {c.name || c.email} <span className="text-xs text-muted-foreground">({c.email})</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !email.trim()}>Create Mailbox</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditMailboxDialog({ mailbox, onOpenChange, onChanged }: { mailbox: Mailbox | null; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState("");

  useEffect(() => {
    if (mailbox) {
      setDisplayName(mailbox.displayName);
      setDescription(mailbox.description);
      setIsActive(mailbox.isActive);
      setConfirmDelete("");
    }
  }, [mailbox]);

  if (!mailbox) return null;

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/v1/email/mailboxes/${mailbox.id}`, { displayName, description, isActive });
      toast({ title: "Mailbox updated" });
      onChanged();
    } catch (e) {
      toast({ title: "Could not update mailbox", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/api/v1/email/mailboxes/${mailbox.id}`);
      toast({ title: "Mailbox deleted" });
      onChanged();
    } catch (e) {
      toast({ title: "Could not delete mailbox", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={Boolean(mailbox)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {mailbox.email}</DialogTitle>
          <DialogDescription>Display details and availability. Members are managed on the mailbox card.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mb-edit-name">Display name</Label>
            <Input id="mb-edit-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-edit-desc">Description</Label>
            <Input id="mb-edit-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Inactive mailboxes disappear from every member&apos;s client.</p>
            </div>
            <Switch checked={isActive} onCheckedChange={setIsActive} aria-label="Toggle mailbox active" />
          </div>
          <div className="space-y-1.5 rounded-md border border-destructive/40 p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-destructive"><Trash2 className="h-4 w-4" aria-hidden /> Delete mailbox</p>
            <p className="text-xs text-muted-foreground">Only possible while the mailbox holds no messages. Type the address to confirm.</p>
            <Input value={confirmDelete} onChange={(e) => setConfirmDelete(e.target.value)} placeholder={mailbox.email} aria-label="Type mailbox address to confirm deletion" />
            <Button variant="destructive" size="sm" disabled={busy || confirmDelete !== mailbox.email} onClick={() => void remove()}>Delete permanently</Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

void PERMISSIONS;
