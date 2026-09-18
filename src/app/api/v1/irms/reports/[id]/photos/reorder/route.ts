import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { regeneratePhotoNo, requirePhotoEditor, type TxClient } from "@/lib/hms/irms/storage";

const reorderSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });

/**
 * 8c. POST /api/v1/irms/reports/[id]/photos/reorder — {ids:[...]} is the full
 * desired GLOBAL order; sortOrder=index and photoNo regenerated for all photos.
 */
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      const { report } = await requirePhotoEditor(id, user);
      const body = await parseBody(req, reorderSchema);

      const photos = await db.inspectionPhoto.findMany({ where: { reportId: id }, select: { id: true } });
      const existing = new Set(photos.map((p) => p.id));
      if (
        body.ids.length !== photos.length ||
        new Set(body.ids).size !== body.ids.length ||
        body.ids.some((pid) => !existing.has(pid))
      ) {
        throw Errors.badRequest("Reorder payload must contain every photo of the report exactly once.");
      }

      await db.$transaction(async (tx: TxClient) => {
        for (let i = 0; i < body.ids.length; i++) {
          await tx.inspectionPhoto.update({ where: { id: body.ids[i] }, data: { sortOrder: i } });
        }
        await regeneratePhotoNo(id, tx);
      });

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "INSPECTION_PHOTOS_REORDERED",
        resourceType: "INSPECTION_PHOTO",
        resourceId: id,
        metadata: { reportCode: report.code, count: body.ids.length },
      });
      await emit({
        type: EVENT_TYPES.IRMS_PHOTOS_UPDATED,
        resourceType: "INSPECTION_REPORT",
        resourceId: id,
        payload: { reportId: id, code: report.code, status: report.status },
        actorType: "USER",
        actorId: user.id,
      });
      return ok({ reordered: body.ids.length });
    },
    { permission: PERMISSIONS.irms_read }
  )(req);
};
