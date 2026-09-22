// MOHD.HMS ENTERPRISE — Email provider abstraction (§5 EMAIL PROVIDER
// CONFIGURATION). ONE provider interface. The SMTP provider is used with the
// corporate Mailflare endpoint (host/port/security come from the admin-managed
// EmailConfig — never hardcoded); the Resend provider sends through the Resend
// HTTP API using the same encrypted provider secret. Providers plug in behind
// the same interface; modules never create their own clients.

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

// ─── Resend provider (HTTP API — mohdhms.com is DKIM/SPF verified) ──────────

const RESEND_API = "https://api.resend.com/emails";
const RESEND_DOMAINS_API = "https://api.resend.com/domains";

type ResendErrorBody = { statusCode?: number; name?: string; message?: string };

function classifyResendError(status: number | undefined, body?: ResendErrorBody): { errorClass: EmailErrorClass; permanent: boolean } {
  if (status === 401 || status === 403 || !status) {
    return { errorClass: "AUTHENTICATION", permanent: true };
  }
  if (status === 429) return { errorClass: "RATE_LIMIT", permanent: false };
  if (status === 422 || status === 400) {
    const msg = String(body?.message ?? "").toLowerCase();
    // Only recipient-scoped failures are terminal for this message; anything
    // else (template, invalid from, payload) will not improve on retry but is
    // classified as a controlled PERMANENT so the log surfaces it honestly.
    if (/recipient|address.*(fail|invalid|reject)|unsubscribed|bounce/.test(msg)) {
      return { errorClass: "RECIPIENT", permanent: true };
    }
    return { errorClass: "PERMANENT", permanent: true };
  }
  if (status >= 500) return { errorClass: "TEMPORARY", permanent: false };
  return { errorClass: "TEMPORARY", permanent: false };
}

function parseResendError(text: string): ResendErrorBody | undefined {
  try {
    return JSON.parse(text) as ResendErrorBody;
  } catch {
    return undefined;
  }
}

async function resendFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const resendProvider: EmailProvider = {
  name: "RESEND",

  async send(message: OutgoingEmail): Promise<SendResult> {
    const apiKey = await getSmtpSecret();
    if (!apiKey) {
      return { ok: false, messageId: "", response: "", errorClass: "CONFIG", error: "Resend API key is not configured." };
    }
    const from = message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail;

    // Regular attachments go in `attachments`; CID images (the branded logo)
    // go in `images` and are referenced by filename, so rewrite cid: refs.
    const attachments = (message.attachments ?? [])
      .filter((a) => !a.cid)
      .map((a) => ({
        filename: a.filename,
        content: a.content.toString("base64"),
        content_type: a.contentType || "application/octet-stream",
      }));
    let html = message.html;
    const images: { filename: string; content: string; content_type: string }[] = [];
    for (const a of message.attachments ?? []) {
      if (!a.cid) continue;
      images.push({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType || "application/octet-stream" });
      if (html.includes(`cid:${a.cid}`)) html = html.split(`cid:${a.cid}`).join(a.filename);
    }

    const body: Record<string, unknown> = { from, to: message.to };
    if (message.cc?.length) body.cc = message.cc;
    if (message.bcc?.length) body.bcc = message.bcc;
    if (message.replyTo) body.reply_to = message.replyTo;
    body.subject = message.subject;
    body.html = html;
    body.text = message.text;
    if (attachments.length) body.attachments = attachments;
    if (images.length) body.images = images;

    try {
      const res = await resendFetch(
        RESEND_API,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        message.timeoutMs,
      );
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const bodyErr = parseResendError(text);
        const { errorClass } = classifyResendError(res.status, bodyErr);
        return {
          ok: false, messageId: "", response: text.slice(0, 500) || `HTTP ${res.status}`,
          errorClass, error: sanitizeProviderError(bodyErr?.message ?? `Resend API rejected the message (${res.status})`),
        };
      }
      let id = "";
      try {
        const json = JSON.parse(text) as { id?: unknown };
        id = typeof json?.id === "string" ? json.id : "";
      } catch { /* non-JSON body — still accepted */ }
      return { ok: true, messageId: `<${id || Date.now()}@resend>`, response: id ? `accepted ${id}` : "accepted" };
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError";
      const e = err as { message?: string };
      return {
        ok: false, messageId: "", response: "",
        errorClass: aborted ? "TEMPORARY" : "NETWORK",
        error: sanitizeProviderError(aborted ? "Resend request timed out" : (e?.message ?? "Resend request failed")),
      };
    }
  },

  async verify(): Promise<{ ok: boolean; detail: string; errorClass?: EmailErrorClass }> {
    const apiKey = await getSmtpSecret();
    if (!apiKey) return { ok: false, detail: "Resend API key is not set.", errorClass: "CONFIG" };
    try {
      const res = await resendFetch(RESEND_DOMAINS_API, { headers: { Authorization: `Bearer ${apiKey}` } }, 15_000);
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        const bodyErr = parseResendError(text);
        const { errorClass } = classifyResendError(res.status, bodyErr);
        const hint = bodyErr?.message ?? `Resend rejected the API key (${res.status})`;
        return { ok: false, detail: sanitizeProviderError(hint), errorClass };
      }
      let domains: { name?: string; status?: string; capabilities?: { sending?: string } }[] = [];
      try {
        const json = JSON.parse(text) as { data?: typeof domains };
        domains = json?.data ?? [];
      } catch { /* ignore */ }
      const cfg = await getEmailConfig();
      const fromDomain = cfg.fromEmail.split("@").pop()?.toLowerCase() ?? "";
      const match = domains.find((d) => d.name?.toLowerCase() === fromDomain);
      if (!fromDomain) return { ok: false, detail: "Resend API key valid — set a From email (a verified Resend domain) first.", errorClass: "CONFIG" };
      if (match) {
        if (match.status === "verified" && match.capabilities?.sending === "enabled") {
          return { ok: true, detail: `Resend API key valid — ${fromDomain} is verified for sending.` };
        }
        return { ok: false, detail: `Resend API key valid but ${fromDomain} is not ready (status: ${match.status ?? "unknown"}, sending: ${match.capabilities?.sending ?? "unknown"}).`, errorClass: "CONFIG" };
      }
      return { ok: false, detail: `Resend API key valid but ${fromDomain} is not verified in Resend.`, errorClass: "CONFIG" };
    } catch (err) {
      const aborted = (err as { name?: string }).name === "AbortError";
      const e = err as { message?: string };
      return { ok: false, detail: sanitizeProviderError(aborted ? "Resend request timed out" : (e?.message ?? "Resend request failed")), errorClass: "NETWORK" };
    }
  },
};

export async function getProvider(): Promise<EmailProvider> {
  const cfg = await getEmailConfig();
  return cfg.provider === "RESEND" ? resendProvider : smtpProvider;
}

export { resetTransportCache };
