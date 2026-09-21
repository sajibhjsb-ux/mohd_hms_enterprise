"use client";

// MOHD.HMS ENTERPRISE — Email client compose sheet.
// Professional compose experience: recipient chips with directory
// autocomplete + contact-group insertion, rich-text toolbar (execCommand),
// MinIO-backed attachments, PostgreSQL drafts with silent autosave, and an
// honest send result (internal deliveries vs queued external deliveries).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Bold, FileText, Italic, Link2, List, ListOrdered, Loader2,
  Paperclip, RemoveFormatting, Send, Strikethrough, Trash2, Underline, Users, X,
} from "lucide-react";
import { api, ClientApiError } from "@/lib/hms/api-client";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ComposeInit, Contact, ContactGroup, MailAttachment, MailMeta } from "./types";

type Chip = { email: string; name?: string };
type UploadItem = MailAttachment & { state: "uploading" | "done" | "error" };

const TOOLBAR = [
  { cmd: "bold", icon: Bold, label: "Bold" },
  { cmd: "italic", icon: Italic, label: "Italic" },
  { cmd: "underline", icon: Underline, label: "Underline" },
  { cmd: "strikeThrough", icon: Strikethrough, label: "Strikethrough" },
  { cmd: "insertUnorderedList", icon: List, label: "Bulleted list" },
  { cmd: "insertOrderedList", icon: ListOrdered, label: "Numbered list" },
  { cmd: "createLink", icon: Link2, label: "Insert link" },
  { cmd: "removeFormat", icon: RemoveFormatting, label: "Clear formatting" },
] as const;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ComposeSheet({
  open,
  init,
  meta,
  contacts,
  onClose,
  onMailChanged,
}: {
  open: boolean;
  init: ComposeInit | null;
  meta: MailMeta | null;
  contacts: Contact[];
  onClose: () => void;
  onMailChanged: () => void;
}) {
  const { toast } = useToast();

  const [to, setTo] = useState<Chip[]>([]);
  const [cc, setCc] = useState<Chip[]>([]);
  const [bcc, setBcc] = useState<Chip[]>([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState("");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState(false);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const chipKey = (c: Chip) => c.email.toLowerCase();
  const has = (list: Chip[], email: string) => list.some((c) => chipKey(c) === email.toLowerCase());

  // ── Open/reset with the given init payload ──────────────────────────────
  useEffect(() => {
    if (!open || !init) return;
    setTo(init.to.map((email) => ({ email, name: contacts.find((c) => c.email.toLowerCase() === email.toLowerCase())?.name })));
    setCc(init.cc.map((email) => ({ email })));
    setBcc(init.bcc.map((email) => ({ email })));
    setShowCc(init.cc.length > 0 || init.bcc.length > 0);
    setSubject(init.subject);
    setUploads(init.attachments.map((a) => ({ ...a, state: "done" as const })));
    setDraftId(init.draftId);
    setSending(false);
    setSavedAt(null);
    setDiscardConfirm(false);
    setDirty(false);
    // Editor content is set AFTER mount for a fresh compose surface.
    requestAnimationFrame(() => {
      if (editorRef.current) editorRef.current.innerHTML = init.bodyHtml || "";
    });
  }, [open, init]);

  const setDirtyTrue = useCallback(() => setDirty(true), []);

  // ── Draft persistence (PostgreSQL, never localStorage) ──────────────────
  const saveDraft = useCallback(
    async (silent: boolean): Promise<string | undefined> => {
      const bodyHtml = editorRef.current?.innerHTML ?? "";
      const hasContent =
        to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() || bodyHtml.replace(/<[^>]*>/g, "").trim() || uploads.length > 0;
      if (!hasContent) return draftId;
      setSavingDraft(true);
      try {
        const res = await api.post<{ id: string }>("/api/v1/email/client/messages", {
          action: "draft",
          draftId,
          inReplyToId: init?.inReplyToId,
          to: to.map((c) => c.email),
          cc: cc.map((c) => c.email),
          bcc: bcc.map((c) => c.email),
          subject,
          bodyHtml,
          attachments: uploads.filter((u) => u.state === "done").map(({ id, key, filename, size, contentType }) => ({ id, key, filename, size, contentType })),
        });
        setDraftId(res.data.id);
        setDirty(false);
        const now = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        setSavedAt(now);
        if (!silent) toast({ title: "Draft saved", description: "The draft is stored in your mailbox." });
        onMailChanged();
        return res.data.id;
      } catch (e) {
        if (!silent) {
          toast({ title: "Could not save the draft", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
        }
        return undefined;
      } finally {
        setSavingDraft(false);
      }
    },
    [to, cc, bcc, subject, uploads, draftId, init?.inReplyToId, toast, onMailChanged]
  );

  // Silent autosave every 20s while composing.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      if (dirtyRef.current && !sending) void saveDraft(true);
    }, 20_000);
    return () => clearInterval(t);
  }, [open, sending, saveDraft]);

  // ── Recipient helpers ───────────────────────────────────────────────────
  const addEmail = (list: Chip[], setList: (v: Chip[]) => void, raw: string): boolean => {
    const email = raw.trim().replace(/[;,]+$/, "");
    if (!email) return false;
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    if (!valid) return false;
    if (has(list, email) || has(to, email) || has(cc, email) || has(bcc, email)) return true; // dedupe silently
    const contact = contacts.find((c) => c.email.toLowerCase() === email.toLowerCase());
    setList([...list, { email, name: contact?.name }]);
    return true;
  };

  // ── Attachments ─────────────────────────────────────────────────────────
  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = 10 - uploads.length;
    if (room <= 0) {
      toast({ title: "Attachment limit reached", description: "A message can hold at most 10 attachments." });
      return;
    }
    const chosen = Array.from(files).slice(0, room);
    for (const file of chosen) {
      if (file.size > 10 * 1024 * 1024) {
        toast({ title: `"${file.name}" is too large`, description: "Attachments are limited to 10 MB per file.", variant: "destructive" });
        continue;
      }
      const tempId = `tmp-${Math.random().toString(36).slice(2)}`;
      setUploads((u) => [...u, { id: tempId, key: "", filename: file.name, size: file.size, contentType: file.type || "application/octet-stream", state: "uploading" }]);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/v1/email/client/attachments", { method: "POST", body: fd, credentials: "same-origin" });
        const body = (await res.json()) as { ok: boolean; data?: MailAttachment; error?: { message: string } };
        if (!res.ok || !body.ok || !body.data) throw new Error(body.error?.message ?? "Upload failed");
        const ref = body.data;
        setUploads((u) => u.map((x) => (x.id === tempId ? { ...ref, state: "done" as const } : x)));
        setDirtyTrue();
      } catch (e) {
        setUploads((u) => u.filter((x) => x.id !== tempId));
        toast({ title: `Could not attach "${file.name}"`, description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  // ── Send ────────────────────────────────────────────────────────────────
  const send = async () => {
    const recipientCount = to.length + cc.length + bcc.length;
    if (recipientCount === 0) {
      toast({ title: "Add a recipient", description: "Enter at least one To, Cc or Bcc address.", variant: "destructive" });
      return;
    }
    const bodyHtml = editorRef.current?.innerHTML ?? "";
    if (!bodyHtml.replace(/<[^>]*>/g, "").trim() && uploads.length === 0) {
      toast({ title: "Nothing to send", description: "Write a message or attach a file first.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const res = await api.post<{
        id: string;
        internalDelivered: number;
        externalQueued: number;
        smtpConfigured: boolean;
      }>("/api/v1/email/client/messages", {
        action: "send",
        draftId,
        inReplyToId: init?.inReplyToId,
        to: to.map((c) => c.email),
        cc: cc.map((c) => c.email),
        bcc: bcc.map((c) => c.email),
        subject,
        bodyHtml,
        attachments: uploads.filter((u) => u.state === "done").map(({ id, key, filename, size, contentType }) => ({ id, key, filename, size, contentType })),
      });
      const { internalDelivered, externalQueued, smtpConfigured } = res.data;
      const parts: string[] = [];
      if (internalDelivered > 0) parts.push(`${internalDelivered} internal mailbox${internalDelivered === 1 ? "" : "es"}`);
      if (externalQueued > 0) parts.push(`${externalQueued} external recipient${externalQueued === 1 ? "" : "s"}`);
      if (externalQueued > 0 && !smtpConfigured) {
        toast({
          title: "Email queued",
          description: `Queued for ${parts.join(" and ")}. External delivery starts once SMTP is configured in Settings → Email.`,
        });
      } else {
        toast({ title: "Email sent", description: `Delivered to ${parts.join(" and ")}.` });
      }
      onMailChanged();
      onClose();
    } catch (e) {
      toast({ title: "Send failed", description: e instanceof ClientApiError ? e.message : undefined, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  /** Sheet dismissed (X / Esc / outside click): save silently, then close —
   *  an unfinished email is ALWAYS kept as a draft (never silently lost). */
  const requestClose = () => {
    if (sending) return;
    if (dirty) {
      void saveDraft(true).finally(() => onClose());
      return;
    }
    onClose();
  };

  /** Explicit discard (trash button) — confirmation, then delete the draft. */
  const discard = () => {
    const hasContent =
      to.length > 0 || cc.length > 0 || bcc.length > 0 || subject.trim() ||
      editorRef.current?.innerHTML.replace(/<[^>]*>/g, "").trim() || uploads.length > 0;
    if (hasContent) {
      setDiscardConfirm(true);
      return;
    }
    onClose();
  };

  const doDiscard = async () => {
    setDiscardConfirm(false);
    if (draftId) {
      await api.del(`/api/v1/email/client/messages/${draftId}`).catch(() => undefined);
      onMailChanged();
    }
    onClose();
  };

  const exec = (cmd: string) => {
    editorRef.current?.focus();
    if (cmd === "createLink") {
      const url = window.prompt("Link URL", "https://");
      if (!url) return;
      document.execCommand("createLink", false, url);
    } else {
      document.execCommand(cmd);
    }
    setDirtyTrue();
  };

  const fromLine = meta?.sendingAs?.fromEmail
    ? `${meta.identity.name} <${meta.sendingAs.fromEmail}>`
    : meta?.identity.name ?? "";

  return (
    <Sheet open={open} onOpenChange={(o) => (!o ? requestClose() : undefined)}>
      <SheetContent className="w-full sm:max-w-xl p-0 flex flex-col gap-0 h-full" side="right">
        <SheetHeader className="px-5 py-4 border-b bg-muted/40">
          <SheetTitle className="flex items-center gap-2 text-base">
            {init?.mode === "reply" ? "Reply" : init?.mode === "replyAll" ? "Reply all" : init?.mode === "forward" ? "Forward" : init?.mode === "draft" ? "Edit draft" : "New message"}
          </SheetTitle>
          <p className="text-xs text-muted-foreground">From: {fromLine}</p>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          <RecipientField
            label="To"
            chips={to}
            onAdd={(raw) => { setDirtyTrue(); addEmail(to, setTo, raw); }}
            onRemove={(email) => { setTo(to.filter((c) => c.email !== email)); setDirtyTrue(); }}
            contacts={contacts}
            groups={meta?.groups ?? []}
            onGroup={(g) => {
              const addrs = g.members.filter((m) => !has(to, m.email));
              setTo([...to, ...addrs.map((m) => ({ email: m.email, name: m.name || contacts.find((c) => c.email.toLowerCase() === m.email.toLowerCase())?.name }))]);
              setDirtyTrue();
            }}
          />
          {showCc ? (
            <RecipientField
              label="Cc"
              chips={cc}
              onAdd={(raw) => { setDirtyTrue(); addEmail(cc, setCc, raw); }}
              onRemove={(email) => { setCc(cc.filter((c) => c.email !== email)); setDirtyTrue(); }}
              contacts={contacts}
              groups={meta?.groups ?? []}
            />
          ) : null}
          {showCc ? (
            <RecipientField
              label="Bcc"
              chips={bcc}
              onAdd={(raw) => { setDirtyTrue(); addEmail(bcc, setBcc, raw); }}
              onRemove={(email) => { setBcc(bcc.filter((c) => c.email !== email)); setDirtyTrue(); }}
              contacts={contacts}
              groups={meta?.groups ?? []}
            />
          ) : null}
          {!showCc ? (
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowCc(true)}>
              Cc / Bcc
            </button>
          ) : null}

          <Input
            placeholder="Subject"
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setDirtyTrue(); }}
            className="border-0 border-b rounded-none px-0 h-11 text-[15px] font-medium focus-visible:ring-0"
            aria-label="Subject"
          />

          {/* Rich text toolbar */}
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-0.5 rounded-md border bg-muted/30 p-1 w-fit" role="toolbar" aria-label="Formatting">
              {TOOLBAR.map(({ cmd, icon: Icon, label }) => (
                <Tooltip key={cmd}>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => exec(cmd)} aria-label={label}>
                      <Icon className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>

          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label="Message body"
            aria-multiline="true"
            className="min-h-[180px] max-h-[38vh] overflow-y-auto rounded-md border bg-background p-3 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring/30 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
            onInput={setDirtyTrue}
          />

          {/* Attachments */}
          <div className="space-y-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void uploadFiles(e.target.files)} aria-hidden />
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip className="h-3.5 w-3.5" /> Attach files (max 10 MB each)
            </button>
            {uploads.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {uploads.map((u) => (
                  <li key={u.id} className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 pl-2 pr-1 py-1 text-xs max-w-[240px]">
                    {u.state === "uploading" ? (
                      <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
                    ) : (
                      <FileText className="h-3 w-3 text-primary" aria-hidden />
                    )}
                    <span className="truncate">{u.filename}</span>
                    <span className="text-muted-foreground whitespace-nowrap">{fmtBytes(u.size)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${u.filename}`}
                      className="rounded-full p-0.5 hover:bg-background"
                      onClick={() => { setUploads((arr) => arr.filter((x) => x.id !== u.id)); setDirtyTrue(); }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {/* pb clears the floating mobile bottom nav (measured by MobileNav) */}
        <div className="border-t bg-muted/40 px-5 py-3 flex items-center gap-2 pb-[calc(var(--hms-mobile-nav-h,0px)+0.75rem)] lg:pb-3">
          <Button onClick={() => void send()} disabled={sending} className="min-w-[110px]">
            {sending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Send className="h-4 w-4 mr-1.5" />}
            {sending ? "Sending…" : "Send"}
          </Button>
          <Button variant="outline" onClick={() => void saveDraft(false)} disabled={savingDraft}>
            {savingDraft ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <FileText className="h-4 w-4 mr-1.5" />}
            Save draft
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {savedAt ? <span className="text-xs text-muted-foreground">Draft saved {savedAt}</span> : null}
            <Button variant="ghost" size="icon" aria-label="Discard message" onClick={discard}>
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>

        {discardConfirm ? (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="rounded-lg border bg-background p-5 shadow-lg max-w-sm mx-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="h-4 w-4 text-amber-600" /> Discard this message?
              </div>
              <p className="text-xs text-muted-foreground">Your draft will be deleted permanently. This cannot be undone.</p>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={() => setDiscardConfirm(false)}>Keep editing</Button>
                <Button variant="destructive" size="sm" onClick={() => void doDiscard()}>Discard</Button>
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// ─── Recipient field (chips + autocomplete + group insertion) ───────────────

export function RecipientField({
  label,
  chips,
  onAdd,
  onRemove,
  contacts,
  groups,
  onGroup,
}: {
  label: string;
  chips: Chip[];
  onAdd: (raw: string) => void;
  onRemove: (email: string) => void;
  contacts: Contact[];
  groups: ContactGroup[];
  onGroup?: (g: ContactGroup) => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  const query = text.trim().toLowerCase();
  const contactHits = useMemo(
    () =>
      query
        ? contacts
            .filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(query) && !chips.some((ch) => ch.email.toLowerCase() === c.email.toLowerCase()))
            .slice(0, 5)
        : [],
    [query, contacts, chips]
  );
  const groupHits = useMemo(
    () => (onGroup && query ? groups.filter((g) => g.name.toLowerCase().includes(query)).slice(0, 3) : []),
    [query, groups, onGroup]
  );
  const showPop = focused && (contactHits.length > 0 || groupHits.length > 0 || (query && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(query)));

  const commit = () => {
    if (text.trim()) {
      onAdd(text);
      setText("");
    }
  };

  return (
    <div className="flex items-start gap-2 border-b py-1.5">
      <span className="w-10 pt-1.5 text-xs font-medium text-muted-foreground shrink-0">{label}</span>
      <div className="flex-1 min-w-0 relative">
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <Badge key={c.email} variant="secondary" className="gap-1 max-w-[220px] pl-2">
              <span className="truncate">{c.name || c.email}</span>
              <button type="button" aria-label={`Remove ${c.email}`} onClick={() => onRemove(c.email)} className="rounded-full hover:bg-background/70 p-0.5">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === ";") {
                e.preventDefault();
                commit();
              } else if (e.key === "Backspace" && !text && chips.length > 0) {
                onRemove(chips[chips.length - 1].email);
              }
            }}
            placeholder={chips.length === 0 ? "Name or email address" : ""}
            className="flex-1 min-w-[140px] bg-transparent text-sm outline-none py-1"
            aria-label={`${label} recipients`}
          />
        </div>
        {showPop ? (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-md border bg-background shadow-md py-1 max-h-52 overflow-y-auto">
            {groupHits.map((g) => (
              <button
                key={`g-${g.id}`}
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center gap-2"
                onMouseDown={(e) => { e.preventDefault(); onGroup?.(g); setText(""); }}
              >
                <Users className="h-3.5 w-3.5 text-primary" /> <span className="font-medium">{g.name}</span>
                <span className="text-xs text-muted-foreground">group · {g.members.length} members</span>
              </button>
            ))}
            {contactHits.map((c) => (
              <button
                key={`c-${c.id}`}
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted flex items-center justify-between gap-2"
                onMouseDown={(e) => { e.preventDefault(); onAdd(c.email); setText(""); }}
              >
                <span className="truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground truncate">{c.email}</span>
              </button>
            ))}
            {query && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(query) && contactHits.length === 0 ? (
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                onMouseDown={(e) => { e.preventDefault(); onAdd(query); setText(""); }}
              >
                Add <span className="font-medium">{query}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
