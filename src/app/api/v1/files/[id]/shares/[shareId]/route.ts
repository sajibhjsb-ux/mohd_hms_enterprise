// MOHD.HMS ENTERPRISE — Revoke file share (§13 — immediate).
import { makeShareRevokeHandler } from "@/lib/hms/files/share-routes";
import { PERMISSIONS } from "@/lib/hms/constants";

export const DELETE = makeShareRevokeHandler("FILE", PERMISSIONS.files_share);
