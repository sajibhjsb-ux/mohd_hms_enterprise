// MOHD.HMS ENTERPRISE — Settings API.
// GET /api/v1/settings  (settings.read)   — all settings as { key: value } (string values)
// PUT /api/v1/settings  (settings.manage) — upsert a map of values; audits changed keys

import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    ""
  );
}

async function allSettingsMap(): Promise<Record<string, string>> {
  const rows = await db.setting.findMany({ orderBy: { key: "asc" } });
  const values: Record<string, string> = {};
  for (const row of rows) values[row.key] = row.value;
  return values;
}

export const GET = handler(
  async () => {
    return ok(await allSettingsMap());
  },
  { permission: PERMISSIONS.settings_read }
);

const putSchema = z.object({
  values: z
    .record(
      z.string().regex(/^[a-z0-9_.]+$/i, "Setting keys may only contain letters, numbers, dots and underscores.").min(1).max(100),
      z.string().max(5000, "Setting values are limited to 5000 characters.")
    )
    .refine((v) => Object.keys(v).length > 0, "Provide at least one setting value.")
    .refine((v) => Object.keys(v).length <= 100, "Too many settings in one request."),
});

export const PUT = handler(
  async ({ req, user }) => {
    const { values } = await parseBody(req, putSchema);
    const keys = Object.keys(values);

    await db.$transaction(
      keys.map((key) =>
        db.setting.upsert({
          where: { key },
          update: { value: values[key] },
          create: { key, value: values[key] },
        })
      )
    );

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "SETTINGS_UPDATED",
      resourceType: "Setting",
      resourceId: "settings",
      metadata: { keys, count: keys.length },
      ip: clientIp(req),
    });

    return ok(await allSettingsMap());
  },
  { permission: PERMISSIONS.settings_manage }
);
