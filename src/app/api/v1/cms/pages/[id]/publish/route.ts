// MOHD.HMS ENTERPRISE — CMS Page publish API (§CMS).
// POST /api/v1/cms/pages/[id]/publish
// Validates the page, snapshots an immutable revision, sets status=PUBLISHED.

import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { withParams } from "@/lib/hms/files/service";
import { PERMISSIONS } from "@/lib/hms/constants";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/hms/services";

type Ctx = { params: Promise<{ id: string }> };

const publishSchema = z.object({
  changeSummary: z.string().max(500).optional().default("Published."),
});

export const POST = withParams<{ id: string }>(
  async ({ req, user, params }) => {
    const { id } = params;
    const body = await parseBody(req, publishSchema);
    const { changeSummary } = body;
    const page = await db.page.findUnique({ where: { id } });
    if (!page) throw Errors.notFound("Page not found.");
    if (page.status === "ARCHIVED") throw Errors.badRequest("Archived pages cannot be published.");
    if (!page.content || Object.keys(page.content).length === 0) {
      throw Errors.badRequest("A page must have content before it can be published.");
    }

    // Next version number for this page.
    const last = await db.pageRevision.findFirst({
      where: { pageId: id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (last?.version ?? 0) + 1;

    const result = await db.$transaction(async (tx) => {
      const revision = await tx.pageRevision.create({
        data: {
          pageId: id,
          version: nextVersion,
          content: page.content,
          changeSummary,
          authorId: user.id,
          published: true,
        },
      });
      const updated = await tx.page.update({
        where: { id },
        data: { status: "PUBLISHED", publishedAt: new Date(), updatedById: user.id },
      });
      return { revision, updated };
    });

    void audit({
      actorId: user.id, actorEmail: user.email, action: "CMS_PAGE_PUBLISHED",
      resourceType: "CMS_PAGE", resourceId: id,
      metadata: { slug: page.slug, version: result.revision.version },
    });
    return ok({ page: result.updated, revision: result.revision });
  },
  { permission: PERMISSIONS.cms_pages_publish },
);
