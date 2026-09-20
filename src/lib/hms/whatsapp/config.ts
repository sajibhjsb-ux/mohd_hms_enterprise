// MOHD.HMS ENTERPRISE — WhatsApp configuration (singleton, §9/§36).
// Mirrors src/lib/hms/email/config.ts: upsert-on-read singleton, 15s cache
// (scheduler + route chunks are separate module instances), write-only
// secrets (API key / webhook secret are NEVER returned — only hints).

import { db } from "@/lib/db";
import { encryptSecret, decryptSecret, maskSecretHint } from "./crypto";

const CONFIG_ID = "singleton";

type Cache = { value: WhatsAppConfigRow; at: number } | undefined;
const g = globalThis as unknown as { __hmsWaConfigCache?: Cache };

export type WhatsAppConfigRow = {
  id: string;
  gatewayBaseUrl: string;
  apiKeyEnc: string;
  webhookSecretEnc: string;
  sessionName: string;
  enabled: boolean;
  autoReplies: boolean;
  sessionStatus: string;
  sessionPhone: string;
  sessionPushName: string;
  sessionError: string;
  lastConnectedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  webhookRegistered: boolean;
  webhookId: string;
  testRecipient: string;
  configuredAt: Date | null;
  updatedAt: Date;
};

const CACHE_MS = 15_000;

export async function getWhatsAppConfig(): Promise<WhatsAppConfigRow> {
  const cached = g.__hmsWaConfigCache;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  let row = await db.whatsAppConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row) {
    row = await db.whatsAppConfig.upsert({
      where: { id: CONFIG_ID },
      update: {},
      create: { id: CONFIG_ID },
    });
  }
  g.__hmsWaConfigCache = { value: row, at: Date.now() };
  return row;
}

export function invalidateWhatsAppConfigCache(): void {
  g.__hmsWaConfigCache = undefined;
}

export async function getGatewayClientConfig(): Promise<{ baseUrl: string; apiKey: string; sessionName: string } | null> {
  const cfg = await getWhatsAppConfig();
  const apiKey = decryptSecret(cfg.apiKeyEnc);
  if (!cfg.gatewayBaseUrl || !apiKey) return null;
  return { baseUrl: cfg.gatewayBaseUrl, apiKey, sessionName: cfg.sessionName || "mohd-hms-production" };
}

export async function getWebhookSecret(): Promise<string | null> {
  const cfg = await getWhatsAppConfig();
  return decryptSecret(cfg.webhookSecretEnc);
}

export type WhatsAppConfigSafe = {
  gatewayBaseUrl: string;
  sessionName: string;
  enabled: boolean;
  autoReplies: boolean;
  hasApiKey: boolean;
  apiKeyHint: string;
  hasWebhookSecret: boolean;
  sessionStatus: string;
  sessionPhone: string;
  sessionPushName: string;
  sessionError: string;
  lastConnectedAt: string | null;
  lastHeartbeatAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  webhookRegistered: boolean;
  testRecipient: string;
  configuredAt: string | null;
};

export function toSafeConfig(cfg: WhatsAppConfigRow): WhatsAppConfigSafe {
  return {
    gatewayBaseUrl: cfg.gatewayBaseUrl,
    sessionName: cfg.sessionName,
    enabled: cfg.enabled,
    autoReplies: cfg.autoReplies,
    hasApiKey: !!cfg.apiKeyEnc,
    apiKeyHint: maskSecretHint(cfg.apiKeyEnc),
    hasWebhookSecret: !!cfg.webhookSecretEnc,
    sessionStatus: cfg.sessionStatus,
    sessionPhone: cfg.sessionPhone,
    sessionPushName: cfg.sessionPushName,
    sessionError: cfg.sessionError,
    lastConnectedAt: cfg.lastConnectedAt?.toISOString() ?? null,
    lastHeartbeatAt: cfg.lastHeartbeatAt?.toISOString() ?? null,
    lastInboundAt: cfg.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: cfg.lastOutboundAt?.toISOString() ?? null,
    webhookRegistered: cfg.webhookRegistered,
    testRecipient: cfg.testRecipient,
    configuredAt: cfg.configuredAt?.toISOString() ?? null,
  };
}

export type WhatsAppConfigUpdate = {
  gatewayBaseUrl?: string;
  apiKey?: string | null;       // non-empty replaces; null clears; undefined/"" no-op
  webhookSecret?: string | null;
  sessionName?: string;
  enabled?: boolean;
  autoReplies?: boolean;
  testRecipient?: string;
};

export async function updateWhatsAppConfig(update: WhatsAppConfigUpdate): Promise<WhatsAppConfigSafe> {
  const data: Record<string, unknown> = { configuredAt: new Date() };
  if (update.gatewayBaseUrl !== undefined) data.gatewayBaseUrl = update.gatewayBaseUrl.trim().replace(/\/$/, "");
  if (update.sessionName !== undefined) data.sessionName = update.sessionName.trim() || "mohd-hms-production";
  if (update.enabled !== undefined) data.enabled = update.enabled;
  if (update.autoReplies !== undefined) data.autoReplies = update.autoReplies;
  if (update.testRecipient !== undefined) data.testRecipient = update.testRecipient.trim();
  if (update.apiKey === null) data.apiKeyEnc = "";
  else if (update.apiKey) data.apiKeyEnc = encryptSecret(update.apiKey.trim());
  if (update.webhookSecret === null) data.webhookSecretEnc = "";
  else if (update.webhookSecret) data.webhookSecretEnc = encryptSecret(update.webhookSecret.trim());
  const row = await db.whatsAppConfig.upsert({
    where: { id: CONFIG_ID },
    update: data,
    create: { id: CONFIG_ID, ...data },
  });
  invalidateWhatsAppConfigCache();
  return toSafeConfig(row as WhatsAppConfigRow);
}

/** Honest status mirror updates — only ever called with REAL gateway values. */
export async function recordSessionStatus(s: {
  status?: string; phone?: string | null; pushName?: string | null; error?: string | null;
}): Promise<void> {
  const data: Record<string, unknown> = { lastHeartbeatAt: new Date() };
  if (s.status !== undefined) data.sessionStatus = s.status;
  if (s.phone !== undefined) data.sessionPhone = s.phone ?? "";
  if (s.pushName !== undefined) data.sessionPushName = s.pushName ?? "";
  if (s.error !== undefined) data.sessionError = s.error ?? "";
  if (s.status === "ready") data.lastConnectedAt = new Date();
  if (s.status === "failed" || s.status === "disconnected") data.webhookRegistered = false;
  await db.whatsAppConfig.updateMany({ where: { id: CONFIG_ID }, data });
  invalidateWhatsAppConfigCache();
}

export async function recordWebhookRegistration(webhookId: string): Promise<void> {
  await db.whatsAppConfig.updateMany({
    where: { id: CONFIG_ID },
    data: { webhookRegistered: true, webhookId, lastHeartbeatAt: new Date() },
  });
  invalidateWhatsAppConfigCache();
}

export async function recordTraffic(kind: "inbound" | "outbound"): Promise<void> {
  const field = kind === "inbound" ? "lastInboundAt" : "lastOutboundAt";
  await db.whatsAppConfig.updateMany({ where: { id: CONFIG_ID }, data: { [field]: new Date() } });
  invalidateWhatsAppConfigCache();
}
