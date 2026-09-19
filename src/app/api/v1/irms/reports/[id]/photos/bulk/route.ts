import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, parseBody, Errors } from "@/lib/hms/api";
import { PERMISSIONS, IRMS_PHOTO_CATEGORIES } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { deleteFiles, regeneratePhotoNo, requirePhotoEditor, type TxClient } from "@/lib/hms/irms/storage";

const bulkSchema = z.object({
  action: z.enum(["delete", "moveCategory", "rotate", "setRoom", "setSwRef"]),
  photoIds: z.array(z.string().min(1)).min(1).max(500),
  value: z.union([z.string(), z.coerce.number()]).optional(),
});

/**
 * 8d. POST /api/v1/irms/reports/[id]/photos/bulk — server-side bulk ops:
 *   delete | moveCategory(value=category) | rotate(value=0|90|180|270)
 *   | setRoom(value) | setSwRef(value)
 */
export const POST = async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return handler(
    async ({ user }) => {
      const { report } = await requirePhotoEditor(id, user);
      const body = await parseBody(req, bulkSchema);

      const rows = await db.inspectionPhoto.findMany({ where: { reportId: id, id: { in: body.photoIds } } });
      if (rows.length !== body.photoIds.length) {
        throw Errors.badRequest("One or more photos do not belong to this report.");
      }
      let count = 0;

      if (body.action === "delete") {
        for (const p of rows) {
          await deleteFiles([p.storagePath, p.displayPath, p.thumbPath]);
        }
        await db.inspectionPhoto.deleteMany({ where: { reportId: id, id: { in: rows.map((r) => r.id) } } });
        count = rows.length;
      } else if (body.action === "moveCategory") {
        const category = String(body.value ?? "");
        if (!(IRMS_PHOTO_CATEGORIES as readonly string[]).includes(category)) {
          throw Errors.badRequest("Unknown photo category.");
        }
        const res = await db.inspectionPhoto.updateMany({ where: { reportId: id, id: { in: rows.map((r) => r.id) } }, data: { category } });
        count = res.count;
      } else if (body.action === "rotate") {
        const rotation = Number(body.value ?? 0);
        if (![0, 90, 180, 270].includes(rotation)) {
          throw Errors.badRequest("Rotation must be one of 0, 90, 180, 270.");
        }
        const res = await db.inspectionPhoto.updateMany({ where: { reportId: id, id: { in: rows.map((r) => r.id) } }, data: { rotation } });
        count = res.count;
      } else {
        const value = String(body.value ?? "").slice(0, 120);
        const data = body.action === "setRoom" ? { room: value } : { swRef: value };
        const res = await db.inspectionPhoto.updateMany({ where: { reportId: id, id: { in: rows.map((r) => r.id) } }, data });
        count = res.count;
      }

      // delete / moveCategory change the numbering scope → regenerate (§Storage).
      if (body.action === "delete" || body.action === "moveCategory") {
        await db.$transaction(async (tx: TxClient) => {
          await regeneratePhotoNo(id, tx);
        });
      }

      await audit({
        actorId: user.id,
        actorEmail: user.email,
        action: "INSPECTION_PHOTOS_BULK",
        resourceType: "INSPECTION_PHOTO",
        resourceId: id,
        metadata: { action: body.action, count, reportCode: report.code },
      });
      await emit({
        type: EVENT_TYPES.IRMS_PHOTOS_UPDATED,
        resourceType: "INSPECTION_REPORT",
        resourceId: id,
        payload: { reportId: id, code: report.code, status: report.status },
        actorType: "USER",
        actorId: user.id,
      });
      return ok({ action: body.action, count });
    },
    { permission: PERMISSIONS.irms_read }
  )(req);
};
