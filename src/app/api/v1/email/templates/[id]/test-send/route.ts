// MOHD.HMS ENTERPRISE — Template test send (§44).
// Renders the REAL template with safe sample data and sends it via the actual
// SMTP configuration. The result is recorded in the email log and clearly
// marked as TEST. The honest send result is returned — no fake success.

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { clientIp, rateLimit } from "@/lib/hms/rate-limit";
import { sendTestEmail } from "@/lib/hms/email/service";
import { getEmailConfig } from "@/lib/hms/email/config";

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const template = await db.emailTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Email template not found.");
    const body = await parseBody(req, z.object({ to: z.string().max(254).optional() }));
    const limited = rateLimit(`email-tpl-test:${user.id}:${clientIp(req)}`, 10, 60_000);
    if (!limited.allowed) throw Errors.tooMany(`Please wait ${limited.retryAfterSec}s before sending another test.`);

    const cfg = await getEmailConfig();
    const to = body.to?.trim() || cfg.testRecipient.trim() || user.email;
    return ok(await sendTestEmail({ to, templateId: template.id }));
  },
  { permission: PERMISSIONS.email_templates }
);
