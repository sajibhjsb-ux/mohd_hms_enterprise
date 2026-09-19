// MOHD.HMS ENTERPRISE — Email configuration API (§3/§4/§26/§60).
// GET  — safe configuration (the SMTP password NEVER leaves the server; only
//        a hasPassword boolean is returned)
// PATCH — authorized update; a non-empty smtpPassword replaces the stored
//        secret, omitting it keeps it, explicit null clears it. Audited without
//        any secret content.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getEmailConfig, toSafeConfig, updateEmailConfig } from "@/lib/hms/email/config";
import { resetTransportCache } from "@/lib/hms/email/provider";

export const GET = handler(
  async () => {
    const cfg = await getEmailConfig();
    return ok(toSafeConfig(cfg));
  },
  { permission: PERMISSIONS.email_view }
);

const updateSchema = z.object({
  provider: z.string().max(50).optional(),
  smtpHost: z.string().max(253).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecurity: z.enum(["NONE", "SSL", "STARTTLS"]).optional(),
  smtpUser: z.string().max(254).optional(),
  smtpPassword: z.string().max(500).nullable().optional(),
  fromName: z.string().max(120).optional(),
  fromEmail: z.string().max(254).optional(),
  replyTo: z.string().max(254).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  testRecipient: z.string().max(254).optional(),
});

export const PATCH = handler(
  async ({ req, user }): Promise<NextResponse> => {
    const body = await parseBody(req, updateSchema);
    // Only the dedicated smtpPassword field ever reaches the encryption layer.
    const { smtpPassword, ...rest } = body;
    const passwordUpdate = smtpPassword === undefined ? {} : { smtpPassword };
    try {
      const updated = await updateEmailConfig({ ...rest, ...passwordUpdate } as Parameters<typeof updateEmailConfig>[0]);
      resetTransportCache(); // transport config changed — rebuild on next use
      void audit({
        actorId: user.id, actorEmail: user.email, action: "EMAIL_CONFIG_UPDATED",
        resourceType: "EMAIL_CONFIG", resourceId: "singleton",
        metadata: {
          fields: Object.keys(rest),
          passwordChanged: Boolean(smtpPassword && smtpPassword.length > 0),
          passwordCleared: smtpPassword === null,
          host: updated.smtpHost, port: updated.smtpPort, security: updated.smtpSecurity,
        },
      });
      return ok(updated);
    } catch (e) {
      if (e instanceof Error && /not valid/.test(e.message)) throw Errors.badRequest(e.message);
      throw e;
    }
  },
  { permission: PERMISSIONS.email_config }
);
