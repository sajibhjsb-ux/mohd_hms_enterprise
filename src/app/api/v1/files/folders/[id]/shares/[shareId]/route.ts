// MOHD.HMS ENTERPRISE — Revoke folder share (§15 — access removed immediately).
import { makeShareRevokeHandler } from "@/lib/hms/files/share-routes";
import { PERMISSIONS } from "@/lib/hms/constants";

export const DELETE = makeShareRevokeHandler("FOLDER", PERMISSIONS.files_share);
