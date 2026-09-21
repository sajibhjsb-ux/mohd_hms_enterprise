// MOHD.HMS ENTERPRISE — Email contact groups: shared schema + validation.
// Used by /api/v1/email/client/groups (collection + item routes). Groups are
// distribution lists for the compose UI; members are validated email
// references only — the send path re-validates every address anyway.

import { z } from "zod";
import { Errors } from "@/lib/hms/api";

export const GROUP_COLORS = ["emerald", "amber", "rose", "teal", "orange", "cyan", "lime", "fuchsia"] as const;

export type MailGroupMember = { name: string; email: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const mailGroupSchema = z.object({
  name: z.string().trim().min(1, "Group name is required.").max(80),
  color: z.enum(GROUP_COLORS).default("emerald"),
  members: z.array(z.object({ name: z.string().max(80).default(""), email: z.string().max(254) })).max(200).default([]),
});

/** Parse the stored members JSON defensively (never trust the raw column). */
export function parseGroupMembers(raw: string): MailGroupMember[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((m) => ({ name: String((m as MailGroupMember)?.name ?? "").slice(0, 80), email: String((m as MailGroupMember)?.email ?? "").toLowerCase() }))
      .filter((m) => EMAIL_RE.test(m.email));
  } catch {
    return [];
  }
}

/** Validate + dedupe a members write payload (throws honest ApiErrors). */
export function normalizeGroupMembers(members: { name: string; email: string }[]): MailGroupMember[] {
  const seen = new Set<string>();
  const list: MailGroupMember[] = [];
  for (const m of members) {
    const email = String(m?.email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      throw Errors.badRequest(`"${email.slice(0, 60)}" is not a valid email address`);
    }
    if (seen.has(email)) continue;
    seen.add(email);
    list.push({ name: String(m?.name ?? "").trim().slice(0, 80), email });
    if (list.length > 200) throw Errors.badRequest("a group can hold at most 200 members");
  }
  return list;
}
