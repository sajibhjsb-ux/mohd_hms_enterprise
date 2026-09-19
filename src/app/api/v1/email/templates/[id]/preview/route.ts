// MOHD.HMS ENTERPRISE — Template preview (§43).
// Renders the template with SAFE sample data. Never sends anything.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { sampleDataFor } from "@/lib/hms/email/service";
import { renderTemplate } from "@/lib/hms/email/render";

export const GET = handler(
  async ({ req }) => {
    const id = new URL(req.url).pathname.split("/").filter(Boolean)[4] ?? "";
    const template = await db.emailTemplate.findUnique({ where: { id } });
    if (!template) throw Errors.notFound("Email template not found.");
    const sample = new URL(req.url).searchParams.get("sample") !== "0";
    const data = sample ? await sampleDataFor(template.key) : {};
    const rendered = await renderTemplate({ subject: template.subject, bodyHtml: template.bodyHtml, data });
    let variables: string[] = [];
    try {
      const parsed = JSON.parse(template.variables || "[]");
      if (Array.isArray(parsed)) variables = parsed.filter((v) => typeof v === "string");
    } catch { /* keep empty */ }
    return ok({
      templateId: template.id,
      key: template.key,
      isPreview: true,
      previewNote: "PREVIEW — rendered with safe sample data; this endpoint never sends email.",
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      warnings: rendered.warnings,
      variables,
    });
  },
  { permission: PERMISSIONS.email_view }
);
