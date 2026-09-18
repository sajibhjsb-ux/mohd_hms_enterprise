// MOHD.HMS ENTERPRISE — Automation settings API (§36/§103).
// GET → current settings; PUT → update (settings_manage only; changes are audited).

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { getAutomationSettings, updateAutomationSettings, AUTOMATION_SETTING_DEFAULTS } from "@/lib/hms/workflows/settings";

export const GET = handler(async () => {
  const settings = await getAutomationSettings();
  return ok({ settings, defaults: AUTOMATION_SETTING_DEFAULTS });
}, { permission: PERMISSIONS.settings_read });

const putSchema = z.object({
  settings: z.record(z.string(), z.string().max(500)).refine(
    (s) => Object.keys(s).every((k) => k in AUTOMATION_SETTING_DEFAULTS),
    { message: "Unknown automation setting key." }
  ),
});

export const PUT = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, putSchema);
    const updated = await updateAutomationSettings(body.settings);
    await audit({
      actorId: user.id, actorEmail: user.email, action: "AUTOMATION_SETTINGS_UPDATED",
      resourceType: "SETTING", resourceId: "automation",
      metadata: { keys: Object.keys(body.settings) },
    });
    return ok({ settings: updated });
  },
  { permission: PERMISSIONS.settings_manage }
);
