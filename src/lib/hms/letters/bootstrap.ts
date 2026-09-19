// MOHD.HMS ENTERPRISE — Letters: idempotent template catalog bootstrap.
//
// Seeds the canonical template catalog ONLY when no template exists yet (same
// pattern as the legal system's canonical bootstrap). Admins then edit,
// duplicate, version and extend the catalog through the template manager —
// the canonical module is never re-applied over their changes.

import "server-only";
import { db } from "@/lib/db";
import { CANONICAL_LETTER_TEMPLATES } from "./canonical";
import { templateSnapshot } from "./server";
import type { LetterTemplate } from "@prisma/client";

let bootstrapPromise: Promise<void> | null = null;

async function runBootstrap(): Promise<void> {
  const existing = await db.letterTemplate.findFirst({ select: { id: true } });
  if (existing) return; // catalog already initialized — never overwrite admin edits

  for (const t of CANONICAL_LETTER_TEMPLATES) {
    // Unique-code race with a concurrent bootstrap is harmless (same content).
    await db.letterTemplate.upsert({
      where: { code: t.code },
      update: {},
      create: {
        code: t.code,
        name: t.name,
        letterType: t.letterType,
        description: t.description,
        department: t.department,
        isDefault: t.isDefault,
        subjectHint: t.subjectHint,
        aiInstructions: t.aiInstructions,
        bodyTemplate: t.bodyTemplate,
        closingTemplate: t.closingTemplate,
        fieldsJson: JSON.stringify(t.fields),
        version: 1,
      },
    });
  }

  // Seed version-1 snapshots for the freshly created templates.
  const created: LetterTemplate[] = await db.letterTemplate.findMany({
    where: { code: { in: CANONICAL_LETTER_TEMPLATES.map((t) => t.code) } },
  });
  for (const t of created) {
    await db.letterTemplateVersion.upsert({
      where: { templateId_version: { templateId: t.id, version: 1 } },
      update: {},
      create: {
        templateId: t.id,
        version: 1,
        snapshotJson: JSON.stringify(templateSnapshot(t)),
      },
    });
  }

  console.log(
    JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "letters.templates.bootstrapped", count: CANONICAL_LETTER_TEMPLATES.length })
  );
}

/** Idempotent, memoized per process. Never throws into the request path. */
export async function ensureLetterTemplatesBootstrapped(): Promise<void> {
  bootstrapPromise ??= runBootstrap().catch((e) => {
    bootstrapPromise = null; // allow a retry on the next request
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "letters.bootstrap.failed", err: e instanceof Error ? e.message : String(e) }));
  });
  return bootstrapPromise;
}
