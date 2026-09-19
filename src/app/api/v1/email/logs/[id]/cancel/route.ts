// MOHD.HMS ENTERPRISE — Cancel a queued/failed email (§37).

import { NextRequest } from "next/server";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { cancelEmail } from "@/lib/hms/email/service";

export const POST = handler(
  async ({ req, user }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const result = await cancelEmail(id);
    if (!result.ok) throw Errors.badRequest(result.reason ?? "This email cannot be canceled.");
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_CANCELED", resourceType: "EMAIL", resourceId: id, metadata: { by: user.email } });
    return ok({ id, status: "CANCELED" });
  },
  { permission: PERMISSIONS.email_actions }
);
