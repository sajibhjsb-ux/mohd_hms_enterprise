"use client";

// MOHD.HMS ENTERPRISE — Letter workspace (dedicated page, hr/letters/{id}).
//
// The complete one-click letter flow lives here (§8/§13/§14/§15/§16/§33/§34):
//   structured data form (template-driven) → [Generate with AI] → review/edit →
//   [Submit] → [Approve/Reject] → [Finalize] (immutable PDF → MinIO) →
//   Download / Print / Email / Share → activity timeline.
// The right column shows the SAME rendered structure the PDF prints (§26).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/hms/api-client";
import { hasPerm, useSession } from "@/components/hms/session";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo } from "@/lib/hms/router";
import { useToast } from "@/hooks/use-toast";
import { PERMISSIONS } from "@/lib/hms/constants";
import { fmtDate, fmtDateTime, money } from "@/lib/hms/format";
import { PageShell } from "@/components/hms/shared/page-shell";
import { StatusBadge, LoadingState, ErrorState } from "@/components/hms/shared/ui-bits";
import { LetterPaper, LetterPaperSkeleton } from "./preview";
import {
  LETTER_AI_ACTIONS, LETTER_AI_ACTION_LABEL, letterTypeLabel,
  type LetterAiAction, type LetterDetailDto, type LetterPreviewModel, type TemplateField,
} from "@/lib/hms/letters/shared";
import type { MetaData } from "./letters-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Sparkles, Save, Send, Share2, Archive, FileDown, Eye, Check, X, ShieldCheck,
  Paperclip, Trash2, Signature as SignatureIcon, RefreshCw, Undo2, Loader2, PlayCircle, Clock,
} from "lucide-react";

type Meta = {
  letterDate: string; // yyyy-mm-dd (date input)
  signatoryName: string;
  signatoryPosition: string;
  data: Record<string, string>;
  subject: string;
  bodySlot: string;
  salutation: string;
  employeeId: string;
};

function toDateInput(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "Something went wrong. Please try again.";
}

export function LetterEditorPage({ letterId }: { letterId: string }) {
  const { user } = useSession();
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);

  const canEdit = hasPerm(user, PERMISSIONS.letters_edit);
  const canAi = hasPerm(user, PERMISSIONS.letters_ai);
  const canApprove = hasPerm(user, PERMISSIONS.letters_approve);
  const canFinalize = hasPerm(user, PERMISSIONS.letters_finalize);
  const canSend = hasPerm(user, PERMISSIONS.letters_send);
  const canDelete = hasPerm(user, PERMISSIONS.letters_delete);

  const [letter, setLetter] = useState<LetterDetailDto | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [refData, setRefData] = useState<MetaData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [preview, setPreview] = useState<LetterPreviewModel | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<LetterAiAction | null>(null);
  const [pendingAi, setPendingAi] = useState<LetterAiAction | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [sendTo, setSendTo] = useState("");
  const [sendSubject, setSendSubject] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const sigRef = useRef<HTMLInputElement | null>(null);

  const editable = !!letter && ["DRAFT", "AI_GENERATED", "REJECTED"].includes(letter.status) && canEdit;

  // ── Load letter + references ──
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.get<LetterDetailDto>(`/api/v1/hr/letters/${letterId}`);
      setLetter(res.data);
      setMeta({
        letterDate: toDateInput(res.data.letterDate),
        signatoryName: res.data.signatoryName,
        signatoryPosition: res.data.signatoryPosition,
        data: { ...res.data.data },
        subject: res.data.subject,
        bodySlot: res.data.bodySlot,
        salutation: res.data.salutation,
        employeeId: res.data.employeeId ?? "",
      });
      const m = await api.get<MetaData>(`/api/v1/hr/letters/meta?templateId=${encodeURIComponent(res.data.templateId ?? "")}`).catch(() => null);
      setRefData(m?.data ?? null);
    } catch (e) {
      setLoadError(errMsg(e));
    }
  }, [letterId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Preview (server-rendered structure = what the PDF prints, §26) ──
  const refreshPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      const res = await api.get<LetterPreviewModel>(`/api/v1/hr/letters/${letterId}/preview`);
      setPreview(res.data);
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [letterId]);

  useEffect(() => {
    if (letter) void refreshPreview();
  }, [letter, refreshPreview]);

  // Dirty guard while editing.
  const formDirty = useMemo(() => {
    if (!letter || !meta) return false;
    return (
      meta.signatoryName !== letter.signatoryName ||
      meta.signatoryPosition !== letter.signatoryPosition ||
      meta.subject !== letter.subject ||
      meta.bodySlot !== letter.bodySlot ||
      meta.letterDate !== toDateInput(letter.letterDate) ||
      JSON.stringify(meta.data) !== JSON.stringify(letter.data)
    );
  }, [letter, meta]);

  useEffect(() => {
    setPageDirty(formDirty && editable);
    return () => setPageDirty(false);
  }, [formDirty, editable, setPageDirty]);

  if (loadError) {
    return (
      <PageShell backLabel="Back to Letters" backHref="/hr/letters" title="Letter">
        <ErrorState message={loadError} onRetry={() => void load()} />
      </PageShell>
    );
  }
  if (!letter || !meta) {
    return (
      <PageShell backLabel="Back to Letters" backHref="/hr/letters" title="Letter">
        <LoadingState label="Loading letter…" />
      </PageShell>
    );
  }

  const setMetaField = (patch: Partial<Meta>) => setMeta((m) => (m ? { ...m, ...patch } : m));
  const setDataField = (key: string, value: string) => setMeta((m) => (m ? { ...m, data: { ...m.data, [key]: value } } : m));

  // ── Save (data + content) ──
  const save = async (): Promise<boolean> => {
    setBusy("save");
    try {
      await api.patch(`/api/v1/hr/letters/${letterId}`, {
        data: meta.data,
        subject: meta.subject,
        bodySlot: meta.bodySlot,
        salutation: meta.salutation,
        letterDate: meta.letterDate ? new Date(`${meta.letterDate}T00:00:00+08:00`).toISOString() : undefined,
        signatoryName: meta.signatoryName,
        signatoryPosition: meta.signatoryPosition,
      });
      toast({ title: "Letter saved", description: letter.letterNumber });
      await load();
      return true;
    } catch (e) {
      toast({ title: "Save failed", description: errMsg(e), variant: "destructive" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ── AI actions (§13/§14/§45) ──
  const runAi = async (action: LetterAiAction, confirm = false) => {
    if (formDirty) {
      const saved = await save();
      if (!saved) return;
    }
    setAiBusy(action);
    try {
      await api.post(`/api/v1/hr/letters/${letterId}/generate`, { action, confirm });
      toast({ title: "AI draft ready", description: "Review all AI-generated content before issuing the final letter." });
      await load();
    } catch (e) {
      toast({ title: "AI generation failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setAiBusy(null);
      setPendingAi(null);
    }
  };

  const askAi = (action: LetterAiAction) => {
    if (letter.contentSource === "HUMAN_EDITED" && meta.bodySlot.trim()) {
      setPendingAi(action); // §45 confirm — human edits must not be silently replaced
    } else {
      void runAi(action);
    }
  };

  // ── Workflow ──
  const workflow = async (action: string, payload?: Record<string, unknown>, okTitle?: string) => {
    setBusy(action);
    try {
      await api.post(`/api/v1/hr/letters/${letterId}/workflow`, { action, ...payload });
      toast({ title: okTitle ?? "Done" });
      await load();
      return true;
    } catch (e) {
      toast({ title: "Action failed", description: errMsg(e), variant: "destructive" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const finalize = async () => {
    setFinalizeOpen(false);
    const okDone = await workflow("finalize", {}, "Final PDF generated and stored");
    if (okDone) void refreshPreview();
  };

  const sendEmail = async () => {
    setSendOpen(false);
    await workflow("send", { to: sendTo, subject: sendSubject, message: sendMessage }, "Letter email queued");
    setSendTo("");
    setSendMessage("");
  };

  const del = async () => {
    setBusy("delete");
    try {
      await api.del(`/api/v1/hr/letters/${letterId}`);
      toast({ title: "Draft deleted" });
      navigateTo("hr", ["letters"]);
    } catch (e) {
      toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" });
      setBusy(null);
    }
  };

  // ── Attachments (§33) ──
  const uploadAttachment = async (file: File) => {
    setBusy("attachment");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/hr/letters/${letterId}/attachments`, { method: "POST", body: fd, credentials: "same-origin" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "Upload failed. Please try again.");
      toast({ title: "Attachment added", description: file.name });
      await load();
    } catch (e) {
      toast({ title: "Upload failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeAttachment = async (id: string, name: string) => {
    setBusy(`att-${id}`);
    try {
      await api.del(`/api/v1/hr/letters/${letterId}/attachments?attachmentId=${encodeURIComponent(id)}`);
      toast({ title: "Attachment removed", description: name });
      await load();
    } catch (e) {
      toast({ title: "Remove failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  // ── Signature image (§22) ──
  const uploadSignature = async (file: File) => {
    setBusy("signature");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/hr/letters/${letterId}/signature`, { method: "POST", body: fd, credentials: "same-origin" });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.ok === false) throw new Error(body?.error?.message ?? "Upload failed. Please try again.");
      toast({ title: "Signature image saved" });
      await load();
      void refreshPreview();
    } catch (e) {
      toast({ title: "Upload failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(null);
      if (sigRef.current) sigRef.current.value = "";
    }
  };

  // ── Employee auto-population (§31) ──
  const onEmployeePicked = (employeeId: string) => {
    setMetaField({ employeeId });
    const emp = refData?.employees.find((e) => e.id === employeeId);
    if (!emp || !letter.fields.some((f) => f.type === "employee")) return;
    const patch = { ...meta.data };
    const fill = (k: string, v: string) => {
      if (letter.fields.some((f) => f.key === k) && v) patch[k] = v;
    };
    fill("EMPLOYEE_NAME", emp.name);
    fill("EMPLOYEE_ID", emp.employeeNo);
    fill("EMPLOYEE_POSITION", emp.position);
    fill("DEPARTMENT", emp.department);
    if (emp.joinDate) fill("START_DATE", toDateInput(emp.joinDate));
    if (emp.salaryCents != null) fill("SALARY", (emp.salaryCents / 100).toFixed(2));
    setMetaField({ data: patch });
  };

  // ── Customer/project auto-population (§32) ──
  const onEntityPicked = (kind: "customer" | "project" | "quotation" | "workorder", id: string) => {
    const patch = { ...meta.data };
    const fill = (k: string, v: string) => {
      if (letter.fields.some((f) => f.key === k) && v) patch[k] = v;
    };
    if (kind === "customer") {
      const c = refData?.customers.find((x) => x.id === id);
      if (c) {
        fill("RECIPIENT_NAME", c.contactPerson);
        fill("RECIPIENT_COMPANY", c.companyName || c.contactPerson);
        fill("RECIPIENT_ADDRESS", [c.address, c.city].filter(Boolean).join("\n"));
      }
      setMetaField({ data: patch });
      return;
    }
    if (kind === "project") {
      const p = refData?.projects.find((x) => x.id === id);
      if (p) {
        fill("PROJECT_NAME", p.name);
        fill("PROJECT_REFERENCE", p.code);
      }
    } else if (kind === "quotation") {
      const q = refData?.quotations.find((x) => x.id === id);
      if (q) fill("PROJECT_REFERENCE", q.code);
    } else {
      const w = refData?.workOrders.find((x) => x.id === id);
      if (w) {
        fill("PROJECT_REFERENCE", w.code);
        fill("PROJECT_NAME", w.title);
      }
    }
    setMetaField({ data: patch });
  };

  /** Restore the template-owned text (clears the content slot, §13). */
  const restoreTemplate = async () => {
    setBusy("restore");
    try {
      await api.patch(`/api/v1/hr/letters/${letterId}`, { restoreTemplate: true, bodySlot: "" });
      toast({ title: "Template text restored" });
      await load();
    } catch (e) {
      toast({ title: "Restore failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const missingRequired = letter.fields.filter((f) => f.required && !String(meta.data[f.key] ?? "").trim());

  return (
    <PageShell
      backLabel="Back to Letters"
      backHref="/hr/letters"
      crumbs={[{ label: "HR", href: "/hr" }, { label: "Letters", href: "/hr/letters" }, { label: letter.letterNumber }]}
      title={letter.letterNumber}
      description={`${letterTypeLabel(letter.letterType)} · Template ${letter.templateCode} v${letter.templateVersion}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={letter.status} />
          {editable ? (
            <Button size="sm" onClick={() => void save()} disabled={busy !== null}>
              {busy === "save" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Save
            </Button>
          ) : null}
          {letter.hasPdf ? (
            <>
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/v1/hr/letters/${letterId}/pdf`} aria-label={`Download PDF for ${letter.letterNumber}`}>
                  <FileDown className="h-4 w-4 mr-1.5" /> PDF
                </a>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={`/api/v1/hr/letters/${letterId}/pdf?disposition=inline`} target="_blank" rel="noreferrer" aria-label={`Open PDF preview for ${letter.letterNumber}`}>
                  <Eye className="h-4 w-4 mr-1.5" /> Open PDF
                </a>
              </Button>
            </>
          ) : null}
        </div>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
        {/* ─────────────── LEFT: working column ─────────────── */}
        <div className="space-y-4 min-w-0">
          {/* Workflow bar (contextual, §16) */}
          <div className="rounded-xl border bg-card p-3">
            <div className="flex flex-wrap items-center gap-2">
              {editable && letter.body.trim() ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void workflow("submit", {}, "Submitted for approval")} aria-label="Submit for approval">
                  <PlayCircle className="h-4 w-4 mr-1.5" /> Submit for Approval
                </Button>
              ) : null}
              {letter.status === "UNDER_REVIEW" && canApprove ? (
                <>
                  <Button size="sm" disabled={busy !== null} onClick={() => void workflow("approve", {}, "Letter approved")} aria-label="Approve letter">
                    <Check className="h-4 w-4 mr-1.5" /> Approve
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setRejectOpen(true)} aria-label="Reject letter">
                    <X className="h-4 w-4 mr-1.5" /> Reject
                  </Button>
                </>
              ) : null}
              {letter.status === "REJECTED" && editable ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void workflow("reopen", {}, "Reopened as draft")} aria-label="Reopen as draft">
                  <Undo2 className="h-4 w-4 mr-1.5" /> Reopen Draft
                </Button>
              ) : null}
              {letter.status === "APPROVED" && canFinalize ? (
                <Button size="sm" disabled={busy !== null} onClick={() => setFinalizeOpen(true)} aria-label="Approve and generate final PDF">
                  <ShieldCheck className="h-4 w-4 mr-1.5" /> Finalize &amp; Generate PDF
                </Button>
              ) : null}
              {letter.status === "FINALIZED" && canSend ? (
                <>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setSendOpen(true)} aria-label="Send letter by email">
                    <Send className="h-4 w-4 mr-1.5" /> Email
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void workflow("share", {}, "Share queued via WhatsApp channel")} aria-label="Share letter via WhatsApp">
                    <Share2 className="h-4 w-4 mr-1.5" /> WhatsApp
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void workflow("archive", {}, "Letter archived")} aria-label="Archive letter">
                    <Archive className="h-4 w-4 mr-1.5" /> Archive
                  </Button>
                </>
              ) : null}
              {letter.status === "SENT" && canSend ? (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void workflow("archive", {}, "Letter archived")} aria-label="Archive letter">
                  <Archive className="h-4 w-4 mr-1.5" /> Archive
                </Button>
              ) : null}
              {editable && canDelete ? (
                <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" disabled={busy !== null} onClick={() => void del()} aria-label="Delete draft">
                  <Trash2 className="h-4 w-4 mr-1.5" /> Delete Draft
                </Button>
              ) : null}
            </div>
            {letter.approvedByName ? (
              <p className="mt-2 text-xs text-muted-foreground">Approved by {letter.approvedByName} · {fmtDateTime(letter.approvedAt)}</p>
            ) : null}
          </div>

          {/* ── Data form (template-driven, §7) ── */}
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm font-medium mb-3">Letter Information</div>
            {letter.fields.length === 0 ? (
              <p className="text-sm text-muted-foreground">This template has no data fields.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {letter.fields.map((f) => (
                  <FieldInput
                    key={f.key}
                    field={f}
                    value={meta.data[f.key] ?? ""}
                    disabled={!editable}
                    onChange={(v) => setDataField(f.key, v)}
                    refData={refData}
                    employeeId={meta.employeeId}
                    onEmployeePicked={onEmployeePicked}
                    onEntityPicked={onEntityPicked}
                  />
                ))}
              </div>
            )}
            {missingRequired.length > 0 ? (
              <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
                Missing required: {missingRequired.map((f) => f.label).join(", ")}. AI generation will not invent missing details.
              </p>
            ) : null}
          </div>

          {/* ── Subject + signatory + date ── */}
          <div className="rounded-xl border bg-card p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <Label htmlFor="letter-subject">Subject</Label>
                <Input id="letter-subject" value={meta.subject} disabled={!editable} onChange={(e) => setMetaField({ subject: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="letter-date">Letter Date</Label>
                <Input id="letter-date" type="date" value={meta.letterDate} disabled={!editable} onChange={(e) => setMetaField({ letterDate: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="letter-salutation">Salutation</Label>
                <Input id="letter-salutation" value={meta.salutation} disabled={!editable} onChange={(e) => setMetaField({ salutation: e.target.value })} placeholder="Dear Sir/Madam," />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="letter-signatory">Signatory Name</Label>
                <Input id="letter-signatory" value={meta.signatoryName} disabled={!editable} onChange={(e) => setMetaField({ signatoryName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="letter-signatory-pos">Signatory Position</Label>
                <Input id="letter-signatory-pos" value={meta.signatoryPosition} disabled={!editable} onChange={(e) => setMetaField({ signatoryPosition: e.target.value })} />
              </div>
            </div>
          </div>

          {/* ── AI drafting panel (§9/§13/§14) ── */}
          <div className="rounded-xl border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" /> AI Drafting
              </div>
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">
                {letter.contentSource === "AI" ? "AI draft" : letter.contentSource === "HUMAN_EDITED" ? "Human-edited" : "Template text"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Review all AI-generated content before issuing the final letter. The AI writes only the letter body — the template structure, letterhead and company identity are locked.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              <Button size="sm" disabled={!canAi || !editable || aiBusy !== null || missingRequired.length > 0} onClick={() => askAi("generate")} aria-label="Generate letter body with AI">
                {aiBusy === "generate" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                {letter.bodySlot.trim() ? "Regenerate with AI" : "Generate with AI"}
              </Button>
              {(["shorten", "expand", "formal", "concise", "grammar"] as LetterAiAction[]).map((a) => (
                <Button
                  key={a}
                  size="sm"
                  variant="outline"
                  disabled={!canAi || !editable || aiBusy !== null || !meta.bodySlot.trim() || missingRequired.length > 0}
                  onClick={() => askAi(a)}
                  aria-label={LETTER_AI_ACTION_LABEL[a]}
                >
                  {aiBusy === a ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
                  {LETTER_AI_ACTION_LABEL[a]}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                disabled={!editable || busy !== null || (!meta.bodySlot.trim() && letter.contentSource === "TEMPLATE")}
                onClick={() => void restoreTemplate()}
                aria-label="Restore original template text"
              >
                <Undo2 className="h-4 w-4 mr-1.5" /> Restore Template
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="letter-body">Letter Body (content slot)</Label>
              <Textarea
                id="letter-body"
                value={meta.bodySlot}
                disabled={!editable}
                onChange={(e) => setMetaField({ bodySlot: e.target.value })}
                rows={10}
                placeholder="Write the letter content, or use Generate with AI…"
                className="font-[inherit]"
              />
              <p className="text-[11px] text-muted-foreground">
                This is the content slot of the template. The surrounding template wording (opening/closing lines) is managed by the template and re-renders automatically.
              </p>
            </div>
          </div>

          {/* ── Attachments + signature ── */}
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm font-medium mb-2 flex items-center gap-1.5">
              <Paperclip className="h-4 w-4" /> Attachments
            </div>
            {letter.attachments.length > 0 ? (
              <ul className="mb-3 space-y-1.5">
                {letter.attachments.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                    <a href={`/api/v1/hr/letters/${letterId}/attachments?attachmentId=${a.id}`} className="truncate hover:underline" aria-label={`Download attachment ${a.name}`}>
                      {a.name}
                    </a>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] text-muted-foreground tabular-nums">{(a.sizeBytes / 1024).toFixed(0)} KB</span>
                      {editable ? (
                        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void removeAttachment(a.id, a.name)} aria-label={`Remove attachment ${a.name}`}>
                          <Trash2 className="h-3.5 w-3.5 text-red-600" />
                        </Button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground mb-3">No attachments. Supporting documents appear in the final letter as enclosures.</p>
            )}
            {editable ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadAttachment(f);
                  }}
                />
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => fileRef.current?.click()} aria-label="Upload attachment">
                  {busy === "attachment" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Paperclip className="h-4 w-4 mr-1.5" />} Add Attachment
                </Button>
              </div>
            ) : null}

            <div className="mt-4 pt-4 border-t">
              <div className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <SignatureIcon className="h-4 w-4" /> Signature Image
              </div>
              {letter.hasSignatureImage ? (
                <div className="flex items-center gap-3">
                  <img src={`/api/v1/hr/letters/${letterId}/signature?v=${encodeURIComponent(letter.letterNumber)}`} alt="Signatory signature" className="h-12 w-auto rounded border bg-white object-contain p-1" />
                  {editable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy("signature");
                        try {
                          await api.del(`/api/v1/hr/letters/${letterId}/signature`);
                          toast({ title: "Signature image removed" });
                          await load();
                        } catch (e) {
                          toast({ title: "Remove failed", description: errMsg(e), variant: "destructive" });
                        } finally {
                          setBusy(null);
                        }
                      }}
                      aria-label="Remove signature image"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-600" /> Remove
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mb-2">Optional — a PNG/JPG signature is rendered above the signatory line in the final PDF.</p>
              )}
              {editable ? (
                <input
                  ref={sigRef}
                  type="file"
                  className="hidden"
                  accept="image/png,image/jpeg"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadSignature(f);
                  }}
                />
              ) : null}
              {editable ? (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => sigRef.current?.click()} aria-label="Upload signature image">
                  {busy === "signature" ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <SignatureIcon className="h-4 w-4 mr-1.5" />} {letter.hasSignatureImage ? "Replace" : "Upload Signature"}
                </Button>
              ) : null}
            </div>
          </div>

          {/* ── Timeline (§43) ── */}
          <div className="rounded-xl border bg-card p-4">
            <div className="text-sm font-medium mb-3 flex items-center gap-1.5">
              <Clock className="h-4 w-4" /> Activity
            </div>
            <ol className="space-y-2.5">
              {letter.events.map((e) => (
                <li key={e.id} className="flex gap-2.5 text-sm">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary/60" aria-hidden />
                  <div className="min-w-0">
                    <div className="leading-snug">
                      <span className="font-medium">{e.action.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</span>
                      {e.detail ? <span className="text-muted-foreground"> — {e.detail}</span> : null}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{e.actorName} · {fmtDateTime(e.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* ─────────────── RIGHT: live preview (§26) ─────────────── */}
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">Live Preview</div>
            <Button size="sm" variant="ghost" onClick={() => void refreshPreview()} aria-label="Refresh preview">
              <RefreshCw className={`h-4 w-4 ${previewLoading ? "animate-spin" : ""}`} /> Refresh
            </Button>
          </div>
          <div className="xl:sticky xl:top-4 max-h-[80vh] overflow-y-auto rounded-xl pr-1">
            {previewLoading && !preview ? (
              <LetterPaperSkeleton />
            ) : preview ? (
              <LetterPaper model={preview} />
            ) : (
              <LetterPaperSkeleton />
            )}
          </div>
        </div>
      </div>

      {/* ── Dialogs ── */}
      {/* §45 — destructive AI confirmation */}
      <AlertDialog open={pendingAi !== null} onOpenChange={(o) => !o && setPendingAi(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace current content?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the current letter body (which you have edited). Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingAi && void runAi(pendingAi, true)}>Replace content</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this letter?</AlertDialogTitle>
            <AlertDialogDescription>
              The letter returns to the preparer for changes. Add a short reason so they know what to fix.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Reason for rejection…" rows={3} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                setRejectOpen(false);
                await workflow("reject", { reason: rejectReason }, "Letter rejected");
                setRejectReason("");
              }}
            >
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finalize confirm (§15/§28) */}
      <AlertDialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize this letter?</AlertDialogTitle>
            <AlertDialogDescription>
              The final PDF will be generated and stored, and the letter becomes immutable. Download, print and email become available. Changes after finalizing require creating a new letter.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void finalize()}>Finalize &amp; Generate PDF</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Send email (§34) */}
      <Dialog open={sendOpen} onOpenChange={setSendOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send letter by email</DialogTitle>
            <DialogDescription>The finalized PDF is attached and queued through the company email channel.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="send-to">Recipient email</Label>
              <Input id="send-to" type="email" value={sendTo} onChange={(e) => setSendTo(e.target.value)} placeholder="name@company.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-subject">Subject</Label>
              <Input id="send-subject" value={sendSubject} onChange={(e) => setSendSubject(e.target.value)} placeholder={`${letter.letterNumber} — ${letter.subject}`} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="send-message">Message</Label>
              <Textarea id="send-message" value={sendMessage} onChange={(e) => setSendMessage(e.target.value)} rows={3} placeholder="Dear Sir/Madam, please find the letter attached…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendOpen(false)}>Cancel</Button>
            <Button disabled={!sendTo.trim() || busy !== null} onClick={() => void sendEmail()}>
              <Send className="h-4 w-4 mr-1.5" /> Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

// ── Field renderer (template-driven form, §7) ──

type RefData = MetaData;

function FieldInput({
  field, value, disabled, onChange, refData, employeeId, onEmployeePicked, onEntityPicked,
}: {
  field: TemplateField;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  refData: RefData | null;
  employeeId: string;
  onEmployeePicked: (id: string) => void;
  onEntityPicked: (kind: "customer" | "project" | "quotation" | "workorder", id: string) => void;
}) {
  const id = `lf-${field.key}`;
  const span = field.type === "textarea" ? "sm:col-span-2" : "";
  const inputId = field.type === "employee" ? undefined : id;

  return (
    <div className={`space-y-1.5 ${span}`}>
      {field.type === "employee" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select value={employeeId || (value && !refData ? "__manual" : "")} disabled={disabled} onValueChange={(v) => { if (v === "__manual") return; onEmployeePicked(v); }}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select employee (auto-fills details)" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {refData?.employees.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name} ({e.employeeNo}){e.position ? ` — ${e.position}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input id={`${id}-manual`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.hint ?? "Or type the name"} />
        </>
      ) : field.type === "customer" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select disabled={disabled} onValueChange={(v) => onEntityPicked("customer", v)}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select customer (auto-fills)" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {refData?.customers.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.companyName || c.contactPerson} ({c.code})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
        </>
      ) : field.type === "project" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select disabled={disabled} onValueChange={(v) => onEntityPicked("project", v)}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select project (auto-fills)" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {refData?.projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name} ({p.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
        </>
      ) : field.type === "quotation" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select disabled={disabled} onValueChange={(v) => onEntityPicked("quotation", v)}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select quotation (auto-fills ref)" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {refData?.quotations.map((q) => (
                <SelectItem key={q.id} value={q.id}>{q.code}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
        </>
      ) : field.type === "workorder" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select disabled={disabled} onValueChange={(v) => onEntityPicked("workorder", v)}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select work order (auto-fills)" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {refData?.workOrders.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.code}{w.title ? ` — ${w.title}` : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={field.hint} />
        </>
      ) : field.type === "select" ? (
        <>
          <Label htmlFor={id}>{field.label}{field.required ? " *" : ""}</Label>
          <Select value={value} disabled={disabled} onValueChange={onChange}>
            <SelectTrigger id={id} aria-label={field.label}>
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {(field.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>{o}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      ) : (
        <>
          <Label htmlFor={inputId}>{field.label}{field.required ? " *" : ""}</Label>
          {field.type === "textarea" ? (
            <Textarea id={inputId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={field.hint} />
          ) : (
            <Input
              id={inputId}
              type={field.type === "date" ? "date" : field.type === "number" ? "number" : "text"}
              value={field.type === "number" && field.key === "SALARY" && /^\d+(\.\d{1,2})?$/.test(value) ? value : value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.hint}
              inputMode={field.type === "number" ? "decimal" : undefined}
            />
          )}
        </>
      )}
      {field.type === "number" && field.key === "SALARY" && value && !Number.isNaN(parseFloat(value)) ? (
        <p className="text-[11px] text-muted-foreground">Renders as {money(Math.round(parseFloat(value) * 100))} / month</p>
      ) : null}
    </div>
  );
}
