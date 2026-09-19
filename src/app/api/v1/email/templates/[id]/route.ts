// MOHD.HMS ENTERPRISE — Email template detail API (§8/§42).
// GET    — full template (+ versions on ?versions=1)
// PATCH  — edit; content-affecting edits (subject/body/variables) bump the
//          version and write an immutable EmailTemplateVersion snapshot.
//          System templates stay editable (versioned), critical templates can
//          never be deactivated. Activation requires validation to pass.
// DELETE — soft delete (archive); canonical system templates used by
//          automations are archived only when unreferenced.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { validateTemplate } from "@/lib/hms/email/render";

function idOf(req: NextRequest): string {
  return new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
}

async function templateOf(req: NextRequest) {
  const id = idOf(req);
  const template = await db.emailTemplate.findUnique({ where: { id } });
  if (!template) throw Errors.notFound("Email template not found.");
  return template;
}

export const GET = handler(
  async ({ req }) => {
    const template = await templateOf(req);
    const withVersions = new URL(req.url).searchParams.get("versions") === "1";
    const versions = withVersions
      ? await db.emailTemplateVersion.findMany({ where: { templateId: template.id }, orderBy: { version: "desc" } })
      : undefined;
    let variables: string[] = [];
    try {
      const parsed = JSON.parse(template.variables || "[]");
      if (Array.isArray(parsed)) variables = parsed.filter((v) => typeof v === "string");
    } catch { /* keep empty */ }
    return ok({ ...template, variables, ...(versions ? { versions } : {}) });
  },
  { permission: PERMISSIONS.email_view }
);

const patchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  subject: z.string().max(300).optional(),
  bodyHtml: z.string().max(200_000).optional(),
  variables: z.array(z.string().regex(/^[A-Z0-9_]{2,60}$/)).max(100).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = handler(
  async ({ req, user }) => {
    const template = await templateOf(req);
    const body = await parseBody(req, patchSchema);

    const nextSubject = body.subject ?? template.subject;
    const nextBody = body.bodyHtml ?? template.bodyHtml;
    const nextVars = body.variables ?? safeVars(template.variables);
    const contentChanged = nextSubject !== template.subject || nextBody !== template.bodyHtml;

    // Activation requires validation to pass (§11) — editing an active template
    // must also produce a valid template, otherwise the PATCH is rejected.
    if ((body.isActive ?? template.isActive) && (contentChanged || body.variables !== undefined)) {
      const errors = validateTemplate({ subject: nextSubject, bodyHtml: nextBody, allowedVariables: nextVars });
      if (errors.length) throw Errors.badRequest(`Template validation failed: ${errors.join(" ")}`);
    }
    if (template.critical && body.isActive === false) {
      throw Errors.badRequest("Security-critical templates (OTP) can never be deactivated.");
    }

    const updated = await db.$transaction(async (tx) => {
      const base: Record<string, unknown> = {};
      if (body.name !== undefined) base.name = body.name;
      if (body.description !== undefined) base.description = body.description;
      if (body.subject !== undefined) base.subject = body.subject;
      if (body.bodyHtml !== undefined) base.bodyHtml = body.bodyHtml;
      if (body.variables !== undefined) base.variables = JSON.stringify(body.variables);
      if (body.isActive !== undefined) base.isActive = body.isActive;
      if (contentChanged) base.version = { increment: 1 };

      const row = await tx.emailTemplate.update({ where: { id: template.id }, data: base });
      // Immutable version snapshot (§42) — every content edit is traceable.
      if (contentChanged) {
        await tx.emailTemplateVersion.create({
          data: { templateId: template.id, version: row.version, subject: row.subject, bodyHtml: row.bodyHtml, editedBy: user.email },
        });
      }
      return row;
    });

    await audit({
      actorId: user.id, actorEmail: user.email,
      action: contentChanged ? "EMAIL_TEMPLATE_UPDATED" : body.isActive === false ? "EMAIL_TEMPLATE_DEACTIVATED" : "EMAIL_TEMPLATE_UPDATED",
      resourceType: "EMAIL_TEMPLATE", resourceId: updated.id,
      metadata: { key: updated.key, version: updated.version, contentChanged, isActive: updated.isActive },
    });
    return ok({ ...updated, variables: nextVars });
  },
  { permission: PERMISSIONS.email_templates }
);

function safeVars(json: string): string[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const DELETE = handler(
  async ({ req, user }) => {
    const template = await templateOf(req);
    const referenced = await db.emailAutomation.count({ where: { templateKey: template.key } });
    if (referenced > 0) {
      // Archive instead of delete — history must remain traceable (§42/§56).
      const archived = await db.emailTemplate.update({ where: { id: template.id }, data: { deletedAt: new Date(), isActive: false } });
      await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_TEMPLATE_ARCHIVED", resourceType: "EMAIL_TEMPLATE", resourceId: template.id, metadata: { key: template.key, referenced } });
      return ok({ id: archived.id, archived: true });
    }
    if (template.isSystem) {
      // Canonical catalog templates stay in the catalog even when unused.
      const archived = await db.emailTemplate.update({ where: { id: template.id }, data: { deletedAt: new Date(), isActive: false } });
      await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_TEMPLATE_ARCHIVED", resourceType: "EMAIL_TEMPLATE", resourceId: template.id, metadata: { key: template.key, system: true } });
      return ok({ id: archived.id, archived: true });
    }
    await db.emailTemplate.delete({ where: { id: template.id } });
    await audit({ actorId: user.id, actorEmail: user.email, action: "EMAIL_TEMPLATE_DELETED", resourceType: "EMAIL_TEMPLATE", resourceId: template.id, metadata: { key: template.key } });
    return ok({ id: template.id, deleted: true });
  },
  { permission: PERMISSIONS.email_templates }
);
