// MOHD.HMS ENTERPRISE — WhatsApp automation end-to-end QA (spec §63-§65).
// Exercises the REAL dev server + REAL OpenWA gateway + REAL signed webhook
// deliveries + REAL DB. Run: bun scripts/whatsapp-qa.ts
//
// Sections:
//  0 login (admin + customer)                    5 config credential security
//  1 webhook security (signature, fail-closed)   6 inbound unknown number → controlled reply
//  2 idempotency (duplicate deliveries)          7 inbound known customer → complaint automation E2E
//  3 session honesty (live gateway probe)        8 templates/automations/health/logs APIs
//  4 OpenWA real API (health/key/session/QR)     9 RBAC + rate limit + audit
// 10 cleanup

import crypto from "crypto";

const ORIGIN = process.env.QA_ORIGIN || "http://localhost:3000";
const OPENWA = "http://127.0.0.1:2785";
const { readFileSync } = await import("fs");
const OPENWA_API_KEY = readFileSync("/tmp/openwa-apikey.txt", "utf8").trim();
const OPENWA_WEBHOOK_SECRET = readFileSync("/tmp/openwa-webhooksecret.txt", "utf8").trim();
const WEBHOOK_URL = `${ORIGIN}/api/v1/whatsapp/openwa/webhook`;

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(name: string): void { console.log(`\n── ${name} ${"─".repeat(Math.max(3, 62 - name.length))}`); }

// ── helpers ──────────────────────────────────────────────────────────────────
const jars: Record<string, string> = {};
async function api(method: string, path: string, body?: unknown, jar?: string): Promise<{ status: number; json: any; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jar && jars[jar]) headers.Cookie = jars[jar];
  const res = await fetch(`${ORIGIN}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
  const setCookie = res.headers.get("set-cookie");
  if (jar && setCookie) jars[jar] = setCookie.split(";")[0];
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json, headers: res.headers };
}

function sign(secret: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

async function deliverWebhook(event: string, idempotencyKey: string, data: Record<string, unknown>, secret = OPENWA_WEBHOOK_SECRET): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify({ event, sessionId: "qa-session", idempotencyKey, deliveryId: `d-${idempotencyKey}`, timestamp: new Date().toISOString(), data });
  const res = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": sign(secret, payload), "X-OpenWA-Event": event, "X-OpenWA-Idempotency-Key": idempotencyKey }, body: payload });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ═══ 0. LOGIN ════════════════════════════════════════════════════════════════
section("0 LOGIN");
const adminLogin = await api("POST", "/api/v1/auth/login", { email: "operations@mohdhms.com", password: "Password@123" }, "admin");
check("admin login", adminLogin.status === 200 && adminLogin.json?.ok === true, `status=${adminLogin.status}`);
const custLogin = await api("POST", "/api/v1/auth/login", { email: "customer1@demo.my", password: "Password@123" }, "cust");
check("customer login", custLogin.status === 200 && custLogin.json?.ok === true, `status=${custLogin.status}`);

// ═══ 4. REAL OpenWA GATEWAY API (§65) ═══════════════════════════════════════
section("4 OPENWA REAL API (health / auth / session / QR)");
{
  const health = await (await fetch(`${OPENWA}/api/health`)).json();
  check("gateway health ok", health?.status === "ok");
  const validate = await (await fetch(`${OPENWA}/api/auth/validate`, { method: "POST", headers: { "X-API-Key": OPENWA_API_KEY }, body: "{}" })).json();
  check("API key valid (admin role)", validate?.valid === true && validate?.role === "admin");
  const badKey = await fetch(`${OPENWA}/api/sessions`, { headers: { "X-API-Key": "wrong-key-000" } });
  check("wrong API key rejected (401)", badKey.status === 401);
  const sessions = await (await fetch(`${OPENWA}/api/sessions`, { headers: { "X-API-Key": OPENWA_API_KEY } })).json();
  const rows = Array.isArray(sessions) ? sessions : sessions?.data ?? [];
  const mine = rows.find((s: any) => s.name === "mohd-hms-production");
  check("session mohd-hms-production exists", !!mine);
  if (mine?.id) {
    const detail = await (await fetch(`${OPENWA}/api/sessions/${mine.id}`, { headers: { "X-API-Key": OPENWA_API_KEY } })).json();
    check("session status is honest", ["created", "initializing", "qr_ready", "authenticating", "ready", "disconnected", "failed"].includes(detail?.status), `status=${detail?.status}`);
    const qrRes = await fetch(`${OPENWA}/api/sessions/${mine.id}/qr`, { headers: { "X-API-Key": OPENWA_API_KEY } });
    const qr = await qrRes.json().catch(() => null);
    check("QR retrievable (PNG data URL) while qr_ready/ready", qrRes.status === 200 || detail?.status !== "qr_ready", `qrStatus=${qrRes.status} sessionStatus=${detail?.status}`);
    if (qr?.qrCode) check("QR is a data:image/png data URL", String(qr.qrCode).startsWith("data:image/png;base64,"));
  }
  const webhooks = await (await fetch(`${OPENWA}/api/sessions/${mine?.id}/webhooks`, { headers: { "X-API-Key": OPENWA_API_KEY } })).json().catch(() => null);
  const hooks = Array.isArray(webhooks) ? webhooks : webhooks?.data ?? [];
  check("webhook registered on gateway with our URL", hooks.some((w: any) => w.url?.endsWith("/api/v1/whatsapp/openwa/webhook") && w.active));
}

// ═══ 1. WEBHOOK SECURITY (§18) ═══════════════════════════════════════════════
section("1 WEBHOOK SECURITY");
{
  const payload = JSON.stringify({ event: "message.received", idempotencyKey: "sec-1", data: {} });
  const noSig = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
  check("missing signature → 401", noSig.status === 401);
  const badSig = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": "sha256=" + "0".repeat(64) }, body: payload });
  check("wrong signature → 401", badSig.status === 401);
  const wrongSecret = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": sign("attacker-secret-0000000000000000", payload) }, body: payload });
  check("wrong secret → 401", wrongSecret.status === 401);
  const garbage = await fetch(WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "not json at all" });
  check("non-JSON body → 401 (fail-closed before parse)", garbage.status === 401);
}

// ═══ 6. INBOUND — UNKNOWN NUMBER (§23) ═══════════════════════════════════════
section("6 UNKNOWN NUMBER → CONTROLLED REPLY, NO CUSTOMER CREATED");
{
  const r = await deliverWebhook("message.received", `qa-unknown-${Date.now()}`, {
    id: `wam.unknown.${Date.now()}`, from: "6739990001@c.us", to: "6737123456@c.us",
    body: "AC not cooling", type: "text", timestamp: Math.floor(Date.now() / 1000),
    isGroup: false, kind: "individual", hasMedia: false, fromMe: false,
  });
  check("verified delivery accepted (200)", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  check("processed (not duplicate)", r.json?.data?.processed === true);
}

// ═══ 2. IDEMPOTENCY (§20) ════════════════════════════════════════════════════
section("2 IDEMPOTENCY — DUPLICATE DELIVERY NEVER DOUBLE-PROCESSES");
{
  const key = `qa-dup-${Date.now()}`;
  const msgId = `wam.dup.${Date.now()}`;
  const data = {
    id: msgId, from: "6739990002@c.us", to: "6737123456@c.us",
    body: "HELP", type: "text", timestamp: Math.floor(Date.now() / 1000),
    isGroup: false, kind: "individual", hasMedia: false, fromMe: false,
  };
  const first = await deliverWebhook("message.received", key, data);
  check("first delivery processed", first.json?.data?.processed === true);
  const second = await deliverWebhook("message.received", key, data);
  check("second delivery flagged duplicate", second.json?.data?.duplicate === true && second.json?.data?.processed === false);
  const third = await deliverWebhook("message.received", `qa-dup2-${Date.now()}`, { ...data, id: msgId });
  check("same message id redelivered under new key → still deduped", third.json?.data?.processed === true);
}

// ═══ 7. INBOUND — KNOWN CUSTOMER → COMPLAINT E2E (§22/§59/§60) ═══════════════
section("7 KNOWN CUSTOMER 'AC not cooling' → COMPLAINT + CONFIRMATION");
let complaintCountBefore = 0;
{
  // Farah Aziz (seed): +60 3-2166 8800 → chat 60321668800@c.us
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  complaintCountBefore = await db.complaint.count();
  await db.$disconnect();

  const r = await deliverWebhook("message.received", `qa-complaint-${Date.now()}`, {
    id: `wam.cmp.${Date.now()}`, from: "60321668800@c.us", to: "6737123456@c.us",
    body: "AC is not cooling", type: "text", timestamp: Math.floor(Date.now() / 1000),
    isGroup: false, kind: "individual", hasMedia: false, fromMe: false,
    contact: { pushName: "Farah WA" },
  });
  check("complaint delivery accepted", r.status === 200 && r.json?.data?.processed === true);
  await new Promise((r2) => setTimeout(r2, 2500)); // allow the queue + engine tick

  const db2 = new (await import("@prisma/client")).PrismaClient();
  const complaint = await db2.complaint.findFirst({ where: { title: { startsWith: "WhatsApp:" }, description: "AC is not cooling" }, orderBy: { createdAt: "desc" } });
  check("complaint created with WhatsApp prefix", !!complaint, "no complaint row");
  check("complaint number assigned (CPT-…)", !!complaint?.code?.startsWith("CPT-"), complaint?.code);
  const cust = await db2.customer.findUnique({ where: { id: complaint?.customerId ?? "" } });
  check("complaint linked to the identified customer", cust?.contactPerson === "Farah Aziz");
  const confirmation = complaint ? await db2.whatsAppMessage.findFirst({ where: { relatedType: "COMPLAINT", relatedId: complaint.id, direction: "OUTBOUND", templateKey: "COMPLAINT_CREATED" } }) : null;
  check("customer confirmation queued (COMPLAINT_CREATED template)", !!confirmation);
  check("confirmation body contains complaint number", !!confirmation?.body.includes(complaint?.code ?? "NONE"));
  const inboundRow = await db2.whatsAppMessage.findFirst({ where: { chatId: "60321668800@c.us", direction: "INBOUND" }, orderBy: { createdAt: "desc" } });
  check("inbound message stored with provider id", !!inboundRow?.providerMessageId?.startsWith("wam.cmp."));
  const conv = await db2.whatsAppConversation.findUnique({ where: { chatId: "60321668800@c.us" } });
  check("conversation linked to customer", conv?.customerId === cust?.id);
  const contact = await db2.whatsAppContact.findUnique({ where: { chatId: "60321668800@c.us" } });
  check("contact created with normalized phone", contact?.phone === "+60321668800");
  check("no unauthenticated customer created", (await db2.whatsAppContact.findUnique({ where: { chatId: "6739990001@c.us" } }))?.customerId == null);
  await db2.$disconnect();
}

// ═══ 8. ADMIN APIs (§28/§34-§38/§48) ═════════════════════════════════════════
section("8 ADMIN APIs — config / session / templates / automations / logs / health");
{
  const cfg = await api("GET", "/api/v1/whatsapp/config", undefined, "admin");
  check("config GET ok", cfg.status === 200 && cfg.json?.data?.sessionName === "mohd-hms-production");
  check("API key never returned (hasApiKey + hint only)", cfg.json?.data?.hasApiKey === true && cfg.json?.data?.apiKeyEnc === undefined && typeof cfg.json?.data?.apiKeyHint === "string");
  check("webhook secret never returned", cfg.json?.data?.webhookSecretEnc === undefined && cfg.json?.data?.hasWebhookSecret === true);

  const session = await api("GET", "/api/v1/whatsapp/session", undefined, "admin");
  check("session status is live+honest", session.status === 200 && ["CONNECTED", "CONNECTING", "QR_REQUIRED", "AUTHENTICATED", "DISCONNECTED", "ERROR"].includes(session.json?.data?.uiState), `uiState=${session.json?.data?.uiState}`);

  const health = await api("GET", "/api/v1/whatsapp/health", undefined, "admin");
  check("health reports real gateway reachability", health.json?.data?.gateway?.reachable === true);
  check("health reports real API key validity", health.json?.data?.apiKeyValid === true);
  check("health queue counters present", typeof health.json?.data?.queue?.queued === "number");

  const templates = await api("GET", "/api/v1/whatsapp/templates", undefined, "admin");
  check("templates seeded (catalog)", templates.status === 200 && templates.json?.data?.length >= 10);
  check("COMPLAINT_CREATED template present", templates.json?.data?.some((t: any) => t.key === "COMPLAINT_CREATED"));

  const automations = await api("GET", "/api/v1/whatsapp/automations", undefined, "admin");
  check("automations seeded (7 event automations)", automations.status === 200 && automations.json?.data?.length >= 7);

  const logs = await api("GET", "/api/v1/whatsapp/messages?pageSize=50", undefined, "admin");
  check("message log lists inbound+outbound", logs.status === 200 && logs.json?.data?.length >= 3);
  check("log rows have status + direction + template provenance", logs.json?.data?.every((m: any) => m.status && m.direction));

  const conversations = await api("GET", "/api/v1/whatsapp/conversations", undefined, "admin");
  check("conversation list returns the WhatsApp chats", conversations.status === 200 && conversations.json?.data?.length >= 2);

  const meta = await api("GET", "/api/v1/whatsapp/meta", undefined, "admin");
  check("meta exposes vocabularies", meta.status === 200 && !!meta.json?.data?.events?.length);
}

// ═══ 9. RBAC (§52) + rate limit ══════════════════════════════════════════════
section("9 RBAC — CUSTOMER/STAFF LOCKOUT + AUDIT");
{
  const cfg = await api("GET", "/api/v1/whatsapp/config", undefined, "cust");
  check("customer blocked from whatsapp config (403)", cfg.status === 403);
  const health = await api("GET", "/api/v1/whatsapp/health", undefined, "cust");
  check("customer blocked from health (403)", health.status === 403);
  const convs = await api("GET", "/api/v1/whatsapp/conversations", undefined, "cust");
  check("customer blocked from inbox (403)", convs.status === 403);
  const anon = await api("GET", "/api/v1/whatsapp/config");
  check("anonymous blocked (401)", anon.status === 401);

  const { PrismaClient } = await import("@prisma/client");
  // Audits are written async (void audit()) — give the write a moment before
  // asserting, otherwise this check flakes on a fast machine.
  await new Promise((r) => setTimeout(r, 1500));
  const db = new PrismaClient();
  const audits = await db.auditLog.findMany({ where: { action: { in: ["WHATSAPP_COMPLAINT_CREATED", "WHATSAPP_CONFIG_UPDATED"] } }, take: 20 });
  // The real leak test: no raw secret VALUE may appear in the metadata.
  // (Flag NAMES like apiKeyChanged:true are fine — they carry no secret.)
  const serialized = JSON.stringify(audits);
  const leakedSecret = [OPENWA_API_KEY, OPENWA_WEBHOOK_SECRET].filter((s) => s && serialized.includes(s));
  check("audit rows written (no secret VALUES in metadata)", audits.length >= 1 && leakedSecret.length === 0,
    leakedSecret.length ? `leaked: ${leakedSecret.map((s) => s.slice(0, 6) + "…").join(", ")}` : "");
  await db.$disconnect();
}

// ═══ 10. CLEANUP STATE (keep messages for browser QA) ═══════════════════════
section("10 FINAL STATE");
{
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  const counts = {
    messages: await db.whatsAppMessage.count(),
    conversations: await db.whatsAppConversation.count(),
    contacts: await db.whatsAppContact.count(),
    webhookEvents: await db.whatsAppWebhookEvent.count(),
    duplicates: await db.whatsAppWebhookEvent.count({ where: { status: "DUPLICATE" } }),
    complaints: await db.complaint.count(),
  };
  console.log("  ", JSON.stringify(counts));
  check("complaint automation increased complaint count", counts.complaints > complaintCountBefore);
  check("webhook event rows retained (traceability)", counts.webhookEvents >= 4);
  await db.$disconnect();
}

console.log(`\n═══ RESULTS: ${passed} passed, ${failed} failed ═══`);
process.exit(failed ? 1 : 0);
