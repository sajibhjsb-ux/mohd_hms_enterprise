// MOHD.HMS ENTERPRISE — Email client meta (Email module mailbox).
// Per-folder counters, starred total, the signed-in identity, the approved
// sending identity and the shared contact groups. One round-trip for the
// whole client shell. Counts are REAL database aggregates — nothing fake.

import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getEmailConfig } from "@/lib/hms/email/config";
import { parseGroupMembers } from "@/lib/hms/email/client";

export const GET = handler(
  async ({ user }) => {
    const [totals, inboxUnread, starred, groups, cfg] = await Promise.all([
      db.mailMessage.groupBy({
        by: ["folder"],
        where: { ownerId: user.id },
        _count: { _all: true },
      }),
      db.mailMessage.count({ where: { ownerId: user.id, folder: "INBOX", readAt: null } }),
      db.mailMessage.count({ where: { ownerId: user.id, starredAt: { not: null }, folder: { not: "TRASH" } } }),
      db.mailContactGroup.findMany({ orderBy: { name: "asc" } }),
      getEmailConfig(),
    ]);

    const counts: Record<string, number> = {};
    for (const row of totals) counts[row.folder] = row._count._all;

    return ok({
      identity: { name: user.name, email: user.email },
      // The approved outbound identity (EmailConfig) — what recipients see.
      sendingAs: {
        fromEmail: cfg.fromEmail || cfg.smtpUser || "",
        fromName: user.name,
        replyTo: user.email,
      },
      smtpConfigured: Boolean(cfg.smtpHost && (cfg.fromEmail || cfg.smtpUser)),
      counts: {
        INBOX: counts.INBOX ?? 0,
        SENT: counts.SENT ?? 0,
        DRAFT: counts.DRAFT ?? 0,
        OUTBOX: counts.OUTBOX ?? 0,
        ARCHIVE: counts.ARCHIVE ?? 0,
        SPAM: counts.SPAM ?? 0,
        TRASH: counts.TRASH ?? 0,
      },
      inboxUnread,
      starred,
      groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, members: parseGroupMembers(g.members) })),
    });
  },
  { permission: PERMISSIONS.email_client }
);
