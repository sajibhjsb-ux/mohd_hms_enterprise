// MOHD.HMS ENTERPRISE — File shares (§13).
import { makeShareHandlers } from "@/lib/hms/files/share-routes";
import { PERMISSIONS } from "@/lib/hms/constants";

const { listShares, createShare } = makeShareHandlers("FILE", PERMISSIONS.files_share);
export { listShares as GET, createShare as POST };
