"use client";

// MOHD.HMS ENTERPRISE — Email Configuration module page (/email).
//
// THE dedicated — and only — location for email administration. This module
// owns the EmailTab (health, SMTP configuration, test connection, test email,
// templates, automations and logs): one email management UI, one EmailService,
// one set of APIs, one RBAC matrix (email.view / email.config /
// email.templates / email.automations / email.actions). The general Settings
// page contains no email configuration controls — editing SMTP or sender
// details anywhere else is not possible. No second email implementation, no
// duplicate configuration UI, no new backend.

import { Mail } from "lucide-react";
import { PageHeader } from "@/components/hms/shared/ui-bits";
import { EmailTab } from "./email-tab";

export function EmailModule() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email Configuration"
        subtitle="Centralized email delivery — SMTP configuration, sender details, test tools, templates, automations and logs"
        actions={<Mail className="h-5 w-5 text-muted-foreground" aria-hidden />}
      />
      <EmailTab />
    </div>
  );
}
