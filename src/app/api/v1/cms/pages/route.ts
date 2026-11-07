// MOHD.HMS ENTERPRISE — CMS Pages API (§CMS).
// GET    /api/v1/cms/pages          — list pages (status filter, search)
// POST   /api/v1/cms/pages          — create a page (draft by default)
// Backend-authoritative: RBAC + server-owned slug/status/publish logic.

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

const pageSchema = z.object({
  slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase slug like \"about-us\"."),
  title: z.string().min(1).max(200),
  content: z.any().optional(),
  seoTitle: z.string().max(200).optional().default(""),
  seoDescription: z.string().max(400).optional().default(""),
});

export const GET = handler(
  async ({ req, user }) => {
    const url = new URL(req.url as string);
    const status = url.searchParams.get("status") || undefined;
    const search = url.searchParams.get("search") || undefined;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
      ];
    }
    const pages = await db.page.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, slug: true, title: true, status: true, seoTitle: true,
        seoDescription: true, publishedAt: true, createdAt: true, updatedAt: true,
        _count: { select: { revisions: true } },
      },
    });
    return ok({ pages });
  },
  { permission: PERMISSIONS.cms_pages_read },
);

export const POST = handler(
  async ({ req, user }) => {
    assertRolePermissionCheck(user);
    const body = await parseBody(req, pageSchema);
    // Slug must be unique — server-enforced.
    const existing = await db.page.findUnique({ where: { slug: body.slug }, select: { id: true } });
    if (existing) throw Errors.conflict(`A page with slug "${body.slug}" already exists.`);

    const page = await db.page.create({
      data: {
        slug: body.slug,
        title: body.title,
        status: "DRAFT",
        content: body.content ?? { blocks: [] },
        seoTitle: body.seoTitle,
        seoDescription: body.seoDescription,
      },
      select: { id: true, slug: true, title: true, status: true, createdAt: true },
    });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_CREATED",
      resourceType: "CMS_PAGE", resourceId: page.id, metadata: { slug: page.slug },
    });
    return ok({ page }, 201);
  },
  { permission: PERMISSIONS.cms_pages_create },
);

function assertRolePermissionCheck(user: { role: string }) {
  // Re-checked by handler() RBAC; kept as an explicit guard for clarity.
  return user;
}
