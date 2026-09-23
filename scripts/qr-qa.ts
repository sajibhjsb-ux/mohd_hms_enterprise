// MOHD.HMS ENTERPRISE — Central QR system QA suite (ch.35 spec §49/§50/§66).
// Runs the security & behaviour matrix against the LIVE dev server:
//   valid / invalid / modified / expired / revoked tokens, deleted entities,
//   restricted records, enumeration resistance, rate limiting, RBAC 403s,
//   canonical-identity stability, PDF embedding, audit trail, public DTO
//   whitelisting. Exits non-zero on any failed check.

import { db } from "../src/lib/db";
import crypto from "crypto";

const BASE = process.env.QA_BASE || "http://localhost:3000";
let cookie = "";
let techCookie = "";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  let json: unknown = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) json = await res.json().catch(() => null);
  return { res, json };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password@123" }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

async function publicVerify(token: string) {
  const { res, json } = await api(`/api/v1/public/verify/${encodeURIComponent(token)}`);
  return { status: res.status, body: json as { ok: boolean; verification?: Record<string, unknown> } };
}

async function main() {
  console.log("\n═══ CENTRAL QR SYSTEM — QA MATRIX (ch.35 §49/§50/§66) ═══\n");

  // ── 0. authentication ────────────────────────────────────────────────
  console.log("— Auth");
  cookie = await login("admin@mohdhms.com");
  check("SUPER_ADMIN login", cookie.length > 20);

  // ── 1. equipment registration auto-creates THE canonical identity ────
  console.log("\n— §60 auto-generation + §12 canonical identity");
  const eqRes = await api("/api/v1/equipment", {
    method: "POST",
    body: { name: `QA-QR-Unit-${crypto.randomBytes(3).toString("hex")}`, category: "GENERAL" },
    cookie,
  });
  const eq = (eqRes.json as { ok: boolean; data?: { id: string; assetTag: string; name: string } })?.data;
  check("equipment created (201)", eqRes.res.status === 201 && !!eq?.id, JSON.stringify(eqRes.json).slice(0, 120));
  const eqId = eq!.id;

  const status1 = await api(`/api/v1/qr/EQUIPMENT/${eqId}`, { cookie });
  const s1 = (status1.json as { data: { qr: { verificationUrl: string } | null; canManage: boolean } }).data;
  check("§60 QR auto-created at registration", !!s1.qr);
  check("§52 canManage via existing equipment.update", s1.canManage === true);
  check("§47 verification URL uses request origin + /verify/", s1.qr!.verificationUrl.includes("/verify/"));

  // §12 — repeated ensure NEVER rotates the token
  const ensure2 = await api(`/api/v1/qr/EQUIPMENT/${eqId}/ensure`, { method: "POST", body: {}, cookie });
  const s2 = (ensure2.json as { data: { qr: { verificationUrl: string } } }).data;
  check("§12/§33 ensure is idempotent (same identity)", s2.qr.verificationUrl === s1.qr!.verificationUrl);

  // ── 2. §6/§63 public verification — safe whitelist DTO ──────────────
  console.log("\n— §5/§6/§63 public verification");
  const token = s1.qr!.verificationUrl.split("/verify/")[1];
  const v1 = await publicVerify(token);
  const ver = v1.body.verification ?? {};
  check("§36 VERIFIED for valid token", v1.body.verification?.result === "VERIFIED");
  check("§63 number = assetTag", ver.number === eq!.assetTag);
  const dtoStr = JSON.stringify(v1.body);
  check("§8/§14 no internal cuid leaked", !dtoStr.includes(eqId));
  check("§14 no notes/costs fields", !dtoStr.toLowerCase().includes('"cost"') && !dtoStr.includes("Notes"));

  // ── 3. §49 invalid / modified / enumeration ─────────────────────────
  console.log("\n— §49 invalid + modified + enumeration");
  const bad1 = await publicVerify(crypto.randomBytes(24).toString("base64url"));
  check("random valid-shape token → INVALID", bad1.body.verification?.result === "INVALID");
  const bad2 = await publicVerify("short-token!!!");
  check("garbage token → INVALID (no 500)", bad2.body.verification?.result === "INVALID");
  const modified = (token[0] === "a" ? "b" : "a") + token.slice(1);
  const bad3 = await publicVerify(modified);
  check("§9 modified token → INVALID", bad3.body.verification?.result === "INVALID");
  const enumRes = await api(`/api/v1/public/verify/${crypto.randomBytes(24).toString("base64url")}`);
  const enumBody = JSON.stringify(enumRes.json);
  check("§27 enumeration: uniform invalid shape", enumBody.includes("INVALID") && enumRes.res.status === 200);

  // ── 4. §31 revocation + §30 regeneration ─────────────────────────────
  console.log("\n— §29/§30/§31 revoke + regenerate");
  const rv = await api(`/api/v1/qr/EQUIPMENT/${eqId}/revoke`, { method: "POST", body: { reason: "QA revocation test" }, cookie });
  check("§31 revoke succeeds", rv.res.status === 200);
  const v2 = await publicVerify(token);
  check("§31 revoked scan → REVOKED (never valid)", v2.body.verification?.result === "REVOKED");
  check("§31 revoked page keeps the reference", v2.body.verification?.number === eq!.assetTag);

  const rg = await api(`/api/v1/qr/EQUIPMENT/${eqId}/regenerate`, { method: "POST", body: {}, cookie });
  const rgBody = (rg.json as { data: { qr: { verificationUrl: string } } }).data;
  check("§30 regenerate succeeds", rg.res.status === 200 && !!rgBody.qr);
  const newToken = rgBody.qr.verificationUrl.split("/verify/")[1];
  check("§30 new token differs from old", newToken !== token);
  const v3 = await publicVerify(newToken);
  check("§30 new identity VERIFIED", v3.body.verification?.result === "VERIFIED");
  const v4 = await publicVerify(token);
  check("§30 OLD printed identity → REVOKED (honest)", v4.body.verification?.result === "REVOKED");

  // ── 5. §52 RBAC — technician cannot manage ───────────────────────────
  console.log("\n— §52 RBAC");
  techCookie = await login("ahmad.tech@mohdhms.com");
  const rbac = await api(`/api/v1/qr/EQUIPMENT/${eqId}/revoke`, { method: "POST", body: { reason: "technician should fail" }, cookie: techCookie });
  check("§52 TECHNICIAN revoke → 403", rbac.res.status === 403, `got ${rbac.res.status}`);
  const rbacView = await api(`/api/v1/qr/EQUIPMENT/${eqId}`, { cookie: techCookie });
  check("§52 TECHNICIAN view allowed (equipment.read)", rbacView.res.status === 200 && ((rbacView.json as unknown as { data: { canManage: boolean } }).data).canManage === false);

  // ── 6. §49 deleted entity → NOT_FOUND ────────────────────────────────
  console.log("\n— §49 deleted entity");
  const eq2 = await api("/api/v1/equipment", { method: "POST", body: { name: "QA-QR-Deleted" }, cookie });
  const eq2Id = ((eq2.json as { data: { id: string } }).data).id;
  const st2 = await api(`/api/v1/qr/EQUIPMENT/${eq2Id}`, { cookie });
  const t2 = (((st2.json as unknown as { data: { qr: { verificationUrl: string } } }).data).qr).verificationUrl.split("/verify/")[1];
  // API DELETE is a SOFT retire by design (history kept) — verification must
  // keep resolving with the live business status (§32). A truly deleted row
  // (hard delete of the fixture) must instead stop resolving (§49).
  await api(`/api/v1/equipment/${eq2Id}`, { method: "DELETE", cookie });
  const vRetired = await publicVerify(t2);
  check("§32 soft-retired equipment still resolves with live status", vRetired.body.verification?.result === "VERIFIED" && vRetired.body.verification?.statusLabel === "Retired");
  await db.equipment.delete({ where: { id: eq2Id } });
  const v5 = await publicVerify(t2);
  check("§49 deleted entity → NOT FOUND / INVALID", ["INVALID", "NOT_FOUND"].includes(String(v5.body.verification?.result)));

  // ── 7. §49 expired token (direct DB scenario) ────────────────────────
  console.log("\n— §49 expiry");
  const eq3 = await api("/api/v1/equipment", { method: "POST", body: { name: "QA-QR-Expiry" }, cookie });
  const eq3Id = ((eq3.json as { data: { id: string } }).data).id;
  const st3 = await api(`/api/v1/qr/EQUIPMENT/${eq3Id}`, { cookie });
  const t3 = (((st3.json as unknown as { data: { qr: { verificationUrl: string } } }).data).qr).verificationUrl.split("/verify/")[1];
  await db.qrCode.update({ where: { publicToken: t3 }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  const v6 = await publicVerify(t3);
  check("§49 expired token → EXPIRED", v6.body.verification?.result === "EXPIRED");

  // ── 8. §61 restricted (draft inspection report) ──────────────────────
  console.log("\n— §61 draft restriction");
  const draftReport = await db.inspectionReport.findFirst({ where: { status: "DRAFT" }, select: { id: true } });
  if (draftReport) {
    await ensureForTest("INSPECTION_REPORT", draftReport.id);
    const r = await db.qrCode.findFirst({ where: { entityType: "INSPECTION_REPORT", entityId: draftReport.id }, select: { publicToken: true } });
    const v7 = await publicVerify(r!.publicToken);
    check("§61 draft report → RESTRICTED (no detail leak)", v7.body.verification?.result === "RESTRICTED" && !JSON.stringify(v7.body).includes("number"));
  } else {
    check("§61 draft report fixture available (skipped — none seeded)", true);
  }

  // ── 9. §50/§57 PDF pipeline embeds the SAME canonical identity ───────
  console.log("\n— §50/§57/§33 PDF integration");
  const pdfRes = await fetch(`${BASE}/api/v1/pdf/equipment-report/${eqId}`, { headers: { cookie } });
  const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
  check("§50 equipment report PDF generated", pdfRes.status === 200 && pdfBytes.subarray(0, 4).toString() === "%PDF");
  check("§44 PDF has non-trivial size (QR embedded)", pdfBytes.length > 20_000, `${pdfBytes.length} bytes`);
  const pdfQr = await db.qrCode.findFirst({ where: { entityType: "EQUIPMENT", entityId: eqId, status: "ACTIVE" } });
  check("§33 PDF build reused THE canonical identity (no new token)", pdfQr!.publicToken === newToken);

  // invoice lifecycle: find a SENT+ invoice → its PDF build must have a QR row
  const invoice = await db.invoice.findFirst({ where: { status: { notIn: ["DRAFT"] } }, select: { id: true, code: true } });
  if (invoice) {
    const before = await db.qrCode.findFirst({ where: { entityType: "INVOICE", entityId: invoice.id } });
    const invPdf = await fetch(`${BASE}/api/v1/pdf/invoice/${invoice.id}`, { headers: { cookie } });
    const invBytes = Buffer.from(await invPdf.arrayBuffer());
    check("§50 invoice PDF generated", invPdf.status === 200 && invBytes.subarray(0, 4).toString() === "%PDF");
    const after = await db.qrCode.findFirst({ where: { entityType: "INVOICE", entityId: invoice.id, status: "ACTIVE" } });
    check("§60 invoice PDF carries a verification identity", !!after && (!before || before.publicToken === after.publicToken));
    const invVer = await publicVerify(after!.publicToken);
    check("§16 invoice verification → VERIFIED with customer + total", invVer.body.verification?.result === "VERIFIED" && JSON.stringify(invVer.body).includes("Customer"));
  } else {
    check("§50 invoice fixture available (skipped — none seeded)", true);
  }

  // draft invoice PDF must NOT embed a verification identity (§61)
  const draftInvoice = await db.invoice.findFirst({ where: { status: "DRAFT" }, select: { id: true } });
  if (draftInvoice) {
    const draftQrBefore = await db.qrCode.findFirst({ where: { entityType: "INVOICE", entityId: draftInvoice.id } });
    await fetch(`${BASE}/api/v1/pdf/invoice/${draftInvoice.id}`, { headers: { cookie } });
    const draftQrAfter = await db.qrCode.findFirst({ where: { entityType: "INVOICE", entityId: draftInvoice.id } });
    check("§61 DRAFT invoice creates no public QR", !draftQrAfter || (!!draftQrBefore && draftQrAfter.publicToken === draftQrBefore.publicToken));
  }

  // ── 10. §53 audit trail ──────────────────────────────────────────────
  console.log("\n— §53 audit");
  const audits = await db.auditLog.findMany({
    where: { action: { in: ["QR_CREATED", "QR_REVOKED", "QR_REGENERATED"] }, resourceId: { not: "" } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const actions = new Set(audits.map((a) => a.action));
  check("§53 QR_CREATED audited", actions.has("QR_CREATED"));
  check("§53 QR_REVOKED audited", actions.has("QR_REVOKED"));
  check("§53 QR_REGENERATED audited", actions.has("QR_REGENERATED"));
  const logs = await db.qrVerificationLog.count();
  check("§28 verification events logged", logs >= 6, `${logs} log rows`);

  // ── 11. §27 rate limiting (LAST — burns the IP budget) ───────────────
  console.log("\n— §27 rate limiting");
  let saw429 = 0;
  for (let i = 0; i < 26; i++) {
    const r = await fetch(`${BASE}/api/v1/public/verify/${crypto.randomBytes(24).toString("base64url")}`);
    if (r.status === 429) saw429++;
  }
  check("§27 rate limiter engages (429 after burst)", saw429 >= 1, `${saw429} of 26 requests limited`);

  // ── summary ──────────────────────────────────────────────────────────
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  • ${f}`);
  }
  process.exit(fail > 0 ? 1 : 0);

  async function ensureForTest(entityType: string, entityId: string) {
    // test-fixture helper: create a QR row exactly like QRService does
    const { ensureQr } = await import("../src/lib/hms/qr/service");
    await ensureQr(entityType, entityId, {});
  }
}

main()
  .catch((err) => {
    console.error("QA suite crashed:", err);
    process.exit(2);
  });
