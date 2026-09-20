"use client";

// MOHD.HMS ENTERPRISE — Email module page (/email).
//
// Dedicated navigation destination for the EXISTING centralized Email system.
// This page renders the SAME EmailTab component that powers Settings → Email —
// one email management UI, one EmailService, one set of APIs, one RBAC matrix
// (email.view / email.config / email.templates / email.automations /
// email.actions). It only wraps the existing administration UI as a standard
// module page (registry key → /{key} route → component) so the floating
// navigation can open Email Management in one click. No second email
// implementation, no duplicate configuration, no new backend.

import { Mail } from "lucide-react";
import { PageHeader } from "@/components/hms/shared/ui-bits";
import { EmailTab } from "@/components/hms/modules/settings/email-tab";

export function EmailModule() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Email"
        subtitle="Centralized email delivery — health, configuration, templates, automations and logs"
        actions={<Mail className="h-5 w-5 text-muted-foreground" aria-hidden />}
      />
      <EmailTab />
    </div>
  );
}
