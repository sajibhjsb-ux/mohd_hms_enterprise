// MOHD.HMS ENTERPRISE — CMS Page unpublish API (§CMS).
// POST /api/v1/cms/pages/[id]/unpublish
// Sets status=DRAFT so the page is removed from the public website.

import { handler, ok, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withParams<{ id: string }>(
  async ({ user, params }) => {
    const { id } = params;
    const page = await db.page.findUnique({ where: { id }, select: { id: true, status: true, slug: true } });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status === "DRAFT") throw Errors.badRequest("Page is already a draft.");

    await db.page.update({ where: { id }, data: { status: "DRAFT", publishedAt: null, updatedById: user.id } });
    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_UNPUBLISHED",
      resourceType: "CMS_PAGE", resourceId: id, metadata: { slug: page.slug },
    });
    return ok({ status: "DRAFT" });
  },
  { permission: PERMISSIONS.cms_pages_publish },
);
