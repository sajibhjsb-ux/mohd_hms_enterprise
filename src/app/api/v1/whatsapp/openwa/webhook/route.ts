// MOHD.HMS ENTERPRISE — OpenWA inbound webhook (§17/§18/§19/§20).
// PUBLIC endpoint (no session auth) authenticated by the X-OpenWA-Signature
// HMAC-SHA256 over the EXACT raw body bytes — fail-closed: without a
// configured webhook secret every request is rejected. Envelope:
//   body: { event, timestamp, sessionId, idempotencyKey, deliveryId, data }
//   headers: X-OpenWA-Event / X-OpenWA-Idempotency-Key / X-OpenWA-Delivery-Id /
//            X-OpenWA-Retry-Count / X-OpenWA-Signature: sha256=<hex>
// Idempotent by the unique idempotencyKey — at-least-once deliveries never
// double-process (no duplicate complaints, no duplicate auto-replies).

import { NextResponse } from "next/server";
import { ingestWebhookDelivery, verifyWebhookSignature } from "@/lib/hms/whatsapp/inbound";
import { getWebhookSecret } from "@/lib/hms/whatsapp/config";

const MAX_BODY_BYTES = 1_000_000; // mirrors the gateway's own payload cap

export async function POST(req: Request): Promise<NextResponse> {
  const secret = await getWebhookSecret();
  const signature = req.headers.get("x-openwa-signature");
  const raw = Buffer.from(await req.arrayBuffer());

  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid payload size" } }, { status: 400 });
  }
  if (!verifyWebhookSignature(raw, signature, secret)) {
    // 401 — same as OpenWA's own ingress contract for bad signatures.
    return NextResponse.json({ ok: false, error: { code: "UNAUTHORIZED", message: "Webhook signature verification failed" } }, { status: 401 });
  }

  let delivery: { event?: string; idempotencyKey?: string; deliveryId?: string; sessionId?: string; data?: Record<string, unknown> };
  try {
    delivery = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Malformed JSON" } }, { status: 400 });
  }
  if (!delivery.event) {
    return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Missing event" } }, { status: 400 });
  }

  try {
    const result = await ingestWebhookDelivery(
      { event: delivery.event, idempotencyKey: delivery.idempotencyKey || req.headers.get("x-openwa-idempotency-key") || "", deliveryId: delivery.deliveryId || req.headers.get("x-openwa-delivery-id") || "", sessionId: delivery.sessionId, data: delivery.data },
      raw.toString("utf8"),
    );
    if (!result.idempotencyKey) {
      return NextResponse.json({ ok: false, error: { code: "BAD_REQUEST", message: "Missing idempotency key" } }, { status: 400 });
    }
    // Always 200 for verified deliveries (even duplicates) so the gateway
    // does not retry already-processed events.
    return NextResponse.json({ ok: true, data: { processed: result.processed, duplicate: result.duplicate } });
  } catch (e) {
    // Never leak internals; the gateway will retry (at-least-once) and our
    // idempotency anchor keeps the redrive safe.
    console.error("whatsapp-webhook-processing-failed", e instanceof Error ? e.message : String(e));
    return NextResponse.json({ ok: false, error: { code: "INTERNAL", message: "Processing failed; event retained for redrive" } }, { status: 500 });
  }
}
