// MOHD.HMS ENTERPRISE — WhatsApp health (§48). Honest values only.
import type { NextResponse } from "next/server";
import { handler, ok } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { whatsappHealth } from "@/lib/hms/whatsapp/service";

export const GET = handler(async (): Promise<NextResponse> => {
  return ok(await whatsappHealth());
}, { permission: PERMISSIONS.whatsapp_view });
