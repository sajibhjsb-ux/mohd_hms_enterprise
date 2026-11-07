// MOHD.HMS ENTERPRISE — Inbound email webhook (§29/§31).
//
// Receives inbound messages from Mailflare via signed webhook, stores them as
// MailMessage rows (direction=IN) in the recipient's mailbox INBOX.
//
// Webhook contract (matches Mailflare dispatchWebhooks):
//   POST /api/v1/email/inbound/webhook
//   X-Email-Platform-Signature: hex HMAC-SHA256(webhookSecret, rawBody)
//   Body: { type: "message.inbound", data: { id, messageId, to, from, subject, textBody, htmlBody, snippet, headers } }
//
// Idempotency: the unique messageId guard prevents duplicate processing on
// webhook retries. A second delivery of the same message is a no-op.

import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { handler, ok, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";

const WEBHOOK_SECRET_KEY = "email_inbound_webhook_secret";

async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const row = await db.setting.findUnique({ where: { key: WEBHOOK_SECRET_KEY }, select: { value: true } });
  const secret = row?.value;
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim(), email: match[2].trim() };
  return { name: "", email: from.trim() };
}

export const POST = handler(
  async ({ req }) => {
    const rawBody = await req.text();
    const signature = req.headers.get("x-email-platform-signature");

    if (!(await verifySignature(rawBody, signature))) {
      throw Errors.forbidden("Invalid or missing webhook signature.");
    }

    let payload: { type: string; data: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw Errors.badRequest("Invalid JSON body.");
    }

    if (payload.type !== "message.inbound") {
      return ok({ received: true, skipped: `not an inbound event (${payload.type})` });
    }

    const d = payload.data as Record<string, unknown>;
    const messageId = String(d.messageId ?? d.id ?? "");
    const to = String(d.to ?? "");
    const fromAddr = String(d.from ?? "");
    const subject = String(d.subject ?? "");
    const textBody = String(d.textBody ?? "");
    const htmlBody = String(d.htmlBody ?? "");
    const headers = (d.headers as Record<string, string> | undefined) ?? {};

    if (!messageId || !to || !fromAddr) {
      throw Errors.badRequest("Inbound message missing messageId/to/from.");
    }

    // Idempotency: same messageId already processed → no-op.
    const existing = await db.mailMessage.findFirst({
      where: { messageId },
      select: { id: true },
    });
    if (existing) {
      return ok({ received: true, skipped: "duplicate messageId", id: existing.id });
    }

    // Only deliver to configured, active mailboxes — never auto-create.
    const mailbox = await db.mailbox.findFirst({
      where: { email: to, isActive: true },
      select: { id: true, email: true },
    });
    if (!mailbox) {
      throw Errors.badRequest(`No active mailbox for recipient: ${to}`);
    }

    const toHeader = headers.to || headers.To || to;
    const toEmails = String(toHeader).split(",").map((a) => a.trim()).filter(Boolean);

    const { name: fromName, email: fromEmail } = parseFrom(fromAddr);

    const bodyHtml = htmlBody || textBody;
    const bodyText = textBody || htmlBody;

    const created = await db.mailMessage.create({
      data: {
        mailboxId: mailbox.id,
        folder: "INBOX",
        status: "RECEIVED",
        direction: "IN",
        threadId: "",
        subject,
        fromName,
        fromEmail,
        toEmail: toEmails.join(", "),
        ccEmail: "",
        bodyHtml,
        bodyText,
        messageId,
      },
    });

    return ok({ received: true, id: created.id, mailbox: mailbox.email });
  },
  { auth: false } // system-to-system webhook; authenticated via HMAC signature
);
