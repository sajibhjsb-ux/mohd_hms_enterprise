// MOHD.HMS ENTERPRISE — Send test email (§28).
// Renders a REAL template (or the built-in test body), sends it through the
// configured SMTP server, records the honest result in the email log and
// returns the actual outcome. Rate limited to prevent abuse.

import { NextRequest } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { sendTestEmail } from "@/lib/hms/email/service";

const schema = z.object({
  to: z.string().max(254).optional(),
  templateId: z.string().max(64).optional(),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, schema);
    // §39 — a small guard around the manual test send.
    const limited = rateLimit(`email-test-send:${user.id}:${clientIp(req)}`, 10, 60_000);
    if (!limited.allowed) throw Errors.tooMany(`Please wait ${limited.retryAfterSec}s before sending another test email.`);

    const cfgTo = body.to; // if omitted, the configured test recipient is used below
    const { getEmailConfig } = await import("@/lib/hms/email/config");
    const cfg = await getEmailConfig();
    const to = (cfgTo?.trim() || cfg.testRecipient.trim() || user.email);
    const result = await sendTestEmail({ to, templateId: body.templateId });
    return ok(result);
  },
  { permission: PERMISSIONS.email_config }
);
