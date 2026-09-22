// MOHD.HMS ENTERPRISE — Email configuration service (§3/§4).
// Singleton EmailConfig row (the DB is the authoritative store; production points
// at the corporate Mailflare SMTP endpoint via this configuration — hostnames are
// NEVER hardcoded, they are inspected/configured by authorized administrators).
//
// Security contract:
//   • The SMTP password is AES-256-GCM encrypted at rest (crypto.ts).
//   • GET APIs return EmailConfigSafe — a boolean hasPassword, never the secret.
//   • A non-empty smtpPassword in PATCH replaces the stored secret; omitting it
//     keeps the existing one; an explicit null clears it.
//   • Nothing secret is ever logged or audited (maskSecretHint only).

import "server-only";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import type { EmailConfigSafe } from "./types";

const CONFIG_ID = "singleton";
const CACHE_TTL_MS = 15_000;
// Cache lives on globalThis: Next dev compiles route handlers and the scheduler
// (instrumentation) as separate module instances — a module-local cache would
// desync them (a config PATCH from a route would never reach the email worker).
const CONFIG_G = globalThis as unknown as { __hmsEmailConfigCache?: { at: number; value: Awaited<ReturnType<typeof loadConfig>> } | null };

type ConfigRow = {
  id: string; provider: string; smtpHost: string; smtpPort: number; smtpSecurity: string;
  smtpUser: string; smtpSecretEnc: string; fromName: string; fromEmail: string; replyTo: string;
  timeoutMs: number; testRecipient: string; configuredAt: Date | null;
  lastVerifyAt: Date | null; lastVerifyOk: boolean | null; updatedAt: Date;
};

async function loadConfig(): Promise<ConfigRow> {
  const created = await db.emailConfig.upsert({
    where: { id: CONFIG_ID },
    update: {},
    create: { id: CONFIG_ID },
  });
  return created;
}

function invalidate(): void {
  CONFIG_G.__hmsEmailConfigCache = null;
}

export async function getEmailConfig(): Promise<ConfigRow> {
  const cached = CONFIG_G.__hmsEmailConfigCache;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await loadConfig();
  CONFIG_G.__hmsEmailConfigCache = { at: Date.now(), value };
  return value;
}

/** The decrypted SMTP password — server-side ONLY (provider module). */
export async function getSmtpSecret(): Promise<string | null> {
  const cfg = await getEmailConfig();
  if (!cfg.smtpSecretEnc) return null;
  return decryptSecret(cfg.smtpSecretEnc);
}

export function toSafeConfig(cfg: ConfigRow): EmailConfigSafe {
  const configured = isConfigReady(cfg);
  return {
    provider: cfg.provider,
    smtpHost: cfg.smtpHost,
    smtpPort: cfg.smtpPort,
    smtpSecurity: cfg.smtpSecurity,
    smtpUser: cfg.smtpUser,
    hasPassword: Boolean(cfg.smtpSecretEnc),
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail,
    replyTo: cfg.replyTo,
    timeoutMs: cfg.timeoutMs,
    testRecipient: cfg.testRecipient,
    configured,
    configuredAt: cfg.configuredAt?.toISOString() ?? null,
    lastVerifyAt: cfg.lastVerifyAt?.toISOString() ?? null,
    lastVerifyOk: cfg.lastVerifyOk,
    updatedAt: cfg.updatedAt.toISOString(),
  };
}

export type EmailConfigUpdate = {
  provider?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: "NONE" | "SSL" | "STARTTLS";
  smtpUser?: string;
  smtpPassword?: string | null;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
  timeoutMs?: number;
  testRecipient?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Server-side address validation (§38 — To/CC/BCC/Reply-To validated here). */
export function isValidEmail(address: string): boolean {
  return address.length <= 254 && EMAIL_RE.test(address);
}

/**
 * Provider-aware readiness: can this configuration actually attempt delivery?
 * SMTP needs a host (+ a sender address or user); Resend needs the encrypted
 * API key (+ a from address on a verified Resend domain).
 */
export function isConfigReady(cfg: Pick<ConfigRow, "provider" | "smtpHost" | "smtpPort" | "fromEmail" | "smtpUser" | "smtpSecretEnc">): boolean {
  if (cfg.provider === "RESEND") return Boolean(cfg.smtpSecretEnc && cfg.fromEmail);
  return Boolean(cfg.smtpHost && cfg.smtpPort && (cfg.fromEmail || cfg.smtpUser));
}

export async function updateEmailConfig(update: EmailConfigUpdate): Promise<EmailConfigSafe> {
  const current = await loadConfig();
  const data: Record<string, unknown> = {};
  if (update.provider !== undefined) {
    const provider = update.provider.trim().toUpperCase();
    if (!["SMTP", "RESEND"].includes(provider)) throw new Error("Provider must be SMTP or RESEND.");
    data.provider = provider;
  }
  if (update.smtpHost !== undefined) data.smtpHost = update.smtpHost.trim().slice(0, 253);
  if (update.smtpPort !== undefined) data.smtpPort = Math.min(65535, Math.max(1, Math.floor(update.smtpPort)));
  if (update.smtpSecurity !== undefined) data.smtpSecurity = update.smtpSecurity;
  if (update.smtpUser !== undefined) data.smtpUser = update.smtpUser.trim().slice(0, 254);
  if (update.smtpPassword !== undefined) {
    // Replace only with a non-empty value; explicit null clears; empty string is a no-op
    // (so a frontend that re-submits an untouched form never wipes the stored secret).
    if (update.smtpPassword === null) data.smtpSecretEnc = "";
    else if (update.smtpPassword.length > 0) data.smtpSecretEnc = encryptSecret(update.smtpPassword);
  }
  if (update.fromName !== undefined) data.fromName = update.fromName.trim().slice(0, 120);
  if (update.fromEmail !== undefined) {
    const v = update.fromEmail.trim();
    if (v && !isValidEmail(v)) throw new Error("From email address is not valid.");
    data.fromEmail = v;
  }
  if (update.replyTo !== undefined) {
    const v = update.replyTo.trim();
    if (v && !isValidEmail(v)) throw new Error("Reply-To address is not valid.");
    data.replyTo = v;
  }
  if (update.timeoutMs !== undefined) data.timeoutMs = Math.min(120_000, Math.max(1_000, Math.floor(update.timeoutMs)));
  if (update.testRecipient !== undefined) {
    const v = update.testRecipient.trim();
    if (v && !isValidEmail(v)) throw new Error("Test recipient address is not valid.");
    data.testRecipient = v;
  }
  const merged = { ...current, ...data } as ConfigRow;
  const nowConfigured = isConfigReady(merged);
  if (nowConfigured && !merged.configuredAt) data.configuredAt = new Date();
  if (nowConfigured) {
    // A configuration change invalidates the previous verification result.
    data.lastVerifyAt = null;
    data.lastVerifyOk = null;
  }
  const updated = await db.emailConfig.update({ where: { id: CONFIG_ID }, data });
  invalidate();
  return toSafeConfig(updated);
}

/** Record the outcome of a REAL connection verification (§27 — honest status). */
export async function recordVerifyResult(ok: boolean): Promise<void> {
  await db.emailConfig.update({
    where: { id: CONFIG_ID },
    data: { lastVerifyAt: new Date(), lastVerifyOk: ok },
  }).catch(() => undefined);
  invalidate();
}
