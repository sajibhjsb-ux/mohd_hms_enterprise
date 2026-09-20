"use client";

// MOHD.HMS ENTERPRISE — Phone number update REQUEST review (SUPER_ADMIN only).
// Mounted on the Users list page: shows every PENDING phone-change request
// with requester context (account + canonical customer row) and Approve /
// Reject actions (PATCH /api/v1/phone-requests/{id}).
//
// Approval applies the change atomically on the backend (canonical
// Customer.phone + display User.phone for customers; User.phone for staff),
// audits it and notifies the requester. This is the ONLY path a normal
// user's phone number can change — self-service is rejected by the backend.

import { useCallback, useEffect, useState } from "react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CheckCircle2, Clock, Loader2, Phone, XCircle } from "lucide-react";
import { fmtDateTime } from "@/lib/hms/format";

type PhoneRequestRow = {
  id: string;
  currentValue: string;
  proposedValue: string;
  status: string;
  createdAt: string;
  requester: {
    id: string;
    name: string;
    email: string;
    role: string;
    phone: string | null;
    customer: { id: string; code: string; companyName: string; contactPerson: string; phone: string } | null;
  };
};

export function PhoneRequestsCard({ onChanged }: { onChanged?: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PhoneRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectRow, setRejectRow] = useState<PhoneRequestRow | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<PhoneRequestRow[]>(`/api/v1/phone-requests`);
      setRows(res.data);
    } catch (e) {
      setError(e instanceof ClientApiError ? e.message : "Could not load the review queue.");
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function decide(row: PhoneRequestRow, action: "approve" | "reject", note?: string) {
    setBusyId(row.id);
    try {
      await api.patch(`/api/v1/phone-requests/${row.id}`, { action, note: note?.trim() || undefined });
      toast({
        title: action === "approve" ? "Phone number updated" : "Request rejected",
        description:
          action === "approve"
            ? `${row.requester.name}'s mobile number was changed to ${row.proposedValue}.`
            : `${row.requester.name} has been notified.`,
      });
      if (rejectRow) setRejectRow(null);
      setRejectNote("");
      await load();
      onChanged?.();
    } catch (e) {
      toast({
        title: "Could not process the request",
        description: e instanceof ClientApiError ? e.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          {error ? (
            <><XCircle className="h-4 w-4 text-destructive shrink-0" aria-hidden /> {error}</>
          ) : (
            <><Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden /> Loading phone number update requests…</>
          )}
        </CardContent>
      </Card>
    );
  }

  if (rows.length === 0) return null;

  return (
    <Card data-testid="phone-requests-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Phone className="h-4 w-4 text-primary" aria-hidden /> Phone number update requests
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">{rows.length} pending</Badge>
        </CardTitle>
        <CardDescription>
          Users cannot change their own mobile number. Approving updates the canonical record (and the customer record) and notifies the requester.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex flex-col lg:flex-row lg:items-center gap-3 rounded-lg border p-3 text-sm"
            data-testid="phone-request-row"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">
                {r.requester.name}
                <span className="text-xs text-muted-foreground font-normal"> · {r.requester.email}</span>
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {r.requester.customer
                  ? `${r.requester.customer.code} · ${r.requester.customer.companyName || r.requester.customer.contactPerson}`
                  : r.requester.role}
                {" · "}
                requested {fmtDateTime(r.createdAt)}
              </div>
              <div className="text-xs mt-1">
                <span className="text-muted-foreground">Current:</span>{" "}
                <span className={r.currentValue.trim() ? "" : "text-muted-foreground italic"}>
                  {r.currentValue.trim() || "not yet registered"}
                </span>
                {"  →  "}
                <span className="font-medium">{r.proposedValue}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                size="sm"
                onClick={() => decide(r, "approve")}
                disabled={busyId === r.id}
                data-testid={`phone-request-approve-${r.id}`}
              >
                {busyId === r.id ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4 mr-1.5" aria-hidden />}
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => { setRejectRow(r); setRejectNote(""); }}
                disabled={busyId === r.id}
                data-testid={`phone-request-reject-${r.id}`}
              >
                <XCircle className="h-4 w-4 mr-1.5" aria-hidden /> Reject
              </Button>
            </div>
          </div>
        ))}
      </CardContent>

      {/* Reject note — small confirm dialog (allowed by the nav architecture) */}
      <Dialog open={!!rejectRow} onOpenChange={(o) => { if (!o) setRejectRow(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" aria-hidden /> Reject {rejectRow?.requester.name}'s request?
            </DialogTitle>
            <DialogDescription>
              Proposed number: <strong>{rejectRow?.proposedValue}</strong>. The requester will be notified and can submit a new request.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="prj-note">Reason (optional)</Label>
            <Input
              id="prj-note"
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="e.g. Number could not be verified"
              maxLength={200}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectRow(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => rejectRow && decide(rejectRow, "reject", rejectNote)}
              disabled={busyId === rejectRow?.id}
            >
              {busyId === rejectRow?.id ? <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden /> : null}
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
