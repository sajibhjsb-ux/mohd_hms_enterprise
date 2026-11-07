// MOHD.HMS ENTERPRISE — CMS Page detail API (§CMS).
// GET    /api/v1/cms/pages/[id]
// PATCH  /api/v1/cms/pages/[id]     — update draft content/metadata
// DELETE /api/v1/cms/pages/[id]     — archive a page (soft, status=ARCHIVED)

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

type Ctx = { params: Promise<{ id: string }> };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.any().optional(),
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(400).optional(),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
});

export const GET = withParams<{ id: string }>(
  async ({ user, params }) => {
    const { id } = params;
    const page = await db.page.findUnique({
      where: { id },
      select: {
        id: true, slug: true, title: true, status: true, content: true,
        seoTitle: true, seoDescription: true, seoImage: true, publishedAt: true,
        createdAt: true, updatedAt: true,
        _count: { select: { revisions: true } },
      },
    });
    if (!page) throw Errors.notFound("Page not found.");
    return ok({ page });
  },
  { permission: PERMISSIONS.cms_pages_read },
);

export const PATCH = withParams<{ id: string }>(
  async ({ req, user, params }) => {
    const { id } = params;
    const page = await db.page.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status === "ARCHIVED") throw Errors.badRequest("Archived pages cannot be edited.");

    const body = await parseBody(req, updateSchema);
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.content !== undefined) data.content = body.content;
    if (body.seoTitle !== undefined) data.seoTitle = body.seoTitle;
    if (body.seoDescription !== undefined) data.seoDescription = body.seoDescription;
    if (body.slug !== undefined) {
      const clash = await db.page.findFirst({
        where: { slug: body.slug, id: { not: id } },
        select: { id: true },
      });
      if (clash) throw Errors.conflict(`A page with slug "${body.slug}" already exists.`);
      data.slug = body.slug;
    }
    data.updatedById = user.id;

    const updated = await db.page.update({ where: { id }, data, select: { id: true, slug: true, title: true, status: true, updatedAt: true } });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_UPDATED",
      resourceType: "CMS_PAGE", resourceId: id, metadata: { slug: updated.slug },
    });
    return ok({ page: updated });
  },
  { permission: PERMISSIONS.cms_pages_update },
);

export const DELETE = withParams<{ id: string }>(
  async ({ user, params }) => {
    const { id } = params;
    const page = await db.page.findUnique({ where: { id }, select: { id: true, status: true, slug: true } });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status === "ARCHIVED") throw Errors.badRequest("Page is already archived.");

    await db.page.update({ where: { id }, data: { status: "ARCHIVED" } });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_ARCHIVED",
      resourceType: "CMS_PAGE", resourceId: id, metadata: { slug: page.slug },
    });
    return ok({ archived: true });
  },
  { permission: PERMISSIONS.cms_pages_delete },
);
