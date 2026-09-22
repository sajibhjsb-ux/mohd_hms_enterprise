// MOHD.HMS ENTERPRISE — Email provider abstraction (§5 EMAIL PROVIDER
// CONFIGURATION). ONE provider interface; the current implementation is the
// SMTP provider used with the corporate Mailflare endpoint (host/port/security
// come from the admin-managed EmailConfig — never hardcoded). Future providers
// plug in behind the same interface; modules never create their own clients.

import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getEmailConfig, getSmtpSecret } from "./config";
import type { EmailErrorClass } from "./types";

export type OutgoingEmail = {
  to: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
  timeoutMs: number;
};

export type SendResult = {
  ok: boolean;
  /** SMTP message id when the server accepted the message (§54 — accepted ≠ delivered). */
  messageId: string;
  /** Raw provider response line(s) — kept as the acceptance evidence. */
  response: string;
  errorClass?: EmailErrorClass;
  error?: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendResult>;
  /** REAL connection verification — never a frontend-only success (§27). */
  verify(): Promise<{ ok: boolean; detail: string; errorClass?: EmailErrorClass }>;
}

// ─── Error classification (§36 — permanent failures are never retried) ─────

export function classifySmtpError(err: unknown): { errorClass: EmailErrorClass; permanent: boolean } {
  const e = err as { code?: string; responseCode?: number; response?: string; command?: string } | null;
  const code = String(e?.code ?? "");
  const responseCode = Number(e?.responseCode ?? 0);
  const response = String(e?.response ?? "");

  if (responseCode === 421 || /^4\d\d$/.test(String(responseCode)) || code === "ETIMEDOUT" || code === "ESOCKET") {
    return { errorClass: "TEMPORARY", permanent: false };
  }
  if (/^5\d\d$/.test(String(responseCode))) {
    const authish = /auth|credential|535|530|534/i.test(`${response} ${code}`);
    if (authish) return { errorClass: "AUTHENTICATION", permanent: true };
    const recip = /550|551|553|recipient|address rejected|no such user|user unknown/i.test(response);
    if (recip) return { errorClass: "RECIPIENT", permanent: true };
    return { errorClass: "PERMANENT", permanent: true };
  }
  if (code === "EAUTH" || code === "EMESSAGE" || e?.command === "AUTH") return { errorClass: "AUTHENTICATION", permanent: true };
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ECONNRESET" || code === "DNSLOOKUP" || code === "ECONNTIMEOUT") {
    return { errorClass: "NETWORK", permanent: false };
  }
  if (code === "ETIMEDOUT") return { errorClass: "TEMPORARY", permanent: false };
  return { errorClass: "PROVIDER", permanent: false };
}

// ─── SMTP provider (Mailflare endpoint in production; dev SMTP sink in QA) ──

// Transport cache lives on globalThis — route handlers and the scheduler worker
// are separate module instances in Next dev; a route-side resetTransportCache()
// must reach the worker's cached transport too.
const PROVIDER_G = globalThis as unknown as { __hmsEmailTransportCache?: { key: string; transport: Transporter } | null };

function transportKey(cfg: { smtpHost: string; smtpPort: number; smtpSecurity: string; smtpUser: string; hasSecret: boolean; timeoutMs: number }): string {
  return [cfg.smtpHost, cfg.smtpPort, cfg.smtpSecurity, cfg.smtpUser, cfg.hasSecret ? "pw" : "nopw", cfg.timeoutMs].join("|");
}

async function getTransport(): Promise<Transporter> {
  const cfg = await getEmailConfig();
  const secret = await getSmtpSecret();
  const key = transportKey({
    smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort, smtpSecurity: cfg.smtpSecurity,
    smtpUser: cfg.smtpUser, hasSecret: Boolean(secret), timeoutMs: cfg.timeoutMs,
  });
  if (PROVIDER_G.__hmsEmailTransportCache?.key === key) return PROVIDER_G.__hmsEmailTransportCache.transport;

  const secure = cfg.smtpSecurity === "SSL"; // implicit TLS (usually port 465)
  const requireTLS = cfg.smtpSecurity === "STARTTLS"; // opportunistic→required upgrade (usually 587)
  const transport = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure,
    requireTLS: secure ? false : requireTLS,
    ignoreTLS: cfg.smtpSecurity === "NONE",
    auth: secret ? { user: cfg.smtpUser || cfg.fromEmail, pass: secret } : undefined,
    connectionTimeout: cfg.timeoutMs,
    greetingTimeout: cfg.timeoutMs,
    socketTimeout: cfg.timeoutMs * 2,
    tls: { rejectUnauthorized: false }, // corporate relays with private CAs
  });
  PROVIDER_G.__hmsEmailTransportCache = { key, transport };
  return transport;
}

function resetTransportCache(): void {
  PROVIDER_G.__hmsEmailTransportCache = null;
}

export const smtpProvider: EmailProvider = {
  name: "SMTP",

  async send(message: OutgoingEmail): Promise<SendResult> {
    try {
      const transport = await getTransport();
      const info = await transport.sendMail({
        from: message.fromEmail ? { name: message.fromName || undefined, address: message.fromEmail } : message.fromEmail,
        to: message.to,
        cc: message.cc?.length ? message.cc : undefined,
        bcc: message.bcc?.length ? message.bcc : undefined,
        replyTo: message.replyTo || undefined,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          ...(a.cid ? { cid: a.cid, encoding: "binary" as const, headers: { "Content-ID": `<${a.cid}>` } } : {}),
        })),
      });
      // The SMTP conversation's accepted response IS the acceptance evidence (§54).
      return { ok: true, messageId: info.messageId ?? "", response: info.response || "accepted" };
    } catch (err) {
      const { errorClass } = classifySmtpError(err);
      const e = err as { response?: string; message?: string };
      // NEVER include credentials in errors (§27/§38) — response lines only.
      return { ok: false, messageId: "", response: e?.response ?? "", errorClass, error: sanitizeProviderError(e?.message ?? "SMTP send failed") };
    }
  },

  async verify(): Promise<{ ok: boolean; detail: string; errorClass?: EmailErrorClass }> {
    try {
      const transport = await getTransport();
      await transport.verify();
      return { ok: true, detail: "SMTP connection successful" };
    } catch (err) {
      const { errorClass } = classifySmtpError(err);
      const e = err as { message?: string; response?: string };
      return { ok: false, detail: `Unable to connect to SMTP server. ${sanitizeProviderError(e?.response || e?.message || "Connection failed")}`, errorClass };
    }
  },
};

/** Strip anything credential-like from provider error strings. */
export function sanitizeProviderError(message: string): string {
  return message
    .replace(/(password|pass|secret|token)\s*[:=]\s*\S+/gi, "$1: ***")
    .replace(/\b535\b.*$/, "authentication failed (535)")
    .slice(0, 300);
}

export { resetTransportCache };
