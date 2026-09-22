// MOHD.HMS ENTERPRISE — Inventory item documents (Inventory spec §23/§54).
// Reuses the existing Files/MinIO architecture — no second storage system.
// GET  /api/v1/inventory/[id]/documents — metadata list.
// POST /api/v1/inventory/[id]/documents — multipart upload (field: file, label?).
//   Stored under inventory/{itemId}/docs/ in MinIO; Document rows carry
//   resourceType=INVENTORY_ITEM. Datasheets / manuals / certificates / photos.
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import type { SessionUser } from "@/lib/hms/auth";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import { audit } from "@/lib/hms/services";
import { storage } from "@/lib/hms/storage";

function withId(
  permission: Permission,
  fn: (id: string, ctx: { req: NextRequest; user: SessionUser }) => Promise<NextResponse>
) {
  return async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    return handler((c) => fn(id, c), { permission })(req);
  };
}

const DOC_MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function sniffMime(buf: Buffer, declared: string): string | null {
  if (buf.length > 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (ALLOWED_MIMES.has(declared)) return declared;
  return null;
}

export const GET = withId(PERMISSIONS.inventory_read, async (id) => {
  const item = await db.inventoryItem.findUnique({ where: { id }, select: { id: true } });
  if (!item) throw Errors.notFound("Inventory item not found.");
  const docs = await db.document.findMany({
    where: { resourceType: "INVENTORY_ITEM", resourceId: id },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, mimeType: true, sizeBytes: true, label: true, createdAt: true },
  });
  return ok(docs);
});

export const POST = withId(PERMISSIONS.inventory_manage, async (id, { req, user }) => {
  const item = await db.inventoryItem.findUnique({ where: { id }, select: { id: true, sku: true } });
  if (!item) throw Errors.notFound("Inventory item not found.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw Errors.badRequest("Expected a multipart form upload.");
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size <= 0) throw Errors.badRequest("No file was uploaded (field name: file).");
  const labelRaw = form.get("label");
  const label = typeof labelRaw === "string" ? labelRaw.trim().slice(0, 80) : "";

  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > DOC_MAX_BYTES) throw Errors.badRequest("File is too large. Maximum allowed size is 20 MB.");
  const mime = sniffMime(buf, file.type || "");
  if (!mime) throw Errors.badRequest("Unsupported file type. Upload a PDF, image or Office document.");

  const ext = mime.split("/")[1]?.replace("svg+xml", "svg") ?? "bin";
  const key = `inventory/${item.id}/docs/${randomUUID()}.${ext}`;
  await storage.put(key, buf, mime);

  const base = (file.name.split(/[/\\]/).pop() ?? "document").replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200) || "document";
  const doc = await db.document.create({
    data: {
      name: base,
      safeName: base,
      mimeType: mime,
      sizeBytes: buf.length,
      storagePath: key,
      category: "INVENTORY_ITEM",
      resourceType: "INVENTORY_ITEM",
      resourceId: item.id,
      label: label || "DOCUMENT",
      uploadedById: user.id,
    },
  });

  await audit({
    actorId: user.id,
    actorEmail: user.email,
    action: "ITEM_DOCUMENT_UPLOADED",
    resourceType: "INVENTORY_ITEM",
    resourceId: item.id,
    metadata: { documentId: doc.id, name: base, label: label || "DOCUMENT", sizeBytes: buf.length },
  });

  return ok(doc, 201);
});
