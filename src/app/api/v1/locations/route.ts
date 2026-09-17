import { db } from "@/lib/db";
import { handler, ok } from "@/lib/hms/api";

/** Location list (for equipment/site pickers). */
export const GET = handler(
  async () => {
    const locations = await db.location.findMany({ orderBy: { name: "asc" } });
    return ok(locations);
  },
  { permission: "equipment.read" }
);
