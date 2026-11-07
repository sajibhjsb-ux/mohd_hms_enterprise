// MOHD.HMS ENTERPRISE — CMS preview API (§CMS).
// GET /api/v1/cms/preview/[id]
// Returns a page's current content (draft or published) for authenticated CMS
// users. Unpublished drafts require SUPER_ADMIN/ADMIN; published pages are
// viewable by any CMS reader. Never exposes drafts to the public.

import { handler, ok, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/hms/auth";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<{ id: string }>(
  async ({ user, params }) => {
    const { id } = params;
    const sessionUser = await getSessionUser();
    if (!sessionUser) throw Errors.unauthorized();

    const page = await db.page.findUnique({
      where: { id },
      select: {
        id: true, title: true, status: true, content: true, slug: true,
        seoTitle: true, seoDescription: true, publishedAt: true, updatedAt: true,
      },
    });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status !== "PUBLISHED" && !["SUPER_ADMIN", "ADMIN"].includes(user.role)) {
      throw Errors.forbidden("You cannot preview this draft.");
    }
    return ok({ page, canEdit: ["SUPER_ADMIN", "ADMIN"].includes(user.role) });
  },
  { permission: PERMISSIONS.cms_pages_read },
);
