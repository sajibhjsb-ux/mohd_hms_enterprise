"use client";

// MOHD.HMS ENTERPRISE — Email module page (/email).
//
// The professional EMAIL CLIENT for every staff role: inbox, compose, drafts,
// outbox, archive, starred, spam, trash, search and contact groups — powered
// by the ONE centralized EmailService (external delivery) plus real internal
// mailbox delivery. SMTP/templates/automations/logs ADMINISTRATION lives
// exclusively in Settings → Email; this module contains no configuration.

import { EmailClient } from "./email-client";

export function EmailModule() {
  return <EmailClient />;
}
