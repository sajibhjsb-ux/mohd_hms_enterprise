import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, Errors, ApiError } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import { PERMISSIONS, IRMS_SIGNATURE_ROLES } from "@/lib/hms/constants";
import { roleCan } from "@/lib/hms/rbac";
import { audit } from "@/lib/hms/services";
import { emit } from "@/lib/hms/workflows/bus";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { saveSignature, UploadValidationError } from "@/lib/hms/irms/storage";

function withId(fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c))(req);
  };
}

const itemDto = (s: { id: string; role: string; name: string; signedAt: Date; revision: number }) => ({
  id: s.id,
  role: s.role,
  name: s.name,
  signedAt: s.signedAt,
  revision: s.revision,
  url: `/api/v1/irms/signatures/${s.id}/file`,
});

/** 9a. GET /api/v1/irms/reports/[id]/signatures (STAFF_READ | portal-authorized). */
export const GET = withId(
  async (id, { user }) => {
    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: { project: { select: { customerId: true } } },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    const staffAllowed = roleCan(user.role, PERMISSIONS.irms_read);
    const portalAllowed =
      !staffAllowed &&
      roleCan(user.role, PERMISSIONS.irms_portal) &&
      !!user.customerId &&
      user.customerId === report.project.customerId &&
      report.customerVisible &&
      (report.status === "APPROVED" || report.status === "ARCHIVED");
    if (!staffAllowed && !portalAllowed) throw Errors.notFound("Inspection report not found.");

    const signatures = await db.inspectionSignature.findMany({
      where: { reportId: id },
      orderBy: { signedAt: "desc" as const },
    });
    return okList(signatures.map(itemDto));
  }
);

// ── 9b. POST — multipart {role, name, image (PNG blob | dataURL)} ───────────

const postSchema = z.object({
  role: z.enum(IRMS_SIGNATURE_ROLES),
  name: z.string().min(1, "Signatory name is required.").max(160),
});

export const POST = withId(
  async (id, { req, user }) => {
    const report = await db.inspectionReport.findUnique({
      where: { id },
      include: {
        project: { select: { customerId: true, name: true } },
        inspector: { select: { userId: true } },
      },
    });
    if (!report) throw Errors.notFound("Inspection report not found.");

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw Errors.badRequest("Expected a multipart form upload.");
    }
    const parsed = postSchema.safeParse({
      role: form.get("role") ?? undefined,
      name: form.get("name") ?? undefined,
    });
    if (!parsed.success) throw Errors.badRequest("Signature requires a role (INSPECTOR/SUPERVISOR/MANAGER/CLIENT) and a name.");
    const { role, name } = parsed.data;
    const imageEntry = form.get("image");
    let image: Blob | string | null = null;
    if (typeof imageEntry === "string") image = imageEntry;
    else if (imageEntry instanceof Blob) image = imageEntry;
    if (!image) {
      throw Errors.badRequest("Signature image is required (PNG blob or dataURL, field name: image).");
    }

    // Role authorization (contract §9):
    //   INSPECTOR → owner | MANAGE; SUPERVISOR|MANAGER → MANAGE;
    //   CLIENT → PORTAL user of owning customer (CLIENT_REVIEW/APPROVED) | MANAGE.
    const canManage = roleCan(user.role, PERMISSIONS.irms_manage);
    const isOwner = !!report.inspector && report.inspector.userId === user.id;
    const isPortalCustomer =
      roleCan(user.role, PERMISSIONS.irms_portal) && !!user.customerId && user.customerId === report.project.customerId;
    if (role === "INSPECTOR" && !canManage && !isOwner) throw Errors.forbidden("Only the inspector or a supervisor can sign as inspector.");
    if ((role === "SUPERVISOR" || role === "MANAGER") && !canManage) throw Errors.forbidden("Only supervisors/admins can sign this role.");
    if (role === "CLIENT" && !canManage) {
      const portalClient =
        isPortalCustomer && report.customerVisible && (report.status === "CLIENT_REVIEW" || report.status === "APPROVED");
      if (!portalClient) throw Errors.forbidden("Only the owning customer (during client review) or a supervisor can sign as client.");
    }

    const saved = await saveSignature(image, id, crypto.randomUUID()).catch((err) => {
      if (err instanceof UploadValidationError) throw new ApiError(422, err.code, err.message);
      throw err;
    });

    // Keep history — a new row is always created, never overwritten (§9).
    const signature = await db.inspectionSignature.create({
      data: {
        reportId: id,
        role,
        name,
        signedById: user.id,
        storagePath: saved.storagePath,
        revision: report.revision,
      },
    });

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "INSPECTION_SIGNED",
      resourceType: "INSPECTION_SIGNATURE",
      resourceId: signature.id,
      metadata: { reportCode: report.code, role, name, revision: report.revision },
    });
    await emit({
      type: EVENT_TYPES.IRMS_REPORT_UPDATED,
      resourceType: "INSPECTION_REPORT",
      resourceId: id,
      payload: { reportId: id, code: report.code, status: report.status },
      actorType: "USER",
      actorId: user.id,
    });
    return NextResponse.json({ ok: true, data: itemDto(signature) }, { status: 201 });
  }
);
