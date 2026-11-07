// MOHD.HMS ENTERPRISE — CMS Page revisions API (§CMS).
// GET /api/v1/cms/pages/[id]/revisions  — list revision history for a page

import { handler, ok, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withParams<{ id: string }>(
  async ({ user, params }) => {
    const { id } = params;
    const page = await db.page.findUnique({ where: { id }, select: { id: true } });
    if (!page) throw Errors.notFound("Page not found.");
    const revisions = await db.pageRevision.findMany({
      where: { pageId: id },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, changeSummary: true, authorId: true,
        published: true, createdAt: true,
      },
    });
    return ok({ pageId: id, revisions });
  },
  { permission: PERMISSIONS.cms_pages_read },
);
