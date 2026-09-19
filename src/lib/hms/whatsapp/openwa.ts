// MOHD.HMS ENTERPRISE — OpenWA gateway REST client (server-side ONLY).
// Wraps the pinned OpenWA gateway (mini-services/openwa, commit bcd820d51b,
// v0.23.5) exactly per docs/06-api-specification.md. The X-API-Key lives only
// here and in the encrypted config — it NEVER reaches the browser (§7/§53).
//
// Every request: X-API-Key header, 10s timeout, honest error surfacing.
// Gateway offline / auth failure / validation failure are classified so the
// worker can retry TEMPORARY classes and fail PERMANENT ones (§49/§50).

const GATEWAY_TIMEOUT_MS = 10_000;

export type OpenWaError = Error & { kind: "NETWORK" | "AUTH" | "VALIDATION" | "PROVIDER"; status?: number };

function classify(status: number): OpenWaError["kind"] {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 400 || status === 404 || status === 422) return "VALIDATION";
  if (status === 429) return "PROVIDER";
  return "PROVIDER";
}

function mkError(kind: OpenWaError["kind"], message: string, status?: number): OpenWaError {
  const e = new Error(message) as OpenWaError;
  e.kind = kind;
  e.status = status;
  return e;
}

export type OpenWaClientConfig = { baseUrl: string; apiKey: string; sessionName: string };

async function request<T>(cfg: OpenWaClientConfig, method: string, path: string, body?: unknown): Promise<T> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "X-API-Key": cfg.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw mkError(/timeout|abort/i.test(msg) ? "PROVIDER" : "NETWORK", `OpenWA gateway unreachable: ${msg}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json() as { message?: string | string[]; error?: string };
      detail = Array.isArray(j.message) ? j.message.join("; ") : (j.message || j.error || "");
    } catch { /* non-JSON error body */ }
    throw mkError(classify(res.status), `OpenWA ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

// ── Health / auth ────────────────────────────────────────────────────────────

export async function gatewayHealth(cfg: OpenWaClientConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    const j = await request<{ status?: string }>(cfg, "GET", "/api/health");
    return { ok: true, detail: j?.status || "ok" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function validateApiKey(cfg: OpenWaClientConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    await request(cfg, "POST", "/api/auth/validate", {});
    return { ok: true, detail: "API key accepted" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Sessions (§8) ────────────────────────────────────────────────────────────

export type OpenWaSession = {
  id?: string; name?: string; status?: string; phone?: string; pushName?: string;
  connectedAt?: string | null; lastActive?: string | null; lastError?: string | null;
  engineLoaded?: boolean;
};

export async function listSessions(cfg: OpenWaClientConfig): Promise<OpenWaSession[]> {
  const j = await request<{ data?: OpenWaSession[] } | OpenWaSession[]>(cfg, "GET", "/api/sessions");
  const rows = Array.isArray(j) ? j : (j.data ?? []);
  return rows;
}

export async function getSession(cfg: OpenWaClientConfig, sessionId: string): Promise<OpenWaSession> {
  return await request<OpenWaSession>(cfg, "GET", `/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function createSession(cfg: OpenWaClientConfig, name: string): Promise<OpenWaSession> {
  return await request<OpenWaSession>(cfg, "POST", "/api/sessions", { name });
}

export async function startSession(cfg: OpenWaClientConfig, sessionId: string): Promise<OpenWaSession> {
  return await request<OpenWaSession>(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/start`, {});
}

export async function stopSession(cfg: OpenWaClientConfig, sessionId: string): Promise<void> {
  await request(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/stop`, {});
}

export async function logoutSession(cfg: OpenWaClientConfig, sessionId: string): Promise<void> {
  await request(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/logout`, {});
}

export async function deleteSession(cfg: OpenWaClientConfig, sessionId: string): Promise<void> {
  await request(cfg, "DELETE", `/api/sessions/${encodeURIComponent(sessionId)}`);
}

/** QR as a PNG data URL (data:image/png;base64,…) — render directly in <img>. */
export async function getSessionQr(cfg: OpenWaClientConfig, sessionId: string): Promise<{ qrCode?: string; status?: string }> {
  return await request<{ qrCode?: string; status?: string }>(cfg, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/qr`);
}

/** Phone-number pairing code — alternative to QR when the engine supports it (§11). */
export async function requestPairingCode(cfg: OpenWaClientConfig, sessionId: string, phoneNumber: string): Promise<{ pairingCode?: string; status?: string }> {
  return await request<{ pairingCode?: string; status?: string }>(
    cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/pairing-code`, { phoneNumber },
  );
}

// ── Messaging (§12/§13) ──────────────────────────────────────────────────────

export type OpenWaSendResult = { id?: string; messageId?: string };

export async function sendText(cfg: OpenWaClientConfig, sessionId: string, chatId: string, text: string): Promise<OpenWaSendResult> {
  return await request<OpenWaSendResult>(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, { chatId, text });
}

export async function sendDocument(
  cfg: OpenWaClientConfig, sessionId: string, chatId: string,
  media: { base64: string; mimetype: string; filename: string; caption?: string },
): Promise<OpenWaSendResult> {
  return await request<OpenWaSendResult>(
    cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-document`,
    { chatId, ...media },
  );
}

export async function sendImage(
  cfg: OpenWaClientConfig, sessionId: string, chatId: string,
  media: { base64: string; mimetype: string; filename?: string; caption?: string },
): Promise<OpenWaSendResult> {
  return await request<OpenWaSendResult>(
    cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-image`,
    { chatId, ...media },
  );
}

/** Download inbound media bytes for storage in MinIO (§32). */
export async function getInboundMedia(
  cfg: OpenWaClientConfig, sessionId: string, chatId: string, messageId: string,
): Promise<{ buffer: Buffer; mimetype: string } | null> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": cfg.apiKey },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch (e) {
    throw mkError("NETWORK", `OpenWA media fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw mkError(classify(res.status), `OpenWA media fetch ${res.status}`, res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimetype: res.headers.get("content-type") || "application/octet-stream" };
}

// ── Webhooks (§17/§18) ───────────────────────────────────────────────────────

export type OpenWaWebhook = {
  id?: string; url?: string; events?: string[]; enabled?: boolean;
  secret?: string; // write-only on create; never returned by the gateway
};

export async function listWebhooks(cfg: OpenWaClientConfig, sessionId: string): Promise<OpenWaWebhook[]> {
  const j = await request<{ data?: OpenWaWebhook[] } | OpenWaWebhook[]>(cfg, "GET", `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`);
  return Array.isArray(j) ? j : (j.data ?? []);
}

export async function createWebhook(
  cfg: OpenWaClientConfig, sessionId: string,
  input: { url: string; events: string[]; secret: string; headers?: Record<string, string> },
): Promise<OpenWaWebhook> {
  return await request<OpenWaWebhook>(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`, input);
}

export async function deleteWebhook(cfg: OpenWaClientConfig, sessionId: string, webhookId: string): Promise<void> {
  await request(cfg, "DELETE", `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`);
}

export async function testWebhook(cfg: OpenWaClientConfig, sessionId: string, webhookId: string): Promise<{ success?: boolean; statusCode?: number; error?: string }> {
  return await request(cfg, "POST", `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}/test`, {});
}
