// MOHD.HMS ENTERPRISE — Central Document Template Service (Settings → Templates).
//
// THE one service for the template lifecycle over the central PDF registry
// (spec: Settings → TEMPLATE MANAGEMENT SYSTEM):
//
//   create → save drafts → validate → publish → set default → duplicate →
//   archive → version history / restore
//
// Design invariants (do not break):
//   • ONE registry — templateType keys are exactly the keys of
//     src/lib/hms/pdf/documents.ts; there is no second template engine.
//   • Versions are IMMUTABLE. Editing a published template always creates the
//     NEXT draft version; history is never overwritten (only restored-as-copy).
//   • A default template per type is unique (transactionally enforced here).
//   • Historic documents are pinned through DocumentTemplateSnapshot — see
//     resolveTemplateForDocument(): the pinned version wins over the default.
//   • Layout/style go through the sanitizers in template-meta.ts /
//     template-style.ts — no executable content ever reaches the renderer.
//   • Every state change writes an audit row (actor / template / version /
//     action); no secrets are ever recorded.

import "server-only";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { audit } from "@/lib/hms/services";
import {
  TEMPLATE_TYPES,
  sanitizeLayout,
  validateTemplate,
  DEFAULT_LAYOUT,
  type TemplateType,
  type TemplateLayout,
  type TemplateValidation,
} from "@/lib/hms/pdf/template-meta";
import { sanitizeStyle, DEFAULT_TEMPLATE_STYLE, type TemplateStyle } from "@/lib/hms/pdf/template-style";

/** A template version resolved for rendering (what documents.ts consumes). */
export type ResolvedTemplate = {
  templateId: string;
  templateName: string;
  versionId: string;
  versionNumber: number;
  layout: TemplateLayout;
  style: TemplateStyle;
};

type Actor = { id: string; email: string };

// ── resolution (used by the central PDF pipeline) ───────────────────────────

/**
 * Resolve the template for a document about to be generated (§ snapshot
 * semantics): an existing DocumentTemplateSnapshot pins the exact version that
 * document historically used (template edits NEVER change old documents);
 * only `?regenerate=1` re-resolves against the CURRENT default. Returns null
 * when no template applies → the built-in canonical layout renders.
 */
export async function resolveTemplateForDocument(
  templateType: string,
  entityId: string,
  opts?: { regenerate?: boolean }
): Promise<ResolvedTemplate | null> {
  if (!opts?.regenerate) {
    const snap = await db.documentTemplateSnapshot.findUnique({
      where: { entityType_entityId: { entityType: templateType, entityId } },
    });
    if (snap && snap.templateId !== "system" && snap.versionId) {
      const version = await db.documentTemplateVersion.findUnique({
        where: { id: snap.versionId },
        include: { template: { select: { id: true, name: true } } },
      });
      // History lock: the pinned version renders even if the template was
      // later deactivated or archived — versions are immutable data, not config.
      if (version) return toResolved(version, templateType);
    }
  }

  // Fresh resolution: the type's DEFAULT ACTIVE template with a PUBLISHED
  // current version. Multiple defaults are impossible (unique enforcement),
  // but a defensive orderBy keeps behaviour deterministic regardless.
  const tpl = await db.documentTemplate.findFirst({
    where: { templateType, isDefault: true, status: "ACTIVE" },
    include: {
      versions: {
        where: { status: "PUBLISHED" },
        orderBy: { version: "desc" },
        take: 1,
        include: { template: { select: { id: true, name: true } } },
      },
    },
  });
  const version = tpl?.versions[0];
  return version ? toResolved(version, templateType) : null;
}

function toResolved(
  v: {
    id: string;
    version: number;
    layout: string;
    style: string;
    template: { id: string; name: string };
  },
  templateType: string
): ResolvedTemplate {
  // sanitizeLayout drops any id outside the type's catalog — safe even if the
  // type were somehow unknown (layout degrades to its known subset).
  const type = (TEMPLATE_TYPES as readonly string[]).includes(templateType) ? (templateType as TemplateType) : "invoice";
  const layout = v.layout ? sanitizeLayout(safeJson(v.layout), type) : DEFAULT_LAYOUT;
  const style = sanitizeStyle(safeJson(v.style));
  return {
    templateId: v.template.id,
    templateName: v.template.name,
    versionId: v.id,
    versionNumber: v.version,
    layout,
    style,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Pin the template + version used for a generated document (§ snapshot). */
export async function recordTemplateSnapshot(input: {
  entityType: string;
  entityId: string;
  templateId: string;
  templateName: string;
  versionId: string;
  versionNumber: number;
  generatedById?: string | null;
}): Promise<void> {
  await db.documentTemplateSnapshot.upsert({
    where: { entityType_entityId: { entityType: input.entityType, entityId: input.entityId } },
    update: {
      templateId: input.templateId,
      templateName: input.templateName,
      versionId: input.versionId,
      versionNumber: input.versionNumber,
      generatedById: input.generatedById ?? null,
      generatedAt: new Date(),
    },
    create: {
      entityType: input.entityType,
      entityId: input.entityId,
      templateId: input.templateId,
      templateName: input.templateName,
      versionId: input.versionId,
      versionNumber: input.versionNumber,
      generatedById: input.generatedById ?? null,
    },
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export type TemplateListItem = {
  id: string;
  templateType: string;
  name: string;
  description: string;
  status: string;
  isDefault: boolean;
  currentVersion: { id: string; version: number; status: string; updatedAt: string } | null;
  versionCount: number;
  updatedAt: string;
};

export async function listTemplates(filter?: { templateType?: string; status?: string; search?: string }): Promise<TemplateListItem[]> {
  const rows = await db.documentTemplate.findMany({
    where: {
      ...(filter?.templateType ? { templateType: filter.templateType } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
      ...(filter?.search
        ? { OR: [{ name: { contains: filter.search } }, { description: { contains: filter.search } }] }
        : {}),
    },
    include: {
      currentVersion: true,
      _count: { select: { versions: true } },
    },
    orderBy: [{ templateType: "asc" }, { createdAt: "desc" }],
  });
  return rows.map((t) => ({
    id: t.id,
    templateType: t.templateType,
    name: t.name,
    description: t.description,
    status: t.status,
    isDefault: t.isDefault,
    currentVersion:
      t.currentVersionId && t.currentVersion
        ? {
            id: t.currentVersion.id,
            version: t.currentVersion.version,
            status: t.currentVersion.status,
            updatedAt: t.currentVersion.createdAt.toISOString(),
          }
        : null,
    versionCount: t._count.versions,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

export async function getTemplate(id: string) {
  const t = await db.documentTemplate.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" } },
      currentVersion: true,
    },
  });
  if (!t) throw Errors.notFound("Template not found.");
  const pinnedDocs = await db.documentTemplateSnapshot.count({ where: { templateId: id } });
  return {
    id: t.id,
    templateType: t.templateType,
    name: t.name,
    description: t.description,
    status: t.status,
    isDefault: t.isDefault,
    currentVersion: t.currentVersion
      ? {
          id: t.currentVersion.id,
          version: t.currentVersion.version,
          status: t.currentVersion.status,
          layout: safeParseOr(t.currentVersion.layout, {}),
          style: safeParseOr(t.currentVersion.style, {}),
          createdAt: t.currentVersion.createdAt.toISOString(),
        }
      : null,
    versions: t.versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: v.status,
      createdAt: v.createdAt.toISOString(),
      isCurrent: t.currentVersionId === v.id,
    })),
    snapshotCount: pinnedDocs,
    updatedAt: t.updatedAt.toISOString(),
  };
}

function safeParseOr(s: string, fallback: unknown): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

// ── mutations ───────────────────────────────────────────────────────────────

export async function createTemplate(
  input: { templateType: string; name: string; description?: string; layout?: unknown; style?: unknown },
  actor: Actor
): Promise<{ id: string }> {
  if (!(TEMPLATE_TYPES as readonly string[]).includes(input.templateType)) {
    throw Errors.badRequest("Unknown document type.");
  }
  const name = String(input.name ?? "").trim();
  if (!name) throw Errors.badRequest("Template name is required.");
  if (name.length > 80) throw Errors.badRequest("Template name must be 80 characters or fewer.");

  const type = input.templateType as TemplateType;
  const layout = sanitizeLayout(input.layout, type);
  const style = sanitizeStyle(input.style);

  const tpl = await db.documentTemplate.create({
    data: {
      templateType: input.templateType,
      name,
      description: String(input.description ?? "").slice(0, 300),
      status: "DRAFT",
      createdById: actor.id,
      versions: {
        create: { version: 1, layout: JSON.stringify(layout), style: JSON.stringify(style), createdById: actor.id },
      },
    },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  await db.documentTemplate.update({ where: { id: tpl.id }, data: { currentVersionId: tpl.versions[0].id } });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_CREATED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: tpl.id,
    metadata: { templateType: input.templateType, name },
  });
  return { id: tpl.id };
}

/**
 * Save edits to the working draft. If the current version is DRAFT it is
 * updated in place (drafts are mutable); otherwise a NEW next-version draft
 * is created — published versions are never modified (§ history immutability).
 */
export async function updateDraft(
  id: string,
  input: { name?: string; description?: string; layout?: unknown; style?: unknown },
  actor: Actor
): Promise<{ versionId: string; version: number; newVersionCreated: boolean }> {
  const tpl = await db.documentTemplate.findUnique({
    where: { id },
    include: { currentVersion: true },
  });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (tpl.status === "ARCHIVED") throw Errors.badRequest("Archived templates cannot be edited.");

  const type = tpl.templateType as TemplateType;
  const data: { name?: string; description?: string } = {};
  if (input.name !== undefined) {
    const name = String(input.name ?? "").trim();
    if (!name) throw Errors.badRequest("Template name is required.");
    if (name.length > 80) throw Errors.badRequest("Template name must be 80 characters or fewer.");
    data.name = name;
  }
  if (input.description !== undefined) data.description = String(input.description ?? "").slice(0, 300);

  const layout = input.layout !== undefined ? sanitizeLayout(input.layout, type) : null;
  const style = input.style !== undefined ? sanitizeStyle(input.style) : null;

  let versionRow = tpl.currentVersion;
  const draftIsMutable = Boolean(versionRow && versionRow.status === "DRAFT");
  if (draftIsMutable && versionRow) {
    await db.documentTemplateVersion.update({
      where: { id: versionRow.id },
      data: {
        ...(layout !== null ? { layout: JSON.stringify(layout) } : {}),
        ...(style !== null ? { style: JSON.stringify(style) } : {}),
      },
    });
  } else {
    const last = await db.documentTemplateVersion.findFirst({
      where: { templateId: id },
      orderBy: { version: "desc" },
    });
    versionRow = await db.documentTemplateVersion.create({
      data: {
        templateId: id,
        version: (last?.version ?? 0) + 1,
        layout: JSON.stringify(layout ?? DEFAULT_LAYOUT),
        style: JSON.stringify(style ?? sanitizeStyle(null)),
        createdById: actor.id,
      },
    });
    await db.documentTemplate.update({ where: { id }, data: { currentVersionId: versionRow.id } });
  }
  if (Object.keys(data).length > 0) {
    await db.documentTemplate.update({ where: { id }, data });
  }

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_DRAFT_SAVED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
    metadata: { version: versionRow.version, newVersionCreated: !draftIsMutable },
  });
  return { versionId: versionRow.id, version: versionRow.version, newVersionCreated: !draftIsMutable };
}

/** Validate the working draft (publish-time gate, § validation). */
export async function validateDraft(id: string): Promise<TemplateValidation & { versionId: string; version: number }> {
  const tpl = await db.documentTemplate.findUnique({ where: { id }, include: { currentVersion: true } });
  if (!tpl || !tpl.currentVersion) throw Errors.notFound("Template not found.");
  const type = tpl.templateType as TemplateType;
  const layout = sanitizeLayout(safeJson(tpl.currentVersion.layout), type);
  const style = sanitizeStyle(safeJson(tpl.currentVersion.style));
  const result = validateTemplate(type, layout, style);
  return { ...result, versionId: tpl.currentVersion.id, version: tpl.currentVersion.version };
}

/**
 * Publish the working draft: validation errors block publishing; the sample
 * PDF is built through the REAL renderer as the final gate so a broken
 * template can never become the production look. Version → PUBLISHED,
 * template → ACTIVE.
 */
export async function publishTemplate(id: string, actor: Actor): Promise<{ version: number; warnings: string[] }> {
  const tpl = await db.documentTemplate.findUnique({ where: { id }, include: { currentVersion: true } });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (!tpl.currentVersion) throw Errors.badRequest("Template has no version to publish.");
  if (tpl.currentVersion.status === "PUBLISHED")
    throw Errors.badRequest("This version is already published. Edit the template to start a new draft.");
  if (tpl.status === "ARCHIVED") throw Errors.badRequest("Archived templates cannot be published.");

  const check = await validateDraft(id);
  if (!check.ok) {
    throw Errors.badRequest(`Template validation failed: ${check.errors.join(" ")}`);
  }

  // Final gate — render the sample through the production engine. A renderer
  // failure here must stop the publish (malformed templates never go live).
  const { buildSampleDocument } = await import("@/lib/hms/pdf/documents");
  const type = tpl.templateType as TemplateType;
  const layout = sanitizeLayout(safeJson(tpl.currentVersion.layout), type);
  const style = sanitizeStyle(safeJson(tpl.currentVersion.style));
  await buildSampleDocument(type, layout, style);

  await db.documentTemplateVersion.update({ where: { id: tpl.currentVersion.id }, data: { status: "PUBLISHED" } });
  await db.documentTemplate.update({ where: { id }, data: { status: "ACTIVE" } });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_PUBLISHED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
    metadata: { version: tpl.currentVersion.version },
  });
  return { version: tpl.currentVersion.version, warnings: check.warnings };
}

/** Set the type default (ONE per type — cleared transactionally everywhere). */
export async function setTemplateDefault(id: string, actor: Actor): Promise<void> {
  const tpl = await db.documentTemplate.findUnique({ where: { id } });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (tpl.status !== "ACTIVE") throw Errors.badRequest("Only ACTIVE templates can become the default.");
  const published = await db.documentTemplateVersion.count({ where: { templateId: id, status: "PUBLISHED" } });
  if (published === 0) throw Errors.badRequest("Publish the template before making it the default.");

  await db.$transaction([
    db.documentTemplate.updateMany({ where: { templateType: tpl.templateType, isDefault: true }, data: { isDefault: false } }),
    db.documentTemplate.update({ where: { id }, data: { isDefault: true } }),
  ]);

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_SET_DEFAULT",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
    metadata: { templateType: tpl.templateType },
  });
}

/** ACTIVE ↔ INACTIVE (temporarily take a template out of rotation). */
export async function setTemplateStatus(id: string, status: "ACTIVE" | "INACTIVE", actor: Actor): Promise<void> {
  const tpl = await db.documentTemplate.findUnique({ where: { id } });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (tpl.status !== "ACTIVE" && tpl.status !== "INACTIVE")
    throw Errors.badRequest("Only published (ACTIVE) templates can be enabled or disabled.");
  await db.documentTemplate.update({ where: { id }, data: { status } });
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: status === "ACTIVE" ? "TEMPLATE_ACTIVATED" : "TEMPLATE_DEACTIVATED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
  });
}

/**
 * Archive — soft retirement. Nothing is deleted: versions stay immutable and
 * documents pinned to this template keep rendering from their snapshots.
 * Archiving clears the default flag (a retired template cannot be the default).
 */
export async function archiveTemplate(id: string, actor: Actor): Promise<void> {
  const tpl = await db.documentTemplate.findUnique({ where: { id } });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (tpl.status === "ARCHIVED") throw Errors.badRequest("Template is already archived.");
  await db.documentTemplate.update({ where: { id }, data: { status: "ARCHIVED", isDefault: false } });
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_ARCHIVED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
    metadata: { templateType: tpl.templateType, wasDefault: tpl.isDefault },
  });
}

/** Duplicate any template (any status) into a fresh DRAFT copy. */
export async function duplicateTemplate(id: string, actor: Actor): Promise<{ id: string }> {
  const tpl = await db.documentTemplate.findUnique({ where: { id }, include: { currentVersion: true } });
  if (!tpl) throw Errors.notFound("Template not found.");
  const source =
    tpl.currentVersion ??
    (await db.documentTemplateVersion.findFirst({ where: { templateId: id }, orderBy: { version: "desc" } }));
  if (!source) throw Errors.badRequest("Template has no version to copy.");

  const copy = await db.documentTemplate.create({
    data: {
      templateType: tpl.templateType,
      name: `${tpl.name} (Copy)`.slice(0, 80),
      description: tpl.description,
      status: "DRAFT",
      createdById: actor.id,
      versions: {
        create: { version: 1, layout: source.layout, style: source.style, createdById: actor.id },
      },
    },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  await db.documentTemplate.update({ where: { id: copy.id }, data: { currentVersionId: copy.versions[0].id } });

  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_DUPLICATED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: copy.id,
    metadata: { sourceTemplateId: id, sourceVersion: source.version },
  });
  return { id: copy.id };
}

/** Restore a historical version AS A NEW DRAFT (history is never rewritten). */
export async function restoreVersion(id: string, versionId: string, actor: Actor): Promise<{ versionId: string; version: number }> {
  const tpl = await db.documentTemplate.findUnique({ where: { id } });
  if (!tpl) throw Errors.notFound("Template not found.");
  if (tpl.status === "ARCHIVED") throw Errors.badRequest("Restore the template from the archive first.");
  const source = await db.documentTemplateVersion.findUnique({ where: { id: versionId } });
  if (!source || source.templateId !== id) throw Errors.notFound("Version not found.");

  const isCurrentDraft = tpl.currentVersionId === source.id && source.status === "DRAFT";
  if (isCurrentDraft) return { versionId: source.id, version: source.version };

  const last = await db.documentTemplateVersion.findFirst({ where: { templateId: id }, orderBy: { version: "desc" } });
  const created = await db.documentTemplateVersion.create({
    data: {
      templateId: id,
      version: (last?.version ?? 0) + 1,
      layout: source.layout,
      style: source.style,
      createdById: actor.id,
    },
  });
  await db.documentTemplate.update({ where: { id }, data: { currentVersionId: created.id } });
  await audit({
    actorId: actor.id,
    actorEmail: actor.email,
    action: "TEMPLATE_VERSION_RESTORED",
    resourceType: "DOCUMENT_TEMPLATE",
    resourceId: id,
    metadata: { restoredFromVersion: source.version, newDraftVersion: created.version },
  });
  return { versionId: created.id, version: created.version };
}

/** Style preset used when the editor needs a baseline (default = historical). */
export function baselineStyle(): TemplateStyle {
  return {
    ...DEFAULT_TEMPLATE_STYLE,
    margins: { ...DEFAULT_TEMPLATE_STYLE.margins },
    header: { ...DEFAULT_TEMPLATE_STYLE.header },
    footer: { ...DEFAULT_TEMPLATE_STYLE.footer },
  };
}
