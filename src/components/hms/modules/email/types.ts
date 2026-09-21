"use client";

// MOHD.HMS ENTERPRISE — Email client shared types (Email module).

export type Folder = "INBOX" | "SENT" | "DRAFT" | "OUTBOX" | "ARCHIVE" | "SPAM" | "TRASH";
export type FolderView = Folder | "STARRED";

export type MailListItem = {
  id: string;
  folder: string;
  direction: "IN" | "OUT";
  status: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  ccEmail: string;
  subject: string;
  excerpt: string;
  readAt: string | null;
  starredAt: string | null;
  threadId: string;
  emailLogId: string;
  sentAt: string | null;
  failedReason: string;
  attachmentRefs: string;
  originFolder: string;
  createdAt: string;
  updatedAt: string;
};

export type MailAttachment = {
  id: string;
  key: string;
  filename: string;
  size: number;
  contentType: string;
};

export type MailDetail = Omit<MailListItem, "attachmentRefs"> & {
  bodyHtml: string;
  attachments: MailAttachment[];
  inReplyToId: string;
  bccEmail: string;
};

export type ContactGroup = {
  id: string;
  name: string;
  color: string;
  members: { name: string; email: string }[];
};

export type Contact = {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl: string | null;
};

export type MailMeta = {
  identity: { name: string; email: string };
  sendingAs: { fromEmail: string; fromName: string; replyTo: string };
  smtpConfigured: boolean;
  counts: Record<Folder, number>;
  inboxUnread: number;
  starred: number;
  groups: ContactGroup[];
};

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export type ComposeInit = {
  mode: ComposeMode;
  draftId?: string;
  inReplyToId?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  attachments: MailAttachment[];
};

export function parseRefs(raw: string | null | undefined): MailAttachment[] {
  try {
    const arr = JSON.parse(raw || "[]") as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (a): a is MailAttachment =>
        Boolean(a) && typeof a === "object" &&
        typeof (a as MailAttachment).id === "string" &&
        typeof (a as MailAttachment).key === "string"
    );
  } catch {
    return [];
  }
}
