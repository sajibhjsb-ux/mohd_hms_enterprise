"use client";

// MOHD.HMS ENTERPRISE — shared Email client types (client-side vocabulary).
// Mirrors the API payloads of /api/v1/email/client/*.

export type MailboxInfo = {
  id: string;
  email: string;
  displayName: string;
  kind: string;
  canSend: boolean;
  unread: number;
};

export type Bootstrap = {
  mailboxes: MailboxInfo[];
  counts: Record<string, number>;
  smtp: { configured: boolean };
  inbound: { supported: boolean; detail: string };
};

export type MessageListItem = {
  id: string;
  mailboxId: string;
  folder: string;
  status: string; // DRAFT | QUEUED | RETRYING | SENDING | SENT | FAILED | CANCELED
  direction: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  ccEmail: string;
  preview: string;
  readAt: string | null;
  starred: boolean;
  important: boolean;
  sentAt: string | null;
  hasAttachments: boolean;
  createdAt: string;
  lastError: string;
  attempts: number;
};

export type MessageListResult = {
  messages: MessageListItem[];
  total: number;
  page: number;
  pageSize: number;
  unreadByFolder: Record<string, number>;
  starred: number;
  important: number;
};

export type AttachmentInfo = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

export type ThreadEntry = {
  id: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  createdAt: string;
  preview: string;
  isCurrent: boolean;
};

export type MessageDetail = {
  id: string;
  mailboxId: string;
  folder: string;
  status: string;
  direction: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  toEmail: string;
  ccEmail: string;
  bccEmail: string;
  bodyHtml: string;
  bodyText: string;
  readAt: string | null;
  starred: boolean;
  important: boolean;
  sentAt: string | null;
  lastError: string;
  messageId: string;
  createdAt: string;
  attachments: AttachmentInfo[];
  thread: ThreadEntry[];
};

export type ComposePrefill = {
  mode: "reply" | "replyAll" | "forward";
  mailboxId: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  originalId: string;
};

export type Suggestions = {
  users: { id: string; name: string; email: string; role: string }[];
  mailboxes: { id: string; name: string; email: string }[];
  customers: { id: string; name: string; email: string }[];
};

export const MAIL_FOLDER_LABELS: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFTS: "Drafts",
  OUTBOX: "Outbox",
  STARRED: "Starred",
  IMPORTANT: "Important",
  ARCHIVE: "Archive",
  SPAM: "Spam",
  TRASH: "Trash",
};
