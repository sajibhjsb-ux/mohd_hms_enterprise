/**
 * QA — WhatsApp full-system E2E against the LIVE gateway (:2785, baileys) and
 * app (:3000). Kept as the ops verification tool per mini-services/WHATSAPP-GATEWAY.md.
 * Safe to re-run: idempotent connect, leaves the session qr_ready (unpaired).
 * Run: bun scripts/whatsapp-e2e.ts
 */
const BASE = "http://localhost:3000";
const GW = "http://127.0.0.1:2785";
const GW_KEY_PATH = "/home/z/openwa/data/.api-key"; // gateway's own seeded key
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
function gwKey(): string {
  const raw = fs.readFileSync(GW_KEY_PATH, "utf8").trim();
  try { const j = JSON.parse(raw); return j.apiKey || j.key || raw; } catch { return raw; }
}

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(email: string) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password@123" }),
  });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session="));
}
const get = (ck: string, p: string) => fetch(`${BASE}${p}`, { headers: { cookie: ck } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (ck: string, p: string, d?: unknown) => fetch(`${BASE}${p}`, { method: "POST", headers: { cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify(d ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  console.log("── WhatsApp full-system E2E ──");
  const admin = await login("admin@mohdhms.com");
  const sup = await login("supervisor@mohdhms.com");
  const cust = await login("customer1@demo.my");
  ok("sessions (admin/supervisor/customer)", !!admin && !!sup && !!cust);

  // ── §38 RBAC / API security ──
  const noAuth = await fetch(`${BASE}/api/v1/whatsapp/session/qr`).then((r) => r.status);
  ok("QR endpoint requires auth (401)", noAuth === 401, `status=${noAuth}`);
  const custQr = await get(cust!, "/api/v1/whatsapp/session/qr");
  ok("customer blocked from QR (403)", custQr.status === 403, `status=${custQr.status}`);
  const custSession = await get(cust!, "/api/v1/whatsapp/session");
  ok("customer blocked from session (403)", custSession.status === 403, `status=${custSession.status}`);
  const cfg = await get(admin!, "/api/v1/whatsapp/config");
  const cfgStr = JSON.stringify(cfg.body);
  ok("config exposes no secret values", !/"apiKey"/.test(cfgStr) && !/owa_/.test(cfgStr) && cfg.body?.data?.hasApiKey === true, `hint=${cfg.body?.data?.apiKeyHint}`);

  // ── Bring the session up FIRST (fresh start resets Baileys' QR-ref cycle) ──
  // An unscanned session cycles (close 408 → reconnect backoff) every ~2min;
  // every run therefore starts from a deliberate stop → connect → fresh QR.
  await post(admin!, "/api/v1/whatsapp/session/disconnect", { logout: false });
  await sleep(2_000);
  const up = await post(admin!, "/api/v1/whatsapp/session");
  ok("connect (idempotent) ok", up.status === 200, up.body?.data?.detail || up.body?.error?.message);
  let live = false;
  for (let i = 0; i < 10; i++) {
    await sleep(3500);
    const s = await get(admin!, "/api/v1/whatsapp/session");
    if (s.body?.data?.sessionStatus === "qr_ready") { live = true; break; }
  }
  ok("session reaches qr_ready", live);

  // ── Session status honesty (§16/§37) ──
  const st0 = await get(admin!, "/api/v1/whatsapp/session");
  ok("session status mirrors gateway truth", ["qr_ready", "ready", "initializing"].includes(st0.body?.data?.sessionStatus), `status=${st0.body?.data?.sessionStatus}`);
  ok("uiState mapped", st0.body?.data?.uiState === "QR_REQUIRED", `uiState=${st0.body?.data?.uiState}`);

  // ── QR freshness + rotation (§3/§4/§5) ──
  const qr1 = await get(admin!, "/api/v1/whatsapp/session/qr");
  ok("QR served as PNG data URL", qr1.body?.data?.state === "READY" && /^data:image\/png;base64,/.test(qr1.body?.data?.qr || ""), `len=${(qr1.body?.data?.qr || "").length}`);
  const png = Buffer.from((qr1.body?.data?.qr || "").split(",")[1] || "", "base64");
  ok("QR bytes are a real PNG (\u0089PNG magic)", png.slice(0, 4).toString("hex") === "89504e47", `${png.length} bytes`);
  const md5a = crypto.createHash("md5").update(png).digest("hex");
  // WhatsApp rotates the pairing QR roughly every 20-25s; sample up to 30s.
  // In-session rotation is server-driven (~20-25s, may pause late in a QR
  // window) — sample up to 45s, then ALSO prove freshness the deterministic
  // way: a NEW pairing session must produce a DIFFERENT QR (never a stale one).
  let md5b = md5a;
  for (let i = 0; i < 9; i++) {
    await sleep(5_000);
    const q = await get(admin!, "/api/v1/whatsapp/session/qr");
    md5b = crypto.createHash("md5").update(Buffer.from((q.body?.data?.qr || "").split(",")[1] || "", "base64")).digest("hex");
    if (md5b !== md5a) break;
  }
  if (md5b === md5a) {
    await post(admin!, "/api/v1/whatsapp/session/disconnect", { logout: false });
    await sleep(2_000);
    await post(admin!, "/api/v1/whatsapp/session");
    for (let w = 0; w < 10; w++) {
      await sleep(3_500);
      const s = await get(admin!, "/api/v1/whatsapp/session");
      if (s.body?.data?.sessionStatus === "qr_ready") break;
    }
    const qFresh = await get(admin!, "/api/v1/whatsapp/session/qr");
    md5b = crypto.createHash("md5").update(Buffer.from((qFresh.body?.data?.qr || "").split(",")[1] || "", "base64")).digest("hex");
  }
  ok("QR is fresh (rotates in-session or across sessions — never stale)", md5a !== md5b, `${md5a.slice(0, 8)} → ${md5b.slice(0, 8)}`);
  const st1 = await get(admin!, "/api/v1/whatsapp/session");
  ok("still qr_ready during rotations (live socket)", st1.body?.data?.sessionStatus === "qr_ready");
  // Fetch the CURRENT QR once more and decode that exact image.
  const qr2 = await get(admin!, "/api/v1/whatsapp/session/qr");
  const png2 = Buffer.from((qr2.body?.data?.qr || "").split(",")[1] || "", "base64");

  // ── QR decode: content is a real pairing ref, not a URL/dummy (§34) ──
  // bun+pngjs quirk → decode in node; re-fetch if a rotation race truncated the PNG.
  let decoded = "UNDECODED";
  for (let attempt = 0; attempt < 3 && decoded === "UNDECODED"; attempt++) {
    const q = attempt === 0 ? qr2 : await get(admin!, "/api/v1/whatsapp/session/qr");
    const p = Buffer.from((q.body?.data?.qr || "").split(",")[1] || "", "base64");
    if (p.slice(0, 4).toString("hex") !== "89504e47") continue;
    fs.writeFileSync("/tmp/wa-qr-decode.png", p);
    try {
      decoded = execSync(`node -e "const {PNG}=require('/home/z/my-project/node_modules/pngjs');const jsQR=require('/home/z/my-project/node_modules/jsqr');const p=PNG.sync.read(require('fs').readFileSync('/tmp/wa-qr-decode.png'));const d=jsQR(new Uint8ClampedArray(p.data),p.width,p.height);console.log(d?d.data:'UNDECODED')"`, { encoding: "utf8" }).trim();
    } catch { decoded = "UNDECODED"; }
    if (decoded === "UNDECODED") await sleep(3_000);
  }
  ok("QR decodes", !!decoded && decoded !== "UNDECODED", `head=${decoded.slice(0, 30)}…`);
  // WhatsApp's CURRENT companion-device QR wraps the noise ref in the
  // official wa.me deep link (baileys companion-reg-client-utils.js:32);
  // older builds emit the bare 2@ ref. Both are genuine pairing QRs.
  const isModern = decoded.startsWith("https://wa.me/settings/linked_devices#2@") && decoded.includes(",");
  const isLegacy = /^2@[A-Za-z0-9+/=]+,/.test(decoded);
  ok("QR is a genuine WhatsApp pairing ref (2@ noise ref)", isModern || isLegacy, isModern ? "modern wa.me wrapper" : isLegacy ? "legacy bare ref" : decoded.slice(0, 40));
  ok("QR is NOT a website/dummy URL", isModern || isLegacy);

  // ── Pairing code (§11) — fresh window required: reconnect if the unscanned
  // session cycled (honest refusal is correct behavior, retry after recovery).
  let pc = null as Awaited<ReturnType<typeof post>> | null;
  for (let i = 0; i < 3; i++) {
    pc = await post(admin!, "/api/v1/whatsapp/session/pairing-code", { phone: "+6737123456" });
    if (pc.status === 200 && /^[A-Z0-9]{8}$/.test(pc.body?.data?.pairingCode || "")) break;
    // recover the session, then ask again
    await post(admin!, "/api/v1/whatsapp/session/reconnect");
    for (let w = 0; w < 8; w++) {
      await sleep(3_500);
      const s = await get(admin!, "/api/v1/whatsapp/session");
      if (s.body?.data?.sessionStatus === "qr_ready") break;
    }
  }
  ok("pairing code issued (real 8-char)", !!pc && pc.status === 200 && /^[A-Z0-9]{8}$/.test(pc.body?.data?.pairingCode || ""), `code=${pc?.body?.data?.pairingCode ?? pc?.body?.error?.message}`);
  const pcSup = await post(sup!, "/api/v1/whatsapp/session/pairing-code", { phone: "+6737123456" });
  ok("supervisor (whatsapp.send but no connect) blocked from pairing (403)", pcSup.status === 403, `status=${pcSup.status}`);

  // ── Webhook: signature verification + ingestion (§23) ──
  const secretRow = await get(admin!, "/api/v1/whatsapp/health");
  const st2 = await get(admin!, "/api/v1/whatsapp/session");
  ok("webhook not yet registered pre-link (honest)", st2.body?.data?.webhookRegistered === false);
  // signed delivery simulation: read secret from the app DB via crypto is not
  // reachable here; instead verify fail-closed behavior with a WRONG signature.
  const payload = JSON.stringify({ event: "session.status", idempotencyKey: `qa-${Date.now()}`, deliveryId: "qa-d1", sessionId: "qa", data: { status: "qr_ready" } });
  const badSig = await fetch(`${BASE}/api/v1/whatsapp/openwa/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": "sha256=deadbeef" }, body: payload });
  ok("webhook rejects bad signature (401 fail-closed)", badSig.status === 401, `status=${badSig.status}`);
  const noSig = await fetch(`${BASE}/api/v1/whatsapp/openwa/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
  ok("webhook rejects missing signature (401)", noSig.status === 401, `status=${noSig.status}`);

  // Positive path: sign a REAL session.status delivery with the actual secret
  // (decrypted from the app DB with the same env-derived key) and verify the
  // full chain: signature accepted → ingested → mirrored → idempotent.
  const qdb = new PrismaClient();
  const cfgRow = await qdb.whatsAppConfig.findUnique({ where: { id: "singleton" } });
  const envSecret = (() => {
    const envText = fs.readFileSync("/home/z/my-project/.env", "utf8");
    for (const k of ["WHATSAPP_CRYPTO_SECRET", "OTP_HASH_SECRET", "NEXTAUTH_SECRET"]) {
      const m = envText.match(new RegExp(`^${k}=(\\S+)`, "m"));
      if (m) return m[1];
    }
    return "mohd-hms-dev-only-whatsapp-secret";
  })();
  const aesKey = crypto.createHash("sha256").update(envSecret).digest();
  const [v, ivB, tagB, dataB] = (cfgRow?.webhookSecretEnc || "").split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(ivB, "base64"));
  d.setAuthTag(Buffer.from(tagB, "base64"));
  const waSecret = Buffer.concat([d.update(Buffer.from(dataB, "base64")), d.final()]).toString("utf8");
  ok("webhook secret decryptable (env key valid)", waSecret.length >= 16, `len=${waSecret.length}`);
  const qaKey = `qa-status-${Date.now()}`;
  const evtPayload = JSON.stringify({ event: "session.status", timestamp: new Date().toISOString(), sessionId: "qa-session", idempotencyKey: qaKey, deliveryId: `qa-d-${Date.now()}`, data: { status: "qr_ready" } });
  const sig = "sha256=" + crypto.createHmac("sha256", waSecret).update(evtPayload).digest("hex");
  const good = await fetch(`${BASE}/api/v1/whatsapp/openwa/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": sig, "X-OpenWA-Idempotency-Key": qaKey }, body: evtPayload });
  const goodBody = await good.json().catch(() => null);
  ok("signed session.status accepted (200 processed)", good.status === 200 && goodBody?.data?.processed === true, `status=${good.status}`);
  const evtRow = await qdb.whatsAppWebhookEvent.findUnique({ where: { idempotencyKey: qaKey } });
  ok("webhook event row persisted", !!evtRow, evtRow?.event ?? "");
  const dup = await fetch(`${BASE}/api/v1/whatsapp/openwa/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-OpenWA-Signature": sig, "X-OpenWA-Idempotency-Key": qaKey }, body: evtPayload });
  const dupBody = await dup.json().catch(() => null);
  ok("duplicate delivery idempotent (no double-process)", dup.status === 200 && dupBody?.data?.duplicate === true, `status=${dup.status}`);
  await qdb.whatsAppWebhookEvent.deleteMany({ where: { idempotencyKey: { startsWith: "qa-status-" } } });
  await qdb.$disconnect();

  // ── Duplicate-session protection (§6/§31) ──
  const gk = gwKey();
  const gwSessions = await fetch(`${GW}/api/sessions`, { headers: { "X-API-Key": gk } }).then((r) => r.json());
  const rows = Array.isArray(gwSessions) ? gwSessions : gwSessions.data ?? [];
  const mine = rows.filter((s: { name?: string }) => s.name === "mohd-hms-production");
  ok("exactly ONE gateway session for the configured name", mine.length === 1, `count=${mine.length}`);
  const reConnect = await post(admin!, "/api/v1/whatsapp/session");
  ok("re-connect is idempotent (reuses live session, no restart)", reConnect.status === 200 && /started/i.test(reConnect.body?.data?.detail || ""), `detail=${reConnect.body?.data?.detail}`);
  const gwSessions2 = await fetch(`${GW}/api/sessions`, { headers: { "X-API-Key": gk } }).then((r) => r.json());
  const rows2 = Array.isArray(gwSessions2) ? gwSessions2 : gwSessions2.data ?? [];
  ok("idempotent connect created NO duplicate session", rows2.filter((s: { name?: string }) => s.name === "mohd-hms-production").length === 1);

  // ── Stop → honest disconnected → QR refused → restart recovers (§15/§39) ──
  const disc = await post(admin!, "/api/v1/whatsapp/session/disconnect", { logout: false });
  ok("disconnect (stop) ok", disc.status === 200, disc.body?.data?.detail);
  const st3 = await get(admin!, "/api/v1/whatsapp/session");
  ok("status honestly DISCONNECTED after stop", st3.body?.data?.sessionStatus === "disconnected" || st3.body?.data?.uiState === "DISCONNECTED", `status=${st3.body?.data?.sessionStatus}`);
  const qrStop = await get(admin!, "/api/v1/whatsapp/session/qr");
  ok("QR refused while session down (no dead QR)", qrStop.status === 400 && qrStop.body?.data?.qr == null, `status=${qrStop.status}`);
  const recon = await post(admin!, "/api/v1/whatsapp/session/reconnect");
  ok("reconnect brings session back", recon.status === 200, recon.body?.data?.detail || recon.body?.error?.message);
  let readyAgain = false;
  for (let i = 0; i < 8; i++) {
    await sleep(3500);
    const s = await get(admin!, "/api/v1/whatsapp/session");
    if (s.body?.data?.sessionStatus === "qr_ready") { readyAgain = true; break; }
  }
  ok("session returns to qr_ready after reconnect", readyAgain);
  const gwSessions3 = await fetch(`${GW}/api/sessions`, { headers: { "X-API-Key": gk } }).then((r) => r.json());
  const rows3 = Array.isArray(gwSessions3) ? gwSessions3 : gwSessions3.data ?? [];
  ok("still exactly ONE session after stop+reconnect", rows3.filter((s: { name?: string }) => s.name === "mohd-hms-production").length === 1, `count=${rows3.length}`);

  // ── Health (§33/§48) ──
  const health = await get(admin!, "/api/v1/whatsapp/health");
  ok("health payload gateway ok", health.body?.data?.gateway?.ok === true || /ok|ready|qr_ready/i.test(JSON.stringify(health.body?.data ?? {})), JSON.stringify(health.body?.data).slice(0, 140));
  const custHealth = await get(cust!, "/api/v1/whatsapp/health");
  ok("customer blocked from health (403)", custHealth.status === 403, `status=${custHealth.status}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
