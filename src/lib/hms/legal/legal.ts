// MOHD.HMS ENTERPRISE — legal content service (Terms & Conditions / Privacy).
//
// Canonical source: the LegalDocument table (one authoritative document per
// kind). The canonical module only bootstraps a kind the FIRST time (fresh
// databases); from then on admins manage versions in Settings → Legal.
// Published documents are immutable — corrections ship as a new version.
//
// Public surfaces (logged-out pages, customer portal, consent gate) read the
// same published document through this module — there is exactly ONE source.

import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import { CANONICAL_DOCUMENTS, LEGAL_KINDS, type LegalKind, type LegalSectionInput } from "./canonical";
import type { LegalSection, PublicLegalDoc, TermsStatusShape } from "./types";

export type { PublicLegalDoc } from "./types";

/** Terms acceptance state attached to the session payload. */
export type TermsStatus = TermsStatusShape;

export const LEGAL_ACCEPTANCE_SETTING = "terms_acceptance_required";
export const SETTING_KEYS_TOUCHED_BY_LEGAL = [LEGAL_ACCEPTANCE_SETTING];

// ── published-document cache (mirrors the automation-settings cache discipline)

let cache: { at: number; docs: Map<LegalKind, PublicLegalDoc> } = { at: 0, docs: new Map() };
const CACHE_TTL_MS = 60 * 1000;

function invalidateLegalCache(): void {
  cache = { at: 0, docs: new Map() };
}

// ── parsing helpers

type StoredDoc = {
  id: string;
  kind: string;
  version: string;
  effectiveDate: Date | null;
  publishedAt: Date | null;
  changeSummary: string;
  sections: string;
};

function parseSections(raw: string): LegalSectionInput[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is LegalSectionInput => !!s && typeof s.title === "string" && typeof s.body === "string")
      .map((s) => ({
        id: typeof s.id === "string" ? s.id : "",
        title: s.title,
        body: s.body,
        ...(s.needsReview ? { needsReview: true } : {}),
      }));
  } catch {
    return [];
  }
}

function toPublicDoc(doc: StoredDoc): PublicLegalDoc {
  return {
    id: doc.id,
    kind: doc.kind as LegalKind,
    version: doc.version,
    effectiveDate: doc.effectiveDate ? doc.effectiveDate.toISOString().slice(0, 10) : null,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    changeSummary: doc.changeSummary,
    // Public readers never see needsReview flags — those live in the admin UI.
    sections: parseSections(doc.sections).map(({ id, title, body }) => ({ id, title, body })),
  };
}

function isLegalKind(kind: string): kind is LegalKind {
  return (LEGAL_KINDS as string[]).includes(kind);
}

// ── bootstrap (idempotent — runs only when a kind has no document at all)

export async function ensureLegalDocuments(): Promise<void> {
  for (const kind of LEGAL_KINDS) {
    const existing = await db.legalDocument.findFirst({ where: { kind }, select: { id: true } });
    if (existing) continue;
    const canonical = CANONICAL_DOCUMENTS.find((d) => d.kind === kind);
    if (!canonical) continue;
    try {
      await db.legalDocument.create({
        data: {
          kind,
          version: canonical.version,
          status: canonical.status,
          effectiveDate: canonical.effectiveDate ? new Date(canonical.effectiveDate) : null,
          publishedAt: canonical.status === "PUBLISHED" ? new Date() : null,
          changeSummary: canonical.changeSummary,
          sections: JSON.stringify(canonical.sections),
        },
      });
    } catch {
      // Unique [kind, version] race with a concurrent bootstrap — harmless.
    }
  }
  invalidateLegalCache();
}

// ── public readers

/** The currently PUBLISHED document for a kind (cached 60s), or null. */
export async function getPublishedLegal(kind: LegalKind): Promise<PublicLegalDoc | null> {
  if (!isLegalKind(kind)) return null;
  const now = Date.now();
  if (now - cache.at > CACHE_TTL_MS) {
    const docs = await db.legalDocument.findMany({ where: { status: "PUBLISHED" } });
    const map = new Map<LegalKind, PublicLegalDoc>();
    for (const doc of docs) {
      if (isLegalKind(doc.kind)) map.set(doc.kind, toPublicDoc(doc));
    }
    cache = { at: now, docs: map };
  }
  return cache.docs.get(kind) ?? null;
}

/** Company identity for legal pages — ONLY whitelisted keys, never the whole
 *  settings map (the settings API itself stays admin-only). */
export async function getCompanyIdentity(): Promise<{
  name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  country: string;
}> {
  const keys = ["company_name", "company_address", "company_phone", "company_email_info", "company_country", "public_url"];
  const rows = await db.setting.findMany({ where: { key: { in: keys } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name: map.get("company_name") || "MOHD.HMS Enterprise",
    address: map.get("company_address") || "",
    phone: map.get("company_phone") || "",
    email: map.get("company_email_info") || "",
    website: map.get("public_url") || "",
    country: map.get("company_country") || "Brunei Darussalam",
  };
}

async function acceptanceRequired(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: LEGAL_ACCEPTANCE_SETTING }, select: { value: true } });
  return (row?.value ?? "true") !== "false";
}

/** Terms acceptance state for a session payload (customers only are gated). */
export async function termsStatusFor(user: { id: string; role: string }): Promise<TermsStatus> {
  const doc = await getPublishedLegal("TERMS");
  const accepted = await db.legalAcceptance.findFirst({
    where: { userId: user.id, kind: "TERMS" },
    orderBy: { acceptedAt: "desc" },
    select: { version: true, documentId: true },
  });
  const requiresAcceptance =
    user.role === "CUSTOMER" &&
    doc !== null &&
    (await acceptanceRequired()) &&
    accepted?.documentId !== doc.id;
  return {
    version: doc?.version ?? null,
    effectiveDate: doc?.effectiveDate ?? null,
    publishedAt: doc?.publishedAt ?? null,
    changeSummary: doc?.changeSummary ?? null,
    acceptedVersion: accepted?.version ?? null,
    requiresAcceptance,
  };
}

/** Guard for customer mutation endpoints (service requests, portal confirmations). */
export async function assertTermsAccepted(user: { id: string; role: string }): Promise<void> {
  if (user.role !== "CUSTOMER") return;
  const status = await termsStatusFor(user);
  if (status.requiresAcceptance) {
    throw new ApiError(
      403,
      "TERMS_NOT_ACCEPTED",
      "Please review and accept the current Terms & Conditions before submitting a request."
    );
  }
}

// ── acceptance (backend-authoritative; idempotent via unique [userId, documentId])

export async function recordTermsAcceptance(
  user: { id: string; email: string; role: string },
  meta: { ip?: string; userAgent?: string; context?: string }
): Promise<TermsStatus> {
  const doc = await db.legalDocument.findFirst({ where: { kind: "TERMS", status: "PUBLISHED" } });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "There is no published Terms & Conditions to accept.");
  const context = meta.context && meta.context.length <= 60 ? meta.context : "WEB_APP";
  await db.legalAcceptance.upsert({
    where: { userId_documentId: { userId: user.id, documentId: doc.id } },
    update: { acceptedAt: new Date(), ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null },
    create: {
      userId: user.id,
      documentId: doc.id,
      kind: "TERMS",
      version: doc.version,
      context,
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    },
  });
  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "TERMS_ACCEPTED",
    resourceType: "LegalDocument",
    resourceId: doc.id,
    metadata: { version: doc.version, kind: "TERMS", context },
    ip: meta.ip,
  });
  invalidateLegalCache();
  return termsStatusFor(user);
}

// ── admin operations (Settings → Legal; settings_read / settings_manage)

export type AdminLegalDoc = Omit<PublicLegalDoc, "sections"> & {
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  /** Sections with the internal needsReview flags (admin UI only). */
  sections: (LegalSection & { needsReview?: boolean })[];
  acceptanceCount: number;
};

export async function getLegalAdminOverview(): Promise<{
  documents: AdminLegalDoc[];
  acceptanceRequired: boolean;
}> {
  const [docs, counts, required] = await Promise.all([
    db.legalDocument.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "desc" }] }),
    db.legalAcceptance.groupBy({ by: ["documentId"], _count: { _all: true } }),
    acceptanceRequired(),
  ]);
  const countMap = new Map(counts.map((c) => [c.documentId, c._count._all]));
  const documents: AdminLegalDoc[] = docs.map((doc) => ({
    id: doc.id,
    kind: doc.kind as LegalKind,
    version: doc.version,
    status: doc.status as AdminLegalDoc["status"],
    effectiveDate: doc.effectiveDate ? doc.effectiveDate.toISOString().slice(0, 10) : null,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    changeSummary: doc.changeSummary,
    sections: parseSections(doc.sections),
    acceptanceCount: countMap.get(doc.id) ?? 0,
  }));
  return { documents, acceptanceRequired: required };
}

export type DraftInput = {
  kind: LegalKind;
  version: string;
  effectiveDate: string | null;
  changeSummary: string;
  sections: LegalSectionInput[];
};

/** Create or update a DRAFT. Published/archived versions are immutable. */
export async function saveLegalDraft(
  input: DraftInput,
  actor: { id: string; email: string },
  ip?: string
): Promise<AdminLegalDoc> {
  const existing = await db.legalDocument.findUnique({
    where: { kind_version: { kind: input.kind, version: input.version } },
  });
  if (existing && existing.status !== "DRAFT") {
    throw new ApiError(
      409,
      "CONFLICT",
      `Version ${input.version} of this document is already ${existing.status.toLowerCase()} and cannot be edited. Publish your changes as a new version.`
    );
  }
  const effectiveDate = input.effectiveDate ? new Date(`${input.effectiveDate}T00:00:00.000Z`) : null;
  if (effectiveDate && Number.isNaN(effectiveDate.getTime())) {
    throw new ApiError(400, "BAD_REQUEST", "The effective date is not a valid date.");
  }
  const data = {
    kind: input.kind,
    version: input.version,
    effectiveDate,
    changeSummary: input.changeSummary.slice(0, 2000),
    sections: JSON.stringify(input.sections),
  };
  const doc = existing
    ? await db.legalDocument.update({ where: { id: existing.id }, data })
    : await db.legalDocument.create({ data: { ...data, status: "DRAFT" } });
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: existing ? "LEGAL_TERMS_DRAFT_SAVED" : "LEGAL_TERMS_DRAFT_CREATED",
    resourceType: "LegalDocument",
    resourceId: doc.id,
    metadata: { kind: input.kind, version: input.version, sections: input.sections.length },
    ip,
  });
  return { ...toAdminDoc(doc), acceptanceCount: 0 };
}

/** Publish a DRAFT: archives the currently published version (immutable) and
 *  promotes the draft. Existing users keep their old acceptance — they are
 *  asked to accept the new version on next use (never silently re-marked). */
export async function publishLegalDraft(
  id: string,
  actor: { id: string; email: string },
  ip?: string
): Promise<AdminLegalDoc> {
  const doc = await db.legalDocument.findUnique({ where: { id } });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Draft document not found.");
  if (doc.status !== "DRAFT") {
    throw new ApiError(409, "CONFLICT", "Only a draft can be published.");
  }
  const previous = await db.legalDocument.findFirst({ where: { kind: doc.kind, status: "PUBLISHED" } });
  await db.$transaction([
    ...(previous
      ? [db.legalDocument.update({ where: { id: previous.id }, data: { status: "ARCHIVED" } })]
      : []),
    db.legalDocument.update({
      where: { id: doc.id },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    }),
  ]);
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "LEGAL_TERMS_PUBLISHED",
    resourceType: "LegalDocument",
    resourceId: doc.id,
    metadata: { kind: doc.kind, version: doc.version, previousVersion: previous?.version ?? null },
    ip,
  });
  invalidateLegalCache();
  return { ...toAdminDoc({ ...doc, status: "PUBLISHED", publishedAt: new Date() }), acceptanceCount: 0 };
}

/** Discard a DRAFT (published versions are never deletable — evidence). */
export async function deleteLegalDraft(
  id: string,
  actor: { id: string; email: string },
  ip?: string
): Promise<void> {
  const doc = await db.legalDocument.findUnique({ where: { id } });
  if (!doc) throw new ApiError(404, "NOT_FOUND", "Draft document not found.");
  if (doc.status !== "DRAFT") {
    throw new ApiError(409, "CONFLICT", "Published versions are kept as records and cannot be deleted here.");
  }
  await db.legalDocument.delete({ where: { id } });
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "LEGAL_TERMS_DRAFT_DISCARDED",
    resourceType: "LegalDocument",
    resourceId: id,
    metadata: { kind: doc.kind, version: doc.version },
    ip,
  });
}

function toAdminDoc(doc: StoredDoc & { status: string; id: string }): Omit<AdminLegalDoc, "acceptanceCount"> {
  return {
    id: doc.id,
    kind: doc.kind as LegalKind,
    version: doc.version,
    status: doc.status as AdminLegalDoc["status"],
    effectiveDate: doc.effectiveDate ? doc.effectiveDate.toISOString().slice(0, 10) : null,
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    changeSummary: doc.changeSummary,
    sections: parseSections(doc.sections),
  };
}
