// GET /api/v1/notifications/preferences — this user's per-channel preferences
// for every notification category (in-app is always delivered; this governs
// the EMAIL / WHATSAPP / PUSH outbound channels).
// PUT /api/v1/notifications/preferences — update them (per category per channel).
// Preference data is per-user and server-authoritative. CRITICAL notifications
// always bypass these preferences server-side (never gated).
//
// Storage: the NotificationPreference.channels JSON map
//   { "<CATEGORY>": { push: bool, email: bool, whatsapp: bool } }
// (legacy boolean values `{ "<CATEGORY>": true }` still read as push-only).

import { z } from "zod";
import { handler, ok, parseBody } from "@/lib/hms/api";
import {
  PUSH_CATEGORIES, PUSH_CATEGORY_LABELS,
  getEffectiveChannelPrefs, sanitizeChannelPrefInput, saveChannelPrefs,
} from "@/lib/hms/push/preferences";

export const GET = handler(
  async ({ user }) => {
    const prefs = await getEffectiveChannelPrefs(user.id);
    return ok({
      categories: PUSH_CATEGORIES.map((key) => ({
        key,
        label: PUSH_CATEGORY_LABELS[key],
        push: prefs[key].push,
        email: prefs[key].email,
        whatsapp: prefs[key].whatsapp,
      })),
    });
  },
  { auth: true }
);

const putSchema = z.object({ preferences: z.record(z.string(), z.unknown()) });

export const PUT = handler(
  async ({ req, user }) => {
    const { preferences } = await parseBody(req, putSchema);
    await saveChannelPrefs(user.id, sanitizeChannelPrefInput(preferences));
    const prefs = await getEffectiveChannelPrefs(user.id);
    return ok({
      categories: PUSH_CATEGORIES.map((key) => ({
        key,
        label: PUSH_CATEGORY_LABELS[key],
        push: prefs[key].push,
        email: prefs[key].email,
        whatsapp: prefs[key].whatsapp,
      })),
    });
  },
  { auth: true }
);