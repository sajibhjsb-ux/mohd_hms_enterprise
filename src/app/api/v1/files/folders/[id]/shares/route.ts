// MOHD.HMS ENTERPRISE — Folder shares (§13/§15 — inherited grants).
import { makeShareHandlers } from "@/lib/hms/files/share-routes";
import { PERMISSIONS } from "@/lib/hms/constants";

const { listShares, createShare } = makeShareHandlers("FOLDER", PERMISSIONS.files_share);
export { listShares as GET, createShare as POST };
