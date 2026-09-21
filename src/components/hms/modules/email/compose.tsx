"use client";

// MOHD.HMS ENTERPRISE — dedicated Compose page (§10–§12/§16–§20, §39).
//
// A FULL PAGE (never a popup) addressed as /email/compose with query params:
//   ?draft=<id>                    resume a saved draft (PostgreSQL, §10)
//   ?reply=<id> | ?replyAll=<id>   server-computed prefill, quoted original,
//                                  caret starts at the TOP of the body (§16/§17)
//   ?forward=<id>                  prefill + original attachments cloned into
//                                  the draft via forwardFrom (§18)
//
// Autosave (§10/§11): the first user edit starts a 2.5s debounce that POSTs a
// draft (always created in DRAFTS); afterwards edits PATCH the same draft.
// The URL gains ?draft=<id> via history.replaceState — no route handlers fire.
// Sends are HONEST (§49): success means "Email queued for delivery" — the
// Outbox shows the real delivery status. Failures keep every keystroke (§12).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, qs, ClientApiError } from "@/lib/hms/api-client";
import { PageHeader, ErrorState } from "@/components/hms/shared/ui-bits";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useUi } from "@/lib/hms/ui-store";
import { navigateTo, parseQueryParams, replacePath } from "@/lib/hms/router";
import { cn } from "@/lib/utils";
import { FilesPickerDialog, type PickerFile } from "./files-picker";
import type {
  AttachmentInfo,
  Bootstrap,
  ComposePrefill,
  MessageDetail,
  Suggestions,
} from "./types";

const MAX_RECIPIENTS = 100;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // server-enforced (§19)

type UploadedAttachment = {
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

type ChipAttachment = AttachmentInfo & { fileId?: string };

function hhmm(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function splitAddresses(v: string | null | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─── Recipient chips input with server-side suggestions (§11) ───────────────

function RecipientField({
  id,
  label,
  placeholder,
  chips,
  names,
  onName,
  onAdd,
  onRemove,
}: {
  id: string;
  label: string;
  placeholder: string;
  chips: string[];
  names: Record<string, string>;
  onName: (email: string, name: string) => void;
  onAdd: (email: string) => void;
  onRemove: (email: string) => void;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  // Suggestion lookup after 2+ characters (debounced 300ms).
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setSuggestions(null);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSuggesting(true);
      try {
        const res = await api.get<Suggestions>(`/api/v1/email/client/suggestions${qs({ q })}`);
        if (!cancelled) {
          setSuggestions(res.data);
          setOpen(true);
        }
      } catch {
        if (!cancelled) setSuggestions(null); // suggestions are optional UX, never blocking
      } finally {
        if (!cancelled) setSuggesting(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [text]);

  const commit = () => {
    const v = text.trim().replace(/,+$/, "").trim();
    if (v && v.includes("@")) onAdd(v);
    setText("");
    setOpen(false);
  };

  const groups: { label: string; items: { email: string; name: string }[] }[] = [
    { label: "Users", items: (suggestions?.users ?? []).map((u) => ({ email: u.email, name: u.name })) },
    { label: "Mailboxes", items: (suggestions?.mailboxes ?? []).map((m) => ({ email: m.email, name: m.name })) },
    { label: "Customers", items: (suggestions?.customers ?? []).map((c) => ({ email: c.email, name: c.name })) },
  ];
  const hasItems = groups.some((g) => g.items.length > 0);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm shadow-xs transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        {chips.map((email) => (
          <span
            key={email.toLowerCase()}
            className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-xs"
          >
            <span className="max-w-[220px] truncate">
              {names[email.toLowerCase()] ? `${names[email.toLowerCase()]} <${email}>` : email}
            </span>
            <button
              type="button"
              aria-label={`Remove ${email}`}
              onClick={() => onRemove(email)}
              className="rounded-full p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <div className="relative min-w-[140px] flex-1">
          <input
            id={id}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                setOpen(false);
              } else if (e.key === "Backspace" && text === "" && chips.length > 0) {
                onRemove(chips[chips.length - 1]);
              }
            }}
            onBlur={commit}
            placeholder={chips.length === 0 ? placeholder : ""}
            aria-label={label}
            autoComplete="off"
            className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {open && hasItems ? (
            <div
              role="listbox"
              aria-label={`${label} suggestions`}
              className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              {groups.map((g) =>
                g.items.length === 0 ? null : (
                  <div key={g.label} role="group" aria-label={g.label}>
                    <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {g.label}
                    </p>
                    {g.items.map((s) => (
                      <button
                        key={`${g.label}:${s.email.toLowerCase()}`}
                        type="button"
                        role="option"
                        aria-selected={false}
                        onMouseDown={(e) => {
                          e.preventDefault(); // keep the input focused (no blur-commit)
                          onName(s.email.toLowerCase(), s.name);
                          onAdd(s.email);
                          setText("");
                          setOpen(false);
                        }}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 flex-1 truncate">{s.name || s.email}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{s.email}</span>
                      </button>
                    ))}
                  </div>
                )
              )}
              {suggesting ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Searching…</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Compose page ───────────────────────────────────────────────────────────

export function ComposePage() {
  const { toast } = useToast();
  const setPageDirty = useUi((s) => s.setPageDirty);

  // Query params (same channel as the KPI drill-down: shell parses the URL per
  // module into ui-store queries).
  const rawQuery = useUi((s) => s.queries["email"] ?? "");
  const params = useMemo(() => parseQueryParams(rawQuery), [rawQuery]);

  const modeKey = params.draft
    ? `draft:${params.draft}`
    : params.reply
      ? `reply:${params.reply}`
      : params.replyAll
        ? `replyAll:${params.replyAll}`
        : params.forward
          ? `forward:${params.forward}`
          : "fresh";
  const prefillMode: "reply" | "replyAll" | "forward" | null = params.reply
    ? "reply"
    : params.replyAll
      ? "replyAll"
      : params.forward
        ? "forward"
        : null;
  const prefillId = params.reply ?? params.replyAll ?? params.forward ?? "";

  const modeDescription =
    prefillMode === "reply" || prefillMode === "replyAll"
      ? "Your reply starts above the quoted original — recipients were resolved server-side and BCC is never carried over."
      : prefillMode === "forward"
        ? "The original message text and its attachments are included when this email is saved."
        : params.draft
          ? "Editing a saved draft — changes autosave every few seconds."
          : "Write from your corporate mailbox — emails are queued through the company mail server.";

  // Form state
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});

  // Draft lifecycle
  const [draftId, setDraftId] = useState<string | null>(null);
  const [forwardFrom, setForwardFrom] = useState<string | undefined>(undefined);
  const [staged, setStaged] = useState<UploadedAttachment[]>([]);
  const [draftAttachments, setDraftAttachments] = useState<AttachmentInfo[]>([]);

  // View state
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editTick, setEditTick] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const savingRef = useRef(false);

  const markDirty = useCallback(() => {
    setDirty(true);
    setEditTick((t) => t + 1);
  }, []);

  // ── Mode load: bootstrap + draft/prefill hydration ──
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setLoadError(null);
      setReady(false);
      setDirty(false);
      setSaveState("idle");
      setSavedAt(null);
      setDraftId(null);
      setStaged([]);
      setDraftAttachments([]);
      setForwardFrom(undefined);
      setNames({});
      setTo([]);
      setCc([]);
      setBcc([]);
      setShowCc(false);
      setShowBcc(false);
      setSubject("");
      setBody("");
      try {
        const bs = await api.get<Bootstrap>("/api/v1/email/client/bootstrap");
        if (cancelled) return;
        setBootstrap(bs.data);
        const sendable = bs.data.mailboxes.filter((m) => m.canSend);

        if (params.draft) {
          const res = await api.get<MessageDetail>(`/api/v1/email/client/messages/${params.draft}`);
          if (cancelled) return;
          const d = res.data;
          setMailboxId(d.mailboxId);
          setTo(splitAddresses(d.toEmail));
          setCc(splitAddresses(d.ccEmail));
          setBcc(splitAddresses(d.bccEmail));
          setShowCc(splitAddresses(d.ccEmail).length > 0);
          setShowBcc(splitAddresses(d.bccEmail).length > 0);
          setSubject(d.subject);
          setBody(d.bodyText);
          setDraftId(d.id);
          setDraftAttachments(d.attachments ?? []);
        } else if (prefillMode) {
          const res = await api.get<ComposePrefill>(
            `/api/v1/email/client/messages/${prefillId}/prefill${qs({ mode: prefillMode })}`
          );
          if (cancelled) return;
          const p = res.data;
          setMailboxId(sendable.some((m) => m.id === p.mailboxId) ? p.mailboxId : (sendable[0]?.id ?? ""));
          setTo(p.to ?? []);
          setCc(p.cc ?? []);
          setShowCc((p.cc ?? []).length > 0);
          setSubject(p.subject);
          setBody(p.body);
          if (prefillMode === "forward") setForwardFrom(p.originalId);
        } else {
          setMailboxId(sendable[0]?.id ?? "");
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof ClientApiError ? e.message : "Unable to prepare the composer.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setReady(true);
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // modeKey uniquely determines params/prefillMode/prefillId.
  }, [modeKey, params.draft, prefillMode, prefillId]);

  // Reply/forward prefill: caret starts at the TOP of the quoted body.
  useEffect(() => {
    if (ready && prefillMode && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(0, 0);
    }
  }, [ready, prefillMode]);

  // ── Dirty-state wiring (central router guard + beforeunload, §39) ──
  useEffect(() => {
    setPageDirty(dirty);
    return () => {
      setPageDirty(false);
    };
  }, [dirty, setPageDirty]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // ── Draft persistence (autosave §10/§11) ──
  const persistDraft = useCallback(
    async (silent: boolean): Promise<string | null> => {
      if (savingRef.current || !mailboxId) return null;
      savingRef.current = true;
      setSaveState("saving");
      try {
        let id = draftId;
        if (id) {
          await api.patch(`/api/v1/email/client/drafts/${id}`, {
            mailboxId,
            to,
            cc,
            bcc,
            subject,
            body,
          });
        } else {
          const res = await api.post<MessageDetail>("/api/v1/email/client/drafts", {
            mailboxId,
            to,
            cc,
            bcc,
            subject,
            body,
            attachmentFileIds: staged.length > 0 ? staged.map((s) => s.fileId) : undefined,
            forwardFrom,
          });
          id = res.data.id;
          setDraftId(id);
          setDraftAttachments(res.data.attachments ?? []);
          setStaged([]);
          setForwardFrom(undefined);
          // Keep the URL shareable without triggering route handlers.
          replacePath(`/email/compose?draft=${id}`);
        }
        setDirty(false);
        setPageDirty(false);
        setSaveState("saved");
        setSavedAt(new Date());
        return id;
      } catch (e) {
        setSaveState("error");
        if (!silent) {
          toast({
            title: "Could not save the draft",
            description: e instanceof Error ? e.message : undefined,
            variant: "destructive",
          });
        }
        return null;
      } finally {
        savingRef.current = false;
      }
    },
    [mailboxId, draftId, to, cc, bcc, subject, body, staged, forwardFrom, setPageDirty, toast]
  );

  // Debounced autosave — every edit restarts the 2.5s window.
  useEffect(() => {
    if (!ready || !dirty || !mailboxId) return;
    const hasContent =
      to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() !== "" || body.trim() !== "" || staged.length > 0;
    if (!draftId && !hasContent) return;
    const t = setTimeout(() => {
      void persistDraft(true);
    }, 2500);
    return () => clearTimeout(t);
  }, [ready, dirty, editTick, mailboxId, draftId, to, cc, bcc, subject, body, staged, persistDraft]);

  // ── Recipients ──
  const addRecipient = useCallback(
    (field: "to" | "cc" | "bcc", email: string) => {
      const key = email.trim().toLowerCase();
      if (!key) return;
      const setter = field === "to" ? setTo : field === "cc" ? setCc : setBcc;
      const current = field === "to" ? to : field === "cc" ? cc : bcc;
      if (current.some((v) => v.toLowerCase() === key)) return;
      if (current.length >= MAX_RECIPIENTS) {
        toast({
          title: "Too many recipients",
          description: `The limit is ${MAX_RECIPIENTS} recipients per field.`,
          variant: "destructive",
        });
        return;
      }
      setter((prev) => [...prev, email.trim()]);
      markDirty();
    },
    [to, cc, bcc, markDirty, toast]
  );

  const removeRecipient = useCallback(
    (field: "to" | "cc" | "bcc", email: string) => {
      const key = email.toLowerCase();
      const setter = field === "to" ? setTo : field === "cc" ? setCc : setBcc;
      setter((prev) => prev.filter((v) => v.toLowerCase() !== key));
      markDirty();
    },
    [markDirty]
  );

  const addName = useCallback((email: string, name: string) => {
    setNames((prev) => ({ ...prev, [email]: name }));
  }, []);

  // ── Attachments ──
  const attachments: ChipAttachment[] = draftId
    ? draftAttachments.map((a) => ({ ...a }))
    : staged.map((s) => ({
        id: s.fileId,
        filename: s.filename,
        contentType: s.contentType,
        sizeBytes: s.sizeBytes,
        fileId: s.fileId,
      }));

  const uploadAttachment = async (file: File) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast({
        title: "File too large",
        description: `Attachments are limited to ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB per file.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // Raw fetch — the shared api client always sets a JSON Content-Type,
      // which would break the multipart boundary (server reads field "file").
      const res = await fetch("/api/v1/email/client/attachments", {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: UploadedAttachment }
        | { ok: false; error?: { message?: string } }
        | null;
      if (!res.ok || !payload || payload.ok !== true) {
        throw new Error(
          payload && payload.ok === false ? (payload.error?.message ?? "Upload failed.") : "The attachment could not be uploaded."
        );
      }
      const up = payload.data;
      if (draftId) {
        const added = await api.post<{ id: string; filename: string; sizeBytes: number; contentType: string }>(
          `/api/v1/email/client/messages/${draftId}/attachments`,
          { fileId: up.fileId }
        );
        setDraftAttachments((prev) => [...prev, added.data]);
      } else {
        setStaged((prev) => [...prev, up]);
        markDirty();
      }
      toast({ title: "Attachment added", description: up.filename });
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const attachFromFiles = async (file: PickerFile) => {
    try {
      if (draftId) {
        const added = await api.post<{ id: string; filename: string; sizeBytes: number; contentType: string }>(
          `/api/v1/email/client/messages/${draftId}/attachments`,
          { fileId: file.id }
        );
        setDraftAttachments((prev) => [...prev, added.data]);
      } else {
        setStaged((prev) => [
          ...prev,
          { fileId: file.id, filename: file.name, contentType: file.mimeType, sizeBytes: file.sizeBytes },
        ]);
        markDirty();
      }
      toast({ title: "Attachment added", description: file.name });
    } catch (e) {
      toast({
        title: "Could not attach the file",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const removeAttachment = async (att: ChipAttachment) => {
    if (draftId && att.id) {
      try {
        await api.del(`/api/v1/email/client/messages/${draftId}/attachments/${att.id}`);
        setDraftAttachments((prev) => prev.filter((a) => a.id !== att.id));
      } catch (e) {
        toast({
          title: "Could not remove the attachment",
          description: e instanceof ClientApiError ? e.message : undefined,
          variant: "destructive",
        });
      }
    } else if (att.fileId) {
      setStaged((prev) => prev.filter((s) => s.fileId !== att.fileId));
      markDirty();
    }
  };

  // ── Send (§12/§49 — honest queue semantics) ──
  const handleSend = async () => {
    if (!mailboxId || sending) return;
    if (to.length === 0) {
      toast({
        title: "Add a recipient",
        description: "Add at least one recipient in the To field.",
        variant: "destructive",
      });
      return;
    }
    const invalid = [...to, ...cc, ...bcc].find((a) => !a.includes("@"));
    if (invalid) {
      toast({
        title: "Check the addresses",
        description: `"${invalid}" is not a valid email address.`,
        variant: "destructive",
      });
      return;
    }
    setSending(true);
    try {
      if (draftId) {
        // Persist the latest content silently, then queue the draft.
        await api.patch(`/api/v1/email/client/drafts/${draftId}`, { mailboxId, to, cc, bcc, subject, body });
        await api.post<{ messageId: string; status: string; emailLogId: string }>(
          `/api/v1/email/client/drafts/${draftId}/send`,
          { to, cc, bcc, subject, body }
        );
      } else if (forwardFrom) {
        // Forwarding needs a draft row so the backend clones the original
        // attachments (forwardFrom) before queueing.
        const created = await api.post<MessageDetail>("/api/v1/email/client/drafts", {
          mailboxId,
          to,
          cc,
          bcc,
          subject,
          body,
          forwardFrom,
        });
        await api.post<{ messageId: string; status: string; emailLogId: string }>(
          `/api/v1/email/client/drafts/${created.data.id}/send`,
          { to, cc, bcc, subject, body }
        );
      } else {
        await api.post<{ messageId: string; status: string; emailLogId: string }>(
          "/api/v1/email/client/send",
          {
            mailboxId,
            to,
            cc,
            bcc,
            subject,
            body,
            attachmentFileIds: staged.length > 0 ? staged.map((s) => s.fileId) : undefined,
          }
        );
      }
      setDirty(false);
      setPageDirty(false);
      // NEVER claim "sent" — the backend only queues (§49); the Outbox shows
      // the real delivery status.
      toast({ title: "Email queued for delivery", description: "Track its status in the Outbox." });
      navigateTo("email", ["f", "OUTBOX"]);
    } catch (e) {
      // Everything the user wrote is preserved on failure (§12).
      toast({
        title: "The email could not be queued",
        description: e instanceof ClientApiError ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSending(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!mailboxId) {
      toast({
        title: "No sendable mailbox",
        description: "You need a mailbox you can send from before saving a draft.",
        variant: "destructive",
      });
      return;
    }
    const id = await persistDraft(false);
    if (id) toast({ title: "Draft saved", description: "Continue anytime from the Drafts folder." });
  };

  const handleDiscard = async () => {
    if (draftId) {
      try {
        await api.del(`/api/v1/email/client/drafts/${draftId}`);
      } catch (e) {
        toast({
          title: "Could not discard the draft",
          description: e instanceof ClientApiError ? e.message : undefined,
          variant: "destructive",
        });
        setConfirmDiscard(false);
        return;
      }
    }
    setDirty(false);
    setPageDirty(false);
    setConfirmDiscard(false);
    toast({ title: draftId ? "Draft discarded" : "Compose discarded" });
    navigateTo("email", []);
  };

  // ── Render ──
  const sendable = (bootstrap?.mailboxes ?? []).filter((m) => m.canSend);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Compose Email"
        actions={
          <Button variant="outline" size="sm" onClick={() => navigateTo("email", [])}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Back
          </Button>
        }
      />

      {loading ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent className="space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
            <Skeleton className="h-48 w-full" />
          </CardContent>
        </Card>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => navigateTo("email", [])} />
      ) : (
        <Card className="min-w-0 overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">
              {prefillMode === "forward" ? "Forward email" : params.draft ? "Edit draft" : "New email"}
            </CardTitle>
            <CardDescription>{modeDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {sendable.length === 0 ? (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                <p>
                  <span className="font-medium">You have no mailbox you can send from</span> — ask an
                  administrator to assign one in Email Configuration before composing.
                </p>
              </div>
            ) : null}

            {/* From */}
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="compose-from">From</Label>
              <Select
                value={mailboxId}
                onValueChange={(v) => {
                  setMailboxId(v);
                  markDirty();
                }}
                disabled={sendable.length <= 1}
              >
                <SelectTrigger
                  id="compose-from"
                  aria-label="Send from mailbox"
                  className="min-w-0 w-full [&>span]:block [&>span]:truncate"
                >
                  <SelectValue
                    placeholder={sendable.length === 0 ? "No sendable mailbox" : "Select a mailbox"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sendable.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.displayName ? `${m.displayName} <${m.email}>` : m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* To + Cc/Bcc toggles */}
            <div className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <RecipientField
                    id="compose-to"
                    label="To"
                    placeholder="name@company.com — press Enter to add"
                    chips={to}
                    names={names}
                    onName={addName}
                    onAdd={(email) => addRecipient("to", email)}
                    onRemove={(email) => removeRecipient("to", email)}
                  />
                </div>
                <div className="flex shrink-0 gap-1 pb-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={showCc}
                    onClick={() => setShowCc((v) => !v)}
                  >
                    Cc
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={showBcc}
                    onClick={() => setShowBcc((v) => !v)}
                  >
                    Bcc
                  </Button>
                </div>
              </div>
              {showCc ? (
                <RecipientField
                  id="compose-cc"
                  label="Cc"
                  placeholder="name@company.com — press Enter to add"
                  chips={cc}
                  names={names}
                  onName={addName}
                  onAdd={(email) => addRecipient("cc", email)}
                  onRemove={(email) => removeRecipient("cc", email)}
                />
              ) : null}
              {showBcc ? (
                <RecipientField
                  id="compose-bcc"
                  label="Bcc"
                  placeholder="name@company.com — press Enter to add"
                  chips={bcc}
                  names={names}
                  onName={addName}
                  onAdd={(email) => addRecipient("bcc", email)}
                  onRemove={(email) => removeRecipient("bcc", email)}
                />
              ) : null}
            </div>

            {/* Subject + autosave status */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="compose-subject">Subject</Label>
                <span
                  aria-live="polite"
                  className={cn(
                    "text-xs",
                    saveState === "error" ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  {saveState === "saving"
                    ? "Saving…"
                    : saveState === "saved" && savedAt
                      ? `Draft saved ${hhmm(savedAt)}`
                      : saveState === "error"
                        ? "Save failed — will retry on the next change"
                        : ""}
                </span>
              </div>
              <Input
                id="compose-subject"
                value={subject}
                onChange={(e) => {
                  setSubject(e.target.value);
                  markDirty();
                }}
                placeholder="Subject"
                maxLength={500}
              />
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <Label htmlFor="compose-body">Message</Label>
              <Textarea
                ref={textareaRef}
                id="compose-body"
                rows={14}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  markDirty();
                }}
                placeholder="Write your message…"
                className="resize-y"
              />
            </div>

            {/* Attachments */}
            <div className="space-y-1.5">
              <Label>Attachments</Label>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAttachment(f);
                  e.currentTarget.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Upload attachment
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                  <Paperclip className="h-3.5 w-3.5" aria-hidden /> Attach from Files
                </Button>
              </div>
              {attachments.length > 0 ? (
                <ul className="flex flex-wrap gap-2" aria-label="Attached files">
                  {attachments.map((a) => (
                    <li
                      key={a.fileId ?? a.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="max-w-[200px] truncate" title={a.filename}>
                        {a.filename}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{fmtBytes(a.sizeBytes)}</span>
                      <button
                        type="button"
                        aria-label={`Remove attachment ${a.filename}`}
                        onClick={() => void removeAttachment(a)}
                        className="rounded-full p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No attachments — files up to 10 MB each (25 MB total per email).
                </p>
              )}
            </div>

            {/* Sticky action row */}
            <div className="sticky bottom-0 -mx-6 flex flex-wrap items-center gap-2 border-t bg-card px-6 py-3">
              <Button onClick={() => void handleSend()} disabled={sending || !mailboxId || !ready}>
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Send className="h-4 w-4" aria-hidden />
                )}
                Send
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleSaveDraft()}
                disabled={saveState === "saving" || !mailboxId || !ready}
              >
                <FileText className="h-4 w-4" aria-hidden /> Save draft
              </Button>
              <Button
                variant="ghost"
                className="ml-auto text-destructive hover:text-destructive"
                onClick={() => setConfirmDiscard(true)}
                disabled={sending}
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Discard
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <FilesPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} onSelect={(f) => void attachFromFiles(f)} />

      {confirmDiscard ? (
        <Dialog open onOpenChange={(o) => (!o ? setConfirmDiscard(false) : undefined)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Discard this email?</DialogTitle>
              <DialogDescription>
                {draftId
                  ? "The saved draft and its content will be deleted. This cannot be undone."
                  : "Everything you wrote in this composer will be lost."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="destructive" onClick={() => void handleDiscard()}>
                <Trash2 className="h-4 w-4" aria-hidden /> Discard
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
