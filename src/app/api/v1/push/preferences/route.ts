// GET /api/v1/push/preferences — this user's effective push preferences.
// PUT /api/v1/push/preferences — update them (per-category push on/off).
// Preference data is per-user, server-authoritative, and only gates the PUSH
// channel (in-app/email/whatsapp keep their existing rules — spec §36).

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import {
  PUSH_CATEGORIES, PUSH_CATEGORY_LABELS,
  getEffectivePrefs, sanitizePrefInput, savePrefs,
} from "@/lib/hms/push/preferences";

export const GET = handler(
  async ({ user }) => {
    const prefs = await getEffectivePrefs(user.id);
    return ok({
      categories: PUSH_CATEGORIES.map((key) => ({ key, label: PUSH_CATEGORY_LABELS[key], push: prefs[key] })),
    });
  },
  { auth: true }
);

const putSchema = z.object({ preferences: z.record(z.string(), z.unknown()) });

export const PUT = handler(
  async ({ req, user }) => {
    const { preferences } = await parseBody(req, putSchema);
    const clean = sanitizePrefInput(preferences);
    await savePrefs(user.id, clean);
    const prefs = await getEffectivePrefs(user.id);
    return ok({
      categories: PUSH_CATEGORIES.map((key) => ({ key, label: PUSH_CATEGORY_LABELS[key], push: prefs[key] })),
    });
  },
  { auth: true }
);
