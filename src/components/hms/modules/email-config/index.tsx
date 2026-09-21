"use client";

// MOHD.HMS ENTERPRISE — Email Configuration module page (/email-config).
//
// THE dedicated — and only — location for email INFRASTRUCTURE administration
// (§3/§4): health, SMTP configuration, test connection/test email, mailbox
// assignment, templates, automations and logs. This is an administrator area
// (email.view/email.config RBAC, enforced by every backing API) and it is
// completely separate from the user-facing Email client at /email — that
// module is for reading and writing mail, never for configuring servers.

import { Settings2 } from "lucide-react";
import { PageHeader } from "@/components/hms/shared/ui-bits";
import { EmailTab } from "./email-tab";

export function EmailConfigModule() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email Configuration"
        subtitle="Administrator area — mail server (SMTP), sender details, mailbox assignment, test tools, templates, automations and logs"
        actions={<Settings2 className="h-5 w-5 text-muted-foreground" aria-hidden />}
      />
      <EmailTab />
    </div>
  );
}
