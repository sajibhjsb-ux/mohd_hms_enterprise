"use client";

// MOHD.HMS ENTERPRISE — Email module router (/email) — the USER-FACING
// email client (spec §6/§7). This module is for reading, writing, organizing
// and searching mail ONLY; infrastructure configuration (SMTP, mailboxes,
// templates, automations, logs) lives in SETTINGS → Email and is never
// reachable from here (the user's direction — one configuration surface).
//
// NAVIGATION ARCHITECTURE (existing hash router — ui-store pages["email"]):
//   []                    → client main (folders + list + reading pane)
//   ["f", folder]         → open a specific folder (inbox/sent/drafts/…)
//   ["m", messageId]      → dedicated message detail (deep links, mobile)
//   ["compose"]           → dedicated Compose page (§11 — never a tiny popup)
//       ?draft=<id>                   resume a draft (§10)
//       ?reply=<id> | ?replyAll=<id>  reply / reply-all prefill (§16/§17)
//       ?forward=<id>                 forward prefill + attachments (§18)

import { useUi } from "@/lib/hms/ui-store";
import { MailClient } from "./client-main";
import { ComposePage } from "./compose";
import { MessageDetailPage } from "./message-detail";

export function MailClientModule() {
  const seg = useUi((s) => s.pages["email"]) ?? [];
  const [head, second] = seg;

  if (head === "compose") return <ComposePage />;
  if (head === "m" && second) return <MessageDetailPage messageId={second} />;
  if (head === "f" && second) return <MailClient initialFolder={second.toUpperCase()} />;
  return <MailClient />;
}
