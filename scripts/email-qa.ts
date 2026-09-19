// MOHD.HMS ENTERPRISE — Email system end-to-end QA (real API + real DB + real SMTP sink + real MinIO/PDF engine).
//
// Exercises the centralized email system against the running dev server and the
// dev SMTP sink (mini-services/mailflare-dev, SMTP :3095 / HTTP :3096):
//   config + test-connection → credential security → test send → template
//   validation → OTP (anonymous) → automation idempotency → complaint assign →
//   quotation/invoice + PDF attachments → payment receipt → honest failure
//   paths (network failure, backoff, dead-letter, retry/cancel, unresolvable
//   attachment) → rate limit → RBAC → logs API → health → audit → cleanup.
// Prints one PASS/FAIL line per numbered check; exits 1 on any FAIL.
//
// Env facts: dev sink has NO auth and NO TLS (security NONE); Next dev on :3000
// has been OOM-killed twice — GETs tolerate hiccups via small retries.

import { PrismaClient } from "@prisma/client";

const BASE = "http://127.0.0.1:3000";
const SINK = "http://127.0.0.1:3096";
const db = new PrismaClient();

const PASSWORD = "qa-secret-123";
const TEST_TO = "qa-inbox@test.local";
const SERVICE_MAILBOX = "qa-service@test.local";
const CUSTOMER_EMAIL = "ops@sunrisemall.my"; // seeded CUS-0001 Sunrise Mall
const TECH_EMAIL = "ahmad.tech@mohdhms.com";
const ADMIN_EMAIL = "operations@mohdhms.com";

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — ${detail}`}`);
  if (ok) passes += 1;
  else failures += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ");

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

/** GET with small retry — tolerates dev-server hiccups (502/reset during recompile). */
async function getRetry(url: string, init?: RequestInit, tries = 3): Promise<{ status: number; json: any }> {
  let last = { status: 0, json: null as any };
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchJson(url, init);
      if (r.status < 500) return r;
      last = r;
    } catch { /* retry */ }
    await sleep(1500);
  }
  return last;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const cookie = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session="));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

type ApiResult = { status: number; json: any };
async function api(cookie: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  return fetchJson(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function sink(path: string): Promise<any> {
  const res = await fetch(`${SINK}${path}`, { signal: AbortSignal.timeout(10_000) });
  return res.json().catch(() => null);
}
async function sinkFullData(id: string): Promise<string> {
  const j = await sink(`/messages/${encodeURIComponent(id)}`);
  return j?.message?.data ?? "";
}

async function pollUntil<T>(fn: () => Promise<T | null>, timeoutMs: number, stepMs = 2000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  return null;
}

const SINK_CONFIG = {
  smtpHost: "127.0.0.1", smtpPort: 3095, smtpSecurity: "NONE",
  fromName: "MOHD.HMS QA", fromEmail: "qa@mohd-hms.test",
  testRecipient: TEST_TO, timeoutMs: 5000,
};
const BAD_CONFIG = { smtpHost: "127.0.0.1", smtpPort: 3099, timeoutMs: 1500 };

async function main() {
  const RUN_STARTED = new Date(Date.now() - 5000);
  console.log("── 0. LOGIN ───────────────────────────────────────────────");
  const admin = await login(ADMIN_EMAIL, "Password@123");
  const superAdmin = await login("admin@mohdhms.com", "Password@123");
  const customer = await login("customer1@demo.my", "Password@123");
  const technician = await login(TECH_EMAIL, "Password@123");
  const finance = await login("finance@mohdhms.com", "Password@123");
  check("ADMIN/SUPER_ADMIN/CUSTOMER/TECHNICIAN/FINANCE logins", true);

  const adminUser = await db.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true } });
  const cust = await db.customer.findFirst({ where: { code: "CUS-0001" }, select: { id: true, email: true } });
  const techProfile = await db.technicianProfile.findFirst({ where: { user: { email: TECH_EMAIL } }, select: { id: true, userId: true } });
  check("seeded customer + technician profile exist", !!cust && !!techProfile, JSON.stringify({ cust: !!cust, tech: !!techProfile }));
  if (!adminUser || !cust || !techProfile) throw new Error("seed data missing");

  // ── 1. SMTP test-connection ────────────────────────────────────────────────
  console.log("── 1. SMTP CONFIG + TEST-CONNECTION (§27/§70) ─────────────");
  const patch1 = await api(admin, "PATCH", "/api/v1/email/config", { ...SINK_CONFIG, smtpPassword: PASSWORD });
  check("1.1 PATCH email config (200)", patch1.status === 200, `status=${patch1.status} ${JSON.stringify(patch1.json)}`);
  const chanOn = await api(admin, "PUT", "/api/v1/automation/settings", { settings: { email_notifications: "on" } });
  check("1.2 enable email channel (200)", chanOn.status === 200, `status=${chanOn.status} ${JSON.stringify(chanOn.json)}`);
  const chanDb = await db.setting.findUnique({ where: { key: "automation.email_notifications" } });
  check("1.3 channel setting persisted as on", chanDb?.value === "on", `value=${chanDb?.value}`);
  const conn = await api(admin, "POST", "/api/v1/email/config/test-connection", {});
  check("1.4 test-connection ok:true", conn.status === 200 && conn.json?.data?.ok === true, `status=${conn.status} ${JSON.stringify(conn.json)}`);
  check("1.5 detail mentions successful", /successful/i.test(String(conn.json?.data?.detail ?? "")), String(conn.json?.data?.detail));

  // ── 2. Credential security (§4/§59) ────────────────────────────────────────
  console.log("── 2. CREDENTIAL SECURITY — password never leaks ──────────");
  const cfgGet = await api(admin, "GET", "/api/v1/email/config");
  const cfgStr = JSON.stringify(cfgGet.json);
  check("2.1 GET config hasPassword=true", cfgGet.json?.data?.hasPassword === true);
  check("2.2 GET config response does NOT contain the password", !cfgStr.includes(PASSWORD));
  const cfgRow = await db.emailConfig.findUnique({ where: { id: "singleton" } });
  check("2.3 DB smtpSecretEnc starts with v1:", !!cfgRow?.smtpSecretEnc.startsWith("v1:"), cfgRow?.smtpSecretEnc.slice(0, 12));
  check("2.4 DB smtpSecretEnc does NOT contain the password", !cfgRow?.smtpSecretEnc.includes(PASSWORD));
  const audits = await db.auditLog.findMany({ where: { action: "EMAIL_CONFIG_UPDATED" } });
  check("2.5 audit EMAIL_CONFIG_UPDATED rows never contain the password", audits.every((a) => !JSON.stringify(a).includes(PASSWORD)), `${audits.length} rows`);

  // ── 3. Test email (§28/§44) ────────────────────────────────────────────────
  console.log("── 3. TEST EMAIL → SINK ───────────────────────────────────");
  const inboxBefore = (await sink(`/messages?to=${encodeURIComponent(TEST_TO)}`))?.count ?? 0;
  const t0 = new Date();
  const testSend = await api(admin, "POST", "/api/v1/email/config/test-send", {});
  check("3.1 test-send ok:true", testSend.status === 200 && testSend.json?.data?.ok === true, `status=${testSend.status} ${JSON.stringify(testSend.json)}`);
  check("3.2 detail mentions accepted", /accepted/i.test(String(testSend.json?.data?.detail ?? "")), String(testSend.json?.data?.detail));
  const testLog = await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { isTest: true, createdAt: { gte: t0 } },
      orderBy: { createdAt: "desc" },
    });
    return row?.status === "SENT" ? row : null;
  }, 20_000);
  check("3.3 DB EmailLog isTest=true status=SENT", !!testLog, JSON.stringify(testLog ? { status: testLog.status } : "no SENT row"));
  check("3.4 SENT row has messageId + providerResponse", !!testLog?.messageId && !!testLog?.providerResponse, `${testLog?.messageId} / ${testLog?.providerResponse?.slice(0, 40)}`);
  const after3 = await pollUntil(async () => {
    const j = await sink(`/messages?to=${encodeURIComponent(TEST_TO)}`);
    return (j?.count ?? 0) > inboxBefore ? j : null;
  }, 15_000);
  check("3.5 sink message count increased", !!after3, `before=${inboxBefore}`);
  const sinkMsgs = (after3?.messages ?? []) as any[];
  const newest = sinkMsgs[sinkMsgs.length - 1];
  const raw = newest ? await sinkFullData(newest.id) : "";
  check("3.6 raw DATA has Subject: header line", /^Subject:/m.test(raw), raw.slice(0, 80));
  check("3.7 body contains MOHD.HMS branding", raw.includes("MOHD.HMS"));
  check("3.8 body mentions SMTP (test content)", raw.includes("SMTP"));
  check("3.9 cid logo attachment present (Content-ID header)", raw.includes("Content-ID") && raw.includes("mohd-hms-logo"));

  // ── 4. Template validation (§11) ───────────────────────────────────────────
  console.log("── 4. TEMPLATE VALIDATION — XSS + unknown variables ───────");
  const tplList = await api(admin, "GET", "/api/v1/email/templates?search=INVOICE_SENT");
  const invoiceTpl = (tplList.json?.data ?? []).find((t: any) => t.key === "INVOICE_SENT");
  check("4.1 INVOICE_SENT template found", !!invoiceTpl);
  if (invoiceTpl) {
    const origSubject = invoiceTpl.subject as string;
    const origBody = invoiceTpl.bodyHtml as string;
    const badVar = await api(admin, "PATCH", `/api/v1/email/templates/${invoiceTpl.id}`, {
      subject: `${origSubject} {{UNKNOWN_VAR_XY}}`,
    });
    check("4.2 unknown subject variable rejected (400)", badVar.status === 400, `status=${badVar.status} ${JSON.stringify(badVar.json).slice(0, 150)}`);
    check("4.3 error mentions the variable", JSON.stringify(badVar.json).includes("UNKNOWN_VAR_XY"));
    const badScript = await api(admin, "PATCH", `/api/v1/email/templates/${invoiceTpl.id}`, {
      bodyHtml: "<script>alert(1)</script><p>x</p>",
    });
    check("4.4 script tag rejected (400)", badScript.status === 400, `status=${badScript.status}`);
    check("4.5 error mentions script", /script/i.test(JSON.stringify(badScript.json)));
    const restore = await api(admin, "PATCH", `/api/v1/email/templates/${invoiceTpl.id}`, { subject: origSubject, bodyHtml: origBody });
    check("4.6 original content restored", restore.status === 200, `status=${restore.status}`);
  }

  // ── 5. OTP email (§45) — anonymous forgot-password ─────────────────────────
  console.log("── 5. OTP EMAIL — anonymous forgot-password ───────────────");
  const priorOtp = await db.emailLog.findFirst({
    where: { templateKey: "PASSWORD_RESET_OTP", status: "SENT", sentAt: { gte: new Date(Date.now() - 5 * 60_000) } },
    orderBy: { sentAt: "desc" },
  });
  const forgot = await fetchJson(`${BASE}/api/v1/auth/forgot-password`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: ADMIN_EMAIL }),
  });
  check("5.1 forgot-password accepted (200) or honest cooldown (429)", forgot.status === 200 || forgot.status === 429, `status=${forgot.status}`);
  let otpLog = null as any;
  if (forgot.status === 200) {
    otpLog = await pollUntil(async () => {
      const row = await db.emailLog.findFirst({
        where: { templateKey: "PASSWORD_RESET_OTP", status: "SENT", toEmail: ADMIN_EMAIL, sentAt: { gte: RUN_STARTED } },
        orderBy: { sentAt: "desc" },
      });
      return row ?? null;
    }, 30_000);
  } else if (priorOtp) {
    console.log("   (resend cooldown active — asserting the recent real send instead)");
    otpLog = priorOtp;
  }
  check("5.2 DB EmailLog PASSWORD_RESET_OTP status=SENT", !!otpLog, otpLog ? `${otpLog.status}` : "no row");
  const otpInbox = await sink(`/messages?to=${encodeURIComponent(ADMIN_EMAIL)}`);
  const otpMsgs = ((otpInbox?.messages ?? []) as any[]).filter((m) => new Date(m.receivedAt).getTime() > Date.now() - 6 * 60_000);
  const otpRaw = otpMsgs.length ? await sinkFullData(otpMsgs[otpMsgs.length - 1].id) : "";
  const codeMatch = /\b(\d{6})\b/.exec(stripTags(otpRaw));
  check("5.3 sink OTP message contains a 6-digit code", !!codeMatch, `msgs=${otpMsgs.length}`);
  check("5.4 message says it expires in 10 minutes", stripTags(otpRaw).includes("expires in 10 minutes"));
  const otpRow = await db.emailOtp.findUnique({
    where: { userId_purpose: { userId: adminUser.id, purpose: "PASSWORD_RESET" } },
  });
  check("5.5 OTP row stores hash only (never the plaintext code)", !!otpRow && !!codeMatch && otpRow.codeHash !== codeMatch[1] && !JSON.stringify(otpRow).includes(codeMatch[1]));

  // ── 6. Automation — complaint created → service mailbox + idempotency (§35) ─
  console.log("── 6. AUTOMATION — COMPLAINT_CREATED → MODULE_MAILBOX ─────");
  const setMailbox = await api(admin, "PUT", "/api/v1/settings", { values: { company_email_service: SERVICE_MAILBOX } });
  check("6.1 company_email_service setting saved (200)", setMailbox.status === 200, `status=${setMailbox.status}`);
  const complaintRes = await api(admin, "POST", "/api/v1/complaints", {
    title: "Email QA complaint",
    description: "Complaint created by the automated email QA to exercise COMPLAINT_CREATED automations.",
    priority: "HIGH",
    customerId: cust.id,
  });
  check("6.2 complaint created (201)", complaintRes.status === 201 || complaintRes.status === 200, `status=${complaintRes.status} ${JSON.stringify(complaintRes.json).slice(0, 200)}`);
  const complaint = complaintRes.json?.data;
  check("6.3 complaint has id + code", !!complaint?.id && !!complaint?.code);
  const event6 = await db.domainEvent.findFirst({
    where: { type: "COMPLAINT_CREATED", resourceId: complaint.id },
    orderBy: { createdAt: "desc" },
  });
  check("6.4 DomainEvent COMPLAINT_CREATED emitted", !!event6);
  const autoLog = event6 ? await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { eventId: event6.id, automationId: { not: null }, templateKey: "COMPLAINT_CREATED", status: "SENT", toEmail: SERVICE_MAILBOX },
    });
    return row ?? null;
  }, 45_000) : null;
  check("6.5 EmailLog SENT to service mailbox (automation queued it)", !!autoLog, autoLog ? `${autoLog.status}/${autoLog.toEmail}` : "no row in 45s");
  const svcInbox = await pollUntil(async () => {
    const j = await sink(`/messages?to=${encodeURIComponent(SERVICE_MAILBOX)}`);
    return (j?.count ?? 0) > 0 ? j : null;
  }, 10_000);
  check("6.6 sink received the automation email", !!svcInbox);
  // Idempotency: requeue the SAME event — the engine must not produce a second email.
  if (event6) {
    await db.domainEvent.update({
      where: { id: event6.id },
      data: { status: "PENDING", nextAttemptAt: new Date() },
    });
    await sleep(12_000);
    const logCount = await db.emailLog.count({ where: { eventId: event6.id, automationId: { not: null } } });
    check("6.7 EmailLog count for (event, automation) STILL 1 after requeue", logCount === 1, `count=${logCount}`);
    const successRun = await db.workflowRun.findFirst({
      where: { eventId: event6.id, workflow: "EMAIL_AUTOMATION", result: "SUCCESS" },
    });
    check("6.8 workflowRun SUCCESS row exists (engine idempotency skipped re-run)", !!successRun, successRun ? successRun.detail.slice(0, 60) : "no SUCCESS run");
  }

  // ── 7. Complaint assigned → technician (§48) ───────────────────────────────
  console.log("── 7. COMPLAINT_ASSIGNED → TECHNICIAN ─────────────────────");
  const assign = await api(admin, "POST", `/api/v1/complaints/${complaint.id}/transition`, {
    action: "assign", technicianId: techProfile.id, note: "Email QA assignment",
  });
  check("7.1 complaint assigned (200)", assign.status === 200, `status=${assign.status} ${JSON.stringify(assign.json).slice(0, 160)}`);
  const techLog = await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { templateKey: "COMPLAINT_ASSIGNED", status: "SENT", toEmail: TECH_EMAIL, sentAt: { gte: RUN_STARTED } },
      orderBy: { sentAt: "desc" },
    });
    return row ?? null;
  }, 45_000);
  check("7.2 EmailLog COMPLAINT_ASSIGNED SENT to technician", !!techLog, techLog ? "sent" : "no row in 45s");
  const techInbox = await pollUntil(async () => {
    const j = await sink(`/messages?to=${encodeURIComponent(TECH_EMAIL)}`);
    const ms = (j?.messages ?? []) as any[];
    return ms.length > 0 ? ms : null;
  }, 10_000);
  // Other flows can also mail the technician — check the newest few messages for the code.
  let techRaw = "";
  for (const m of (techInbox ?? []).slice(-3).reverse()) {
    techRaw += "\n" + (await sinkFullData(m.id));
  }
  check("7.3 sink message to technician contains the complaint code", !!complaint?.code && techRaw.includes(complaint.code));

  // ── 8. Quotation → customer + PDF (§46) ────────────────────────────────────
  console.log("── 8. QUOTATION_SENT → CUSTOMER + PDF ATTACHMENT ──────────");
  const quo = await api(admin, "POST", "/api/v1/quotations", {
    customerId: cust.id,
    items: [{ kind: "SERVICE", description: "Email QA — quarterly inspection service", quantity: 2, unitPrice: 150 }],
  });
  check("8.1 quotation created (201)", quo.status === 201, `status=${quo.status} ${JSON.stringify(quo.json).slice(0, 160)}`);
  const quoId = quo.json?.data?.id;
  const quoSend = quoId ? await api(admin, "POST", `/api/v1/quotations/${quoId}/transition`, { action: "send" }) : { status: 0, json: null };
  check("8.2 quotation sent (200)", quoSend.status === 200, `status=${quoSend.status} ${JSON.stringify(quoSend.json).slice(0, 160)}`);
  const quoLog = await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { templateKey: "QUOTATION_SENT", status: "SENT", toEmail: CUSTOMER_EMAIL, sentAt: { gte: RUN_STARTED } },
      orderBy: { sentAt: "desc" },
    });
    return row ?? null;
  }, 45_000);
  check("8.3 EmailLog QUOTATION_SENT SENT to customer", !!quoLog, quoLog ? "sent" : "no row in 45s");
  const quoRefs = JSON.parse(quoLog?.attachmentRefs ?? "[]");
  check("8.4 attachmentRefs contains QUOTATION_PDF", Array.isArray(quoRefs) && quoRefs.some((r: any) => r.kind === "QUOTATION_PDF"), JSON.stringify(quoRefs).slice(0, 120));
  check("8.5 providerResponse non-empty (acceptance evidence)", !!quoLog?.providerResponse);
  const quoSink = await pollUntil(async () => {
    const j = await sink(`/messages?to=${encodeURIComponent(CUSTOMER_EMAIL)}`);
    const ms = (j?.messages ?? []) as any[];
    for (const m of ms.reverse()) {
      const data = await sinkFullData(m.id);
      if (data.includes("application/pdf") && /invoice|quotation/i.test(data)) return { data, size: m.size };
    }
    return null;
  }, 45_000);
  check("8.6 sink message carries the PDF (multipart application/pdf)", !!quoSink, quoSink ? `size=${quoSink.size}` : "no PDF message");

  // ── 9. Invoice → customer + PDF (§47) ──────────────────────────────────────
  console.log("── 9. INVOICE_SENT → CUSTOMER + PDF ATTACHMENT ────────────");
  const inv = await api(admin, "POST", "/api/v1/invoices", {
    customerId: cust.id,
    items: [{ kind: "SERVICE", description: "Email QA — maintenance visit", quantity: 1, unitPrice: 400 }],
  });
  check("9.1 invoice created (201)", inv.status === 201, `status=${inv.status} ${JSON.stringify(inv.json).slice(0, 160)}`);
  const invId = inv.json?.data?.id;
  const invSend = invId ? await api(admin, "POST", `/api/v1/invoices/${invId}/transition`, { action: "send" }) : { status: 0, json: null };
  check("9.2 invoice sent (200)", invSend.status === 200, `status=${invSend.status} ${JSON.stringify(invSend.json).slice(0, 160)}`);
  const invLog = await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { templateKey: "INVOICE_SENT", status: "SENT", toEmail: CUSTOMER_EMAIL, sentAt: { gte: RUN_STARTED } },
      orderBy: { sentAt: "desc" },
    });
    return row ?? null;
  }, 45_000);
  check("9.3 EmailLog INVOICE_SENT SENT to customer", !!invLog, invLog ? "sent" : "no row in 45s");
  const invRefs = JSON.parse(invLog?.attachmentRefs ?? "[]");
  check("9.4 attachmentRefs contains INVOICE_PDF", Array.isArray(invRefs) && invRefs.some((r: any) => r.kind === "INVOICE_PDF"), JSON.stringify(invRefs).slice(0, 120));
  const invSink = await pollUntil(async () => {
    const j = await sink(`/messages?to=${encodeURIComponent(CUSTOMER_EMAIL)}`);
    const ms = (j?.messages ?? []) as any[];
    for (const m of ms.reverse()) {
      const data = await sinkFullData(m.id);
      if (data.includes("application/pdf") && /invoice/i.test(data)) return { data, size: m.size };
    }
    return null;
  }, 45_000);
  check("9.5 sink invoice message carries the PDF", !!invSink, invSink ? `size=${invSink.size}` : "no PDF message");

  // ── 10. Payment receipt (§47) ──────────────────────────────────────────────
  console.log("── 10. PAYMENT_RECEIVED → CUSTOMER RECEIPT ────────────────");
  const pay = invId ? await api(admin, "POST", `/api/v1/invoices/${invId}/payments`, { amount: 50, method: "CASH" }) : { status: 0, json: null };
  check("10.1 payment recorded", [200, 201].includes(pay.status), `status=${pay.status} ${JSON.stringify(pay.json).slice(0, 160)}`);
  const payLog = await pollUntil(async () => {
    const row = await db.emailLog.findFirst({
      where: { templateKey: "PAYMENT_RECEIVED", status: "SENT", toEmail: CUSTOMER_EMAIL, sentAt: { gte: RUN_STARTED } },
      orderBy: { sentAt: "desc" },
    });
    return row ?? null;
  }, 45_000);
  check("10.2 EmailLog PAYMENT_RECEIVED SENT to customer", !!payLog, payLog ? "sent" : "no row in 45s");

  // ── 11. Honest failure — network error, backoff, retry (§36/§37/§70) ──────
  console.log("── 11. HONEST FAILURE — CLOSED PORT, BACKOFF, RETRY ───────");
  await api(admin, "PATCH", "/api/v1/email/config", BAD_CONFIG);
  const failSend = await api(admin, "POST", "/api/v1/email/config/test-send", {});
  check("11.1 test-send honestly reports failure (ok:false)", failSend.status === 200 && failSend.json?.data?.ok === false, `status=${failSend.status} ${JSON.stringify(failSend.json).slice(0, 160)}`);
  const failLog = await db.emailLog.findFirst({
    where: { isTest: true, status: { not: "SENT" }, createdAt: { gte: new Date(Date.now() - 30_000) } },
    orderBy: { createdAt: "desc" },
  });
  check("11.2 failed test row is NOT SENT", !!failLog && failLog.status !== "SENT", failLog?.status ?? "no row");
  check("11.3 failure classified NETWORK/TEMPORARY/PROVIDER", !!failLog && ["NETWORK", "TEMPORARY", "PROVIDER"].includes(failLog.errorClass), failLog?.errorClass);
  // worker path: direct QUEUED row must burn an attempt and schedule a backoff — never fake SENT
  const backoffRow = await db.emailLog.create({
    data: {
      status: "QUEUED", eventId: "", automationId: null, templateKey: "GENERAL_NOTIFICATION",
      templateVersion: 0, category: "SYSTEM", toEmail: TEST_TO, fromName: "MOHD.HMS QA", fromEmail: "qa@mohd-hms.test",
      subject: "QA backoff probe", bodyHtml: "<p>backoff probe</p>", maxAttempts: 3, scheduledAt: new Date(),
    },
  });
  await pollUntil(async () => {
    const row = await db.emailLog.findUnique({ where: { id: backoffRow.id } });
    return row && row.attemptCount > 0 ? row : null;
  }, 30_000);
  const backoffAfter = await db.emailLog.findUnique({ where: { id: backoffRow.id } });
  check("11.4 backoff row NOT SENT after failed attempt", !!backoffAfter && backoffAfter.status !== "SENT", backoffAfter?.status);
  check("11.5 backoff row attemptCount>0 + errorClass set", !!backoffAfter && backoffAfter.attemptCount > 0 && ["NETWORK", "TEMPORARY", "PROVIDER"].includes(backoffAfter.errorClass), `attempts=${backoffAfter?.attemptCount} class=${backoffAfter?.errorClass}`);
  check("11.6 backoff scheduled in the future", !!backoffAfter && !!backoffAfter.scheduledAt && backoffAfter.scheduledAt.getTime() > Date.now() - 1000, String(backoffAfter?.scheduledAt));
  // restore the sink and retry the SAME row (verify refresh also busts any stale transport)
  await api(admin, "PATCH", "/api/v1/email/config", SINK_CONFIG);
  await api(admin, "POST", "/api/v1/email/config/test-connection", {});
  const retryRes = await api(admin, "POST", `/api/v1/email/logs/${backoffRow.id}/retry`, {});
  check("11.7 retry accepted after config fix", retryRes.status === 200, `status=${retryRes.status} ${JSON.stringify(retryRes.json).slice(0, 120)}`);
  const retriedSent = await pollUntil(async () => {
    const row = await db.emailLog.findUnique({ where: { id: backoffRow.id } });
    return row?.status === "SENT" ? row : null;
  }, 90_000);
  check("11.8 retried row reaches SENT", !!retriedSent, retriedSent ? "sent" : "not sent in 90s");
  const retrySentAgain = await api(admin, "POST", `/api/v1/email/logs/${backoffRow.id}/retry`, {});
  check("11.9 retry on SENT refused (400) — no duplicate send", retrySentAgain.status === 400, `status=${retrySentAgain.status}`);

  // ── 12. Dead-letter (§36) ──────────────────────────────────────────────────
  console.log("── 12. DEAD-LETTER AFTER EXHAUSTED ATTEMPTS ───────────────");
  await api(admin, "PATCH", "/api/v1/email/config", BAD_CONFIG);
  const deadRow = await db.emailLog.create({
    data: {
      status: "QUEUED", eventId: "", automationId: null, templateKey: "GENERAL_NOTIFICATION",
      templateVersion: 0, category: "SYSTEM", toEmail: TEST_TO, fromName: "MOHD.HMS QA", fromEmail: "qa@mohd-hms.test",
      subject: "QA dead-letter probe", bodyHtml: "<p>dead letter probe</p>", maxAttempts: 1, scheduledAt: new Date(),
    },
  });
  const deadAfter = await pollUntil(async () => {
    const row = await db.emailLog.findUnique({ where: { id: deadRow.id } });
    return row?.status === "DEAD_LETTER" ? row : null;
  }, 30_000);
  check("12.1 exhausted row reaches DEAD_LETTER", !!deadAfter, deadAfter?.status ?? (await db.emailLog.findUnique({ where: { id: deadRow.id } }))?.status ?? "timeout");
  check("12.2 dead-letter carries errorClass + lastError", !!deadAfter && !!deadAfter.errorClass && !!deadAfter.lastError, `${deadAfter?.errorClass}: ${deadAfter?.lastError.slice(0, 60)}`);
  await api(admin, "PATCH", "/api/v1/email/config", SINK_CONFIG);

  // ── 13. Cancel (§37) ───────────────────────────────────────────────────────
  console.log("── 13. CANCEL QUEUED EMAIL ────────────────────────────────");
  const cancelRow = await db.emailLog.create({
    data: {
      status: "QUEUED", eventId: "", automationId: null, templateKey: "GENERAL_NOTIFICATION",
      templateVersion: 0, category: "SYSTEM", toEmail: TEST_TO, fromName: "MOHD.HMS QA", fromEmail: "qa@mohd-hms.test",
      subject: "QA cancel probe", bodyHtml: "<p>cancel probe</p>", maxAttempts: 3, scheduledAt: new Date(Date.now() + 3_600_000),
    },
  });
  const cancelRes = await api(admin, "POST", `/api/v1/email/logs/${cancelRow.id}/cancel`, {});
  check("13.1 cancel accepted (200)", cancelRes.status === 200, `status=${cancelRes.status}`);
  const canceledRow = await db.emailLog.findUnique({ where: { id: cancelRow.id } });
  check("13.2 row status CANCELED", canceledRow?.status === "CANCELED", canceledRow?.status);
  const retryCanceled = await api(admin, "POST", `/api/v1/email/logs/${cancelRow.id}/retry`, {});
  const afterCancelRetry = await db.emailLog.findUnique({ where: { id: cancelRow.id } });
  check("13.3 retry on CANCELED returns ok / back to QUEUED", retryCanceled.status === 200 && afterCancelRetry?.status === "QUEUED", `status=${retryCanceled.status} row=${afterCancelRetry?.status}`);
  const recancel = await api(admin, "POST", `/api/v1/email/logs/${cancelRow.id}/cancel`, {});
  const finalCancelState = await db.emailLog.findUnique({ where: { id: cancelRow.id } });
  check("13.4 re-canceled for clean state", recancel.status === 200 && finalCancelState?.status === "CANCELED", finalCancelState?.status);

  // ── 14. Missing attachment honest failure (§22) ────────────────────────────
  console.log("── 14. UNRESOLVABLE ATTACHMENT → HONEST FAILURE ───────────");
  const qaAutomation = await db.emailAutomation.create({
    data: {
      name: `QA bad attachment ${Date.now()}`,
      eventType: "COMPLAINT_CREATED", templateKey: "INVOICE_SENT",
      recipientRule: JSON.stringify({ kind: "MODULE_MAILBOX", value: "company_email_service" }),
      attachments: JSON.stringify([{ kind: "INVOICE_PDF" }]),
      enabled: true,
    },
  });
  check("14.1 QA automation row created", !!qaAutomation.id);
  const badAttRow = await db.emailLog.create({
    data: {
      status: "QUEUED", eventId: "", automationId: null, templateKey: "GENERAL_NOTIFICATION",
      templateVersion: 0, category: "SYSTEM", toEmail: TEST_TO, fromName: "MOHD.HMS QA", fromEmail: "qa@mohd-hms.test",
      subject: "QA bad attachment probe", bodyHtml: "<p>bad attachment probe</p>", maxAttempts: 1, scheduledAt: new Date(),
      attachmentRefs: JSON.stringify([{ kind: "LETTER_PDF" }]),
      relatedType: "COMPLAINT", relatedId: complaint.id,
    },
  });
  const badAttAfter = await pollUntil(async () => {
    const row = await db.emailLog.findUnique({ where: { id: badAttRow.id } });
    return row && (row.status === "DEAD_LETTER" || row.status === "FAILED") ? row : null;
  }, 30_000);
  check("14.2 unresolvable attachment fails the send (DEAD_LETTER/FAILED)", !!badAttAfter, badAttAfter?.status ?? "still queued");
  check("14.3 lastError mentions the attachment", !!badAttAfter && /attachment/i.test(badAttAfter.lastError), badAttAfter?.lastError.slice(0, 80));
  check("14.4 errorClass PERMANENT (never retried into a broken send)", !!badAttAfter && badAttAfter.errorClass === "PERMANENT", badAttAfter?.errorClass);
  await db.emailAutomation.delete({ where: { id: qaAutomation.id } });
  check("14.5 QA automation row deleted", true);

  // ── 15. Rate limit (§39) ───────────────────────────────────────────────────
  console.log("── 15. PER-AUTOMATION HOURLY RATE LIMIT ───────────────────");
  await api(admin, "PUT", "/api/v1/automation/settings", { settings: { email_max_per_automation_hour: "1" } });
  const rlA = await api(admin, "POST", "/api/v1/complaints", {
    title: `Email QA rate limit A ${Date.now()}`,
    description: "Rate-limit probe complaint A.", priority: "MEDIUM", customerId: cust.id,
  });
  await sleep(1500); // distinct submissions (dedupe guard)
  const rlB = await api(admin, "POST", "/api/v1/complaints", {
    title: `Email QA rate limit B ${Date.now()}`,
    description: "Rate-limit probe complaint B.", priority: "MEDIUM", customerId: cust.id,
  });
  check("15.1 both probe complaints created", [rlA.status, rlB.status].every((s) => s === 201 || s === 200), `${rlA.status}/${rlB.status}`);
  await sleep(14_000); // let the engine process both events
  const rlEventIds = [
    (rlA.json?.data?.id ? await db.domainEvent.findFirst({ where: { type: "COMPLAINT_CREATED", resourceId: rlA.json.data.id }, orderBy: { createdAt: "desc" } }) : null)?.id,
    (rlB.json?.data?.id ? await db.domainEvent.findFirst({ where: { type: "COMPLAINT_CREATED", resourceId: rlB.json.data.id }, orderBy: { createdAt: "desc" } }) : null)?.id,
  ].filter(Boolean) as string[];
  const rlRuns = await db.workflowRun.findMany({ where: { eventId: { in: rlEventIds }, workflow: "EMAIL_AUTOMATION" } });
  const rlLimited = rlRuns.some((r) => /rate limited/i.test(r.detail));
  const rlNewLogs = await db.emailLog.count({ where: { eventId: { in: rlEventIds }, automationId: { not: null } } });
  check("15.2 rate limit engaged (workflow detail says so / no new sends)", rlLimited || rlNewLogs === 0, `runs=${JSON.stringify(rlRuns.map((r) => r.detail.slice(0, 50)))} newLogs=${rlNewLogs}`);
  await api(admin, "PUT", "/api/v1/automation/settings", { settings: { email_max_per_automation_hour: "60" } });
  check("15.3 hourly cap restored to 60", true);

  // ── 16. RBAC (§58) ─────────────────────────────────────────────────────────
  console.log("── 16. RBAC — EMAIL ADMIN IS ADMIN-ONLY ───────────────────");
  for (const [name, cookie] of [["CUSTOMER", customer], ["TECHNICIAN", technician], ["FINANCE", finance]] as const) {
    const g = await api(cookie, "GET", "/api/v1/email/config");
    const p = await api(cookie, "PATCH", "/api/v1/email/config", { testRecipient: "x@y.z" });
    const l = await api(cookie, "GET", "/api/v1/email/logs");
    check(`16.${name} GET config 403`, g.status === 403, `status=${g.status}`);
    check(`16.${name} PATCH config 403`, p.status === 403, `status=${p.status}`);
    check(`16.${name} GET logs 403`, l.status === 403, `status=${l.status}`);
  }
  check("16.ADMIN GET config 200", (await api(admin, "GET", "/api/v1/email/config")).status === 200);
  check("16.SUPER_ADMIN GET logs 200", (await api(superAdmin, "GET", "/api/v1/email/logs")).status === 200);

  // ── 17. Logs API (§30/§31) ─────────────────────────────────────────────────
  console.log("── 17. LOGS API — FILTERS + DETAIL ────────────────────────");
  const sentInvoices = await api(admin, "GET", "/api/v1/email/logs?status=SENT&category=INVOICES");
  const sentInvoiceRows = sentInvoices.json?.data ?? [];
  check("17.1 status+category filter: rows all SENT/INVOICES", sentInvoices.status === 200 && sentInvoiceRows.length > 0 && sentInvoiceRows.every((r: any) => r.status === "SENT" && r.category === "INVOICES"), `rows=${sentInvoiceRows.length}`);
  const detailRes = invLog ? await api(admin, "GET", `/api/v1/email/logs/${invLog.id}`) : { status: 0, json: null };
  const detail = detailRes.json?.data;
  check("17.2 log detail (200)", detailRes.status === 200, `status=${detailRes.status}`);
  check("17.3 detail bodyHtml present (fresh row) or bodyPruned", !!detail && (typeof detail.bodyHtml === "string" && detail.bodyHtml.length > 0 || detail.bodyPruned === true));
  check("17.4 detail attachmentRefs is a parsed array", !!detail && Array.isArray(detail.attachmentRefs) && detail.attachmentRefs.some((r: any) => r.kind === "INVOICE_PDF"), JSON.stringify(detail?.attachmentRefs).slice(0, 100));
  check("17.5 detail automation joined (name)", !!detail?.automation?.name, detail?.automation?.name);
  const recip = await api(admin, "GET", `/api/v1/email/logs?recipient=${encodeURIComponent(CUSTOMER_EMAIL)}`);
  const recipRows = recip.json?.data ?? [];
  check("17.6 recipient filter matches", recip.status === 200 && recipRows.length > 0 && recipRows.every((r: any) => r.toEmail.includes(CUSTOMER_EMAIL)), `rows=${recipRows.length}`);
  const tplFilter = await api(admin, "GET", "/api/v1/email/logs?template=INVOICE_SENT");
  check("17.7 template filter matches", tplFilter.status === 200 && ((tplFilter.json?.data ?? []) as any[]).every((r) => r.templateKey === "INVOICE_SENT"));

  // ── 18. Health (§29) — real counters only ──────────────────────────────────
  console.log("── 18. HEALTH DASHBOARD — REAL VALUES ─────────────────────");
  await api(admin, "POST", "/api/v1/email/config/test-connection", {}); // refresh lastVerify after restore
  const health = await api(admin, "GET", "/api/v1/email/health");
  const h = health.json?.data ?? {};
  check("18.1 health (200)", health.status === 200, `status=${health.status}`);
  check("18.2 sentToday > 0", h.sentToday > 0, `sentToday=${h.sentToday}`);
  check("18.3 failedToday >= 1 (honest failures counted)", h.failedToday >= 1, `failedToday=${h.failedToday}`);
  check("18.4 queued >= 0", typeof h.queued === "number" && h.queued >= 0, `queued=${h.queued}`);
  check("18.5 smtp.configured true", h.smtp?.configured === true, JSON.stringify(h.smtp));
  check("18.6 lastVerifyOk true (after restore + verify)", h.smtp?.lastVerifyOk === true, String(h.smtp?.lastVerifyOk));

  // ── 19. Audit coverage (§59) ───────────────────────────────────────────────
  console.log("── 19. AUDIT COVERAGE — ACTIONS + NO SECRETS ──────────────");
  const complaintAutomation = await db.emailAutomation.findFirst({ where: { eventType: "COMPLAINT_CREATED", templateKey: "COMPLAINT_CREATED" }, select: { id: true } });
  if (complaintAutomation) {
    // a no-op value edit — the route audits EMAIL_AUTOMATION_UPDATED for it
    await api(admin, "PATCH", `/api/v1/email/automations/${complaintAutomation.id}`, { delayMinutes: 0 });
  }
  const expectedActions = ["EMAIL_CONFIG_UPDATED", "EMAIL_TEST_SENT", "EMAIL_RETRIED", "EMAIL_CANCELED", "EMAIL_TEMPLATE_UPDATED", "EMAIL_AUTOMATION_UPDATED"];
  for (const action of expectedActions) {
    const rows = await db.auditLog.findMany({ where: { action }, take: 1 });
    check(`19.audit ${action}`, rows.length > 0);
  }
  const emailAudits = await db.auditLog.findMany({ where: { action: { startsWith: "EMAIL_" } } });
  check("19.audit no EMAIL_* row contains the SMTP password", emailAudits.every((a) => !JSON.stringify(a).includes(PASSWORD)), `${emailAudits.length} rows`);

  // ── 20. Cleanup + restore ──────────────────────────────────────────────────
  console.log("── 20. CLEANUP + FINAL STATE ──────────────────────────────");
  const capSetting = await db.setting.findUnique({ where: { key: "automation.email_max_per_automation_hour" } });
  check("20.1 email_max_per_automation_hour restored to 60", capSetting?.value === "60", capSetting?.value);
  const chanFinal = await db.setting.findUnique({ where: { key: "automation.email_notifications" } });
  check("20.2 email channel left ON", chanFinal?.value === "on", chanFinal?.value);
  const cfgFinal = await db.emailConfig.findUnique({ where: { id: "singleton" } });
  check("20.3 config left pointed at the dev sink", cfgFinal?.smtpHost === "127.0.0.1" && cfgFinal?.smtpPort === 3095, `${cfgFinal?.smtpHost}:${cfgFinal?.smtpPort}`);
  const qaAutoLeft = await db.emailAutomation.count({ where: { name: { startsWith: "QA bad attachment" } } });
  check("20.4 no QA automation rows left", qaAutoLeft === 0, `count=${qaAutoLeft}`);
  const sinkAlive = await sink("/health");
  check("20.5 sink healthy at end (messages kept for browser QA)", sinkAlive?.ok === true);

  console.log(`\n═══ RESULTS: ${passes} passed, ${failures} failed ═══`);
  await db.$disconnect();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error("QA crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
