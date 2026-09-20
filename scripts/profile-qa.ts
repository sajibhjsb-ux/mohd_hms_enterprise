/**
 * MOHD.HMS ENTERPRISE — Profile field-level security QA (scripts/profile-qa.ts)
 *
 * Proves the profile system's backend enforcement against the REAL running
 * server, the REAL database and the REAL MinIO storage:
 *
 *   1. Field-level authorization (spec §6/§7/§19): name/email/phone/mobile/
 *      role/userId submitted to PATCH /api/v1/profile by customer, technician,
 *      supervisor and admin → 403, DB unchanged. Only address/companyName/city
 *      succeed for customers.
 *   2. IDOR (§10): customer hitting admin user APIs / other users' data → 403.
 *   3. SUPER_ADMIN override (§5/§28): PATCH /api/v1/users/{id} name/email/phone
 *      succeeds for SUPER_ADMIN only; ADMIN gets 403; canonical Customer mirror
 *      updated; ADMIN_* audit rows written.
 *   4. Email change safety (§29): conflict on duplicate; googleId preserved;
 *      mirror updated; audit + notification.
 *   5. Avatar (§11/§12): real PNG upload → MinIO object exists + DB reference +
 *      authenticated GET serves the bytes; 403 for non-owner fetch; oversized /
 *      non-image rejected; remove clears both.
 *   6. Phone-change request workflow (§15/§16): submit → duplicate conflict →
 *      cancel; SUPER_ADMIN queue + approve applies Customer.phone + User.phone;
 *      reject path with note; business rule (profileComplete) respected.
 *
 * Run: bun scripts/profile-qa.ts   (dev server must be running on :3000)
 */

import sharp from "sharp";
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";
const db = new PrismaClient();

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

type Jar = Map<string, string>;
function cookieHeader(jar: Jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response) {
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function api(method: string, path: string, body?: unknown, jar?: Jar) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(jar && jar.size ? { cookie: cookieHeader(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) absorb(jar, res);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  // Unwrap the standard { ok, data } envelope (raw body on non-envelope).
  const payload = (data && typeof data === "object" && "data" in (data as Record<string, unknown>))
    ? (data as { data: unknown }).data
    : data;
  return { status: res.status, data: payload } as { status: number; data: any };
}

async function login(email: string): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await api("POST", "/api/v1/auth/login", { email, password: PASSWORD }, jar);
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return jar;
}

/** A real 800×800 PNG (decodable content — not a fake extension). */
async function pngBlob(color: string, bytes: string): Promise<Blob> {
  const buf = await sharp({ create: { width: 800, height: 800, channels: 3, background: color } })
    .png()
    .toBuffer();
  if (bytes) {
    // Overwrite the leading bytes to prove content-sniffing matters.
    buf.write(bytes, 0, "ascii");
  }
  return new Blob([new Uint8Array(buf)], { type: "image/png" });
}

async function main() {
  console.log("\n── 0. Fixtures ──");
  const superAdmin = await login("admin@mohdhms.com");       // SUPER_ADMIN
  const admin = await login("operations@mohdhms.com");       // ADMIN (NOT super)
  const customer = await login("customer1@demo.my");         // CUSTOMER w/ customer record
  const technician = await login("ahmad.tech@mohdhms.com");  // TECHNICIAN
  const supervisor = await login("supervisor@mohdhms.com");  // SUPERVISOR

  const custUser = await db.user.findUnique({ where: { email: "customer1@demo.my" }, include: { customer: true } });
  const techUser = await db.user.findUnique({ where: { email: "ahmad.tech@mohdhms.com" } });
  check("fixtures resolved (customer has canonical record)", !!custUser?.customer && !!techUser);

  console.log("\n── 1. GET /api/v1/profile (every role, session-derived — §8) ──");
  for (const [label, jar] of [["SUPER_ADMIN", superAdmin], ["ADMIN", admin], ["CUSTOMER", customer], ["TECHNICIAN", technician]] as const) {
    const r = await api("GET", "/api/v1/profile", undefined, jar as Jar);
    check(`${label} GET /profile → 200 + session identity`, r.status === 200 && !!r.data?.user?.id && !!r.data?.user?.email);
  }
  const custProfile = await api("GET", "/api/v1/profile", undefined, customer);
  check("customer payload includes customer context + profile state", !!custProfile.data?.customer?.code && typeof custProfile.data?.profileComplete === "boolean");
  check("customer payload includes avatarUrl + pendingPhoneRequest fields", "avatarUrl" in custProfile.data.user && "pendingPhoneRequest" in custProfile.data);

  console.log("\n── 2. FIELD-LEVEL SECURITY: PATCH /profile identity fields → 403 (§6) ──");
  const custBefore = await db.customer.findUnique({ where: { id: custUser!.customer!.id } });
  const techBefore = await db.user.findUnique({ where: { id: techUser!.id } });
  const attempts: [string, Jar, Record<string, unknown>][] = [
    ["CUSTOMER name", customer, { name: "Hacker Name" }],
    ["CUSTOMER email", customer, { email: "hacker@evil.my" }],
    ["CUSTOMER mobile", customer, { mobile: "+673 9999999" }],
    ["CUSTOMER phone", customer, { phone: "+673 9999999" }],
    ["CUSTOMER role", customer, { role: "ADMIN" }],
    ["CUSTOMER userId", customer, { userId: techUser!.id }],
    ["TECHNICIAN name", technician, { name: "Hacked Tech" }],
    ["TECHNICIAN phone", technician, { phone: "+673 8888888" }],
    ["SUPERVISOR name", supervisor, { name: "Hacked Sup" }],
    ["ADMIN name (self)", admin, { name: "Hacked Admin" }],
  ];
  for (const [label, jar, body] of attempts) {
    const r = await api("PATCH", "/api/v1/profile", body, jar);
    check(`${label} → 403`, r.status === 403, `got ${r.status}`);
  }
  const custAfter = await db.customer.findUnique({ where: { id: custUser!.customer!.id } });
  const techAfter = await db.user.findUnique({ where: { id: techUser!.id } });
  check("customer canonical row unchanged after attack", custAfter!.phone === custBefore!.phone && custAfter!.contactPerson === custBefore!.contactPerson && custAfter!.email === custBefore!.email);
  check("technician User row unchanged after attack", techAfter!.name === techBefore!.name && techAfter!.phone === techBefore!.phone);

  console.log("\n── 3. Allowed customer self-service (address/company/city) ──");
  const addr = "No. 12, Jalan Setia 5\nKampong Setia, Mukim Gadong\nBandar Seri Begawan BE3919";
  const ok1 = await api("PATCH", "/api/v1/profile", { address: addr, companyName: "Metro Tower Facilities", city: "Bandar Seri Begawan" }, customer);
  check("CUSTOMER address+company+city → 200", ok1.status === 200 && ok1.data?.address === addr, `got ${ok1.status}`);
  const dbCust1 = await db.customer.findUnique({ where: { id: custUser!.customer!.id } });
  check("multi-line address persisted VERBATIM in DB (§13)", dbCust1!.address === addr);
  check("company name persisted", dbCust1!.companyName === "Metro Tower Facilities");
  const clear = await api("PATCH", "/api/v1/profile", { companyName: "" }, customer);
  check("company name optional — empty string clears it (§14)", clear.status === 200 && clear.data?.companyName === "");
  const empty = await api("PATCH", "/api/v1/profile", {}, customer);
  check("empty body → 400 nothing to update", empty.status === 400);
  const staffEmpty = await api("PATCH", "/api/v1/profile", { address: "x" }, technician);
  check("staff address → 400 honest no-self-service message", staffEmpty.status === 400);

  console.log("\n── 4. IDOR (§10) ──");
  const adminUsers = await db.user.findMany({ where: { role: "SUPER_ADMIN" }, take: 1 });
  const adminId = adminUsers[0].id;
  const r1 = await api("PATCH", `/api/v1/users/${adminId}`, { name: "Taken" }, customer);
  check("customer PATCH /users/{id} → 403/401 (cannot edit others)", r1.status === 403 || r1.status === 401, `got ${r1.status}`);
  const r2 = await api("PATCH", `/api/v1/users/${techUser!.id}`, { name: "Taken" }, customer);
  check("customer cannot edit technician via users API", r2.status === 403 || r2.status === 401, `got ${r2.status}`);
  const r3 = await api("GET", `/api/v1/profile/avatar?userId=${adminId}`, undefined, customer);
  check("customer cannot read another user's avatar file", r3.status === 403 || r3.status === 404, `got ${r3.status}`);

  console.log("\n── 5. SUPER_ADMIN identity changes via users API (§5/§28) ──");
  const adminTry = await api("PATCH", `/api/v1/users/${techUser!.id}`, { name: "Nope" }, admin);
  check("ADMIN cannot change name via users API → 403", adminTry.status === 403, `got ${adminTry.status}`);
  const adminTry2 = await api("PATCH", `/api/v1/users/${techUser!.id}`, { phone: "+673 7777777" }, admin);
  check("ADMIN cannot change phone via users API → 403", adminTry2.status === 403, `got ${adminTry2.status}`);
  const saName = await api("PATCH", `/api/v1/users/${techUser!.id}`, { name: "Ahmad Faizal Jr." }, superAdmin);
  check("SUPER_ADMIN name change → 200", saName.status === 200 && saName.data?.name === "Ahmad Faizal Jr.", `got ${saName.status}`);
  const saPhone = await api("PATCH", `/api/v1/users/${techUser!.id}`, { phone: "+673 71234567" }, superAdmin);
  check("SUPER_ADMIN phone change → 200", saPhone.status === 200);
  const techRow = await db.user.findUnique({ where: { id: techUser!.id } });
  check("DB reflects SUPER_ADMIN identity change", techRow!.name === "Ahmad Faizal Jr." && techRow!.phone === "+673 71234567");
  const nameAudit = await db.auditLog.findFirst({ where: { action: "ADMIN_NAME_CHANGED", resourceId: techUser!.id }, orderBy: { createdAt: "desc" } });
  const phoneAudit = await db.auditLog.findFirst({ where: { action: "ADMIN_PHONE_CHANGED", resourceId: techUser!.id }, orderBy: { createdAt: "desc" } });
  check("ADMIN_NAME_CHANGED audit written (from→to)", !!nameAudit && JSON.parse(nameAudit.metadata).to === "Ahmad Faizal Jr.");
  check("ADMIN_PHONE_CHANGED audit written", !!phoneAudit && JSON.parse(phoneAudit.metadata).from === "");

  // Restore technician identity (audit trail keeps both entries).
  await api("PATCH", `/api/v1/users/${techUser!.id}`, { name: techBefore!.name, phone: techBefore!.phone }, superAdmin);

  console.log("\n── 6. Email change safety (§29) — customer target mirrors Customer row ──");
  const dupe = await api("PATCH", `/api/v1/users/${custUser!.id}`, { email: "operations@mohdhms.com" }, superAdmin);
  check("duplicate email → 409 conflict", dupe.status === 409, `got ${dupe.status}`);
  const googleBefore = custUser!.googleId;
  const newEmail = `farah.fresh+${Date.now()}@demo.my`;
  const emailChange = await api("PATCH", `/api/v1/users/${custUser!.id}`, { email: newEmail }, superAdmin);
  check("SUPER_ADMIN email change → 200", emailChange.status === 200 && emailChange.data?.email === newEmail, `got ${emailChange.status}`);
  const mirrored = await db.customer.findUnique({ where: { id: custUser!.customer!.id } });
  const userRow = await db.user.findUnique({ where: { id: custUser!.id } });
  check("Customer.email mirror updated in same transaction", mirrored!.email === newEmail);
  check("googleId PRESERVED (OAuth unbroken, §44)", !!userRow!.googleId === !!googleBefore);
  check("emailVerified reset (new address unverified)", userRow!.emailVerified === null);
  const emailAudit = await db.auditLog.findFirst({ where: { action: "ADMIN_EMAIL_CHANGED", resourceId: custUser!.id }, orderBy: { createdAt: "desc" } });
  check("ADMIN_EMAIL_CHANGED audit written", !!emailAudit && JSON.parse(emailAudit.metadata).to === newEmail);
  const notif = await db.notification.findFirst({ where: { userId: custUser!.id, title: "Email address changed" }, orderBy: { createdAt: "desc" } });
  check("target user notified about email change", !!notif);
  // Restore original email (keeps subsequent logins/password flows stable).
  await api("PATCH", `/api/v1/users/${custUser!.id}`, { email: "customer1@demo.my" }, superAdmin);
  // The change reset emailVerified (correct product behaviour) — restore the
  // account's original verified state as part of the test cleanup.
  await db.user.update({ where: { id: custUser!.id }, data: { emailVerified: new Date() } });

  console.log("\n── 7. Avatar upload through MinIO (§11/§12) ──");
  // 7a. honest image upload
  const goodBlob = await pngBlob("#16a34a", "");
  const form = new FormData();
  form.append("file", goodBlob, "avatar.png");
  const up = await fetch(`${BASE}/api/v1/profile/avatar`, { method: "POST", headers: { cookie: cookieHeader(customer) }, body: form });
  const upJson = await up.json().catch(() => null);
  check("avatar upload → 200 with object key", up.status === 200 && typeof upJson?.data?.avatarUrl === "string", `got ${up.status}`);
  const key = upJson?.data?.avatarUrl as string;
  const dbAvatar = await db.user.findUnique({ where: { id: custUser!.id }, select: { avatarUrl: true } });
  check("DB stores the object REFERENCE (not bytes)", dbAvatar?.avatarUrl === key && key.startsWith(`avatars/${custUser!.id}/`));
  const stored = await fetch(`${BASE}/api/v1/profile/avatar`, { headers: { cookie: cookieHeader(customer) } });
  const storedBytes = Buffer.from(await stored.arrayBuffer());
  const sniff = await sharp(storedBytes).metadata().catch(() => null);
  check("authenticated GET serves the real image (512×512 jpeg)", stored.status === 200 && sniff?.width === 512 && sniff?.height === 512, `got ${stored.status}`);
  const photoAudit = await db.auditLog.findFirst({ where: { action: "PROFILE_PHOTO_CHANGED", resourceId: custUser!.id }, orderBy: { createdAt: "desc" } });
  check("PROFILE_PHOTO_CHANGED audit written", !!photoAudit);
  // 7b. non-image content rejected (fake extension, real bytes are text)
  const fakeBlob = new Blob([new Uint8Array(Buffer.from("#!/bin/sh\nrm -rf /"))], { type: "image/png" });
  const form2 = new FormData();
  form2.append("file", fakeBlob, "evil.png");
  const evil = await fetch(`${BASE}/api/v1/profile/avatar`, { method: "POST", headers: { cookie: cookieHeader(customer) }, body: form2 });
  check("executable/text masquerading as PNG → 422 (content sniffed)", evil.status === 422, `got ${evil.status}`);
  // 7c. oversized rejected (>5MB) — a valid PNG padded with 6 MB of incompressible
  // noise: the size cap must reject it BEFORE any decoding attempt.
  const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000" } }).png().toBuffer();
  const padded = Buffer.concat([small, Buffer.alloc(6 * 1024 * 1024, 7)]);
  const form3 = new FormData();
  form3.append("file", new Blob([new Uint8Array(padded)], { type: "image/png" }), "big.png");
  const big = await fetch(`${BASE}/api/v1/profile/avatar`, { method: "POST", headers: { cookie: cookieHeader(customer) }, body: form3 });
  check("oversized avatar (>5MB) → 422", big.status === 422, `got ${big.status}`);
  // 7d. remove clears object + reference
  const rm = await api("DELETE", "/api/v1/profile/avatar", undefined, customer);
  const dbAvatarAfter = await db.user.findUnique({ where: { id: custUser!.id }, select: { avatarUrl: true } });
  check("avatar removal clears the DB reference", rm.status === 200 && dbAvatarAfter?.avatarUrl === null);

  console.log("\n── 8. Phone-change REQUEST workflow (§15/§16) ──");
  // 8a. customer cannot self-change mobile anymore (covered in §2); submit request
  const proposed1 = "+673 7110001";
  const sub = await api("POST", "/api/v1/profile/phone-requests", { phone: proposed1 }, customer);
  check("customer submits phone request → 200 PENDING", sub.status === 200 && sub.data?.status === "PENDING", `got ${sub.status}`);
  const sub2 = await api("POST", "/api/v1/profile/phone-requests", { phone: "+673 7110002" }, customer);
  check("second pending request → 409 conflict (one per user)", sub2.status === 409, `got ${sub2.status}`);
  const subBad = await api("POST", "/api/v1/profile/phone-requests", { phone: "12" }, customer);
  check("invalid number rejected with validation error", subBad.status === 400);
  // 8b. cancel path
  const cancel = await api("DELETE", "/api/v1/profile/phone-requests", undefined, customer);
  check("requester cancels own pending request", cancel.status === 200 && cancel.data?.status === "CANCELED");
  // 8c. SUPER_ADMIN reviews queue + approves
  const sub3 = await api("POST", "/api/v1/profile/phone-requests", { phone: proposed1 }, customer);
  check("re-submit after cancel works", sub3.status === 200);
  const reqId = sub3.data.id as string;
  const queue = await api("GET", "/api/v1/phone-requests", undefined, admin);
  check("ADMIN cannot open the SUPER_ADMIN review queue", queue.status === 403, `got ${queue.status}`);
  const queueSa = await api("GET", "/api/v1/phone-requests?status=PENDING", undefined, superAdmin);
  const inQueue = Array.isArray(queueSa.data) && queueSa.data.some((r: any) => r.id === reqId);
  check("SUPER_ADMIN sees the request in the queue", inQueue);
  const decideTry = await api("PATCH", `/api/v1/phone-requests/${reqId}`, { action: "approve" }, admin);
  check("ADMIN cannot approve → 403", decideTry.status === 403, `got ${decideTry.status}`);
  const approve = await api("PATCH", `/api/v1/phone-requests/${reqId}`, { action: "approve" }, superAdmin);
  check("SUPER_ADMIN approves → 200", approve.status === 200);
  const custFinal = await db.customer.findUnique({ where: { id: custUser!.customer!.id } });
  const userFinal = await db.user.findUnique({ where: { id: custUser!.id } });
  check("approval applied to canonical Customer.phone", custFinal!.phone === proposed1);
  check("approval applied to display User.phone", userFinal!.phone === proposed1);
  const approveAudit = await db.auditLog.findFirst({ where: { action: "PHONE_CHANGE_REQUEST_APPROVED", resourceId: reqId } });
  check("PHONE_CHANGE_REQUEST_APPROVED audit written", !!approveAudit);
  const approveNotif = await db.notification.findFirst({ where: { userId: custUser!.id, title: "Phone number updated" } });
  check("requester notified of approval", !!approveNotif);
  const profileNow = await api("GET", "/api/v1/profile", undefined, customer);
  check("profile now complete (phone + address rule intact, §15)", profileNow.data?.profileComplete === true && profileNow.data?.missingFields?.length === 0);
  const decideAgain = await api("PATCH", `/api/v1/phone-requests/${reqId}`, { action: "reject", note: "x" }, superAdmin);
  check("already-decided request cannot be decided again", decideAgain.status === 409);
  // 8d. reject path
  await api("DELETE", "/api/v1/profile/phone-requests", undefined, customer).catch(() => null);
  const sub4 = await api("POST", "/api/v1/profile/phone-requests", { phone: "+673 7220002" }, customer);
  const rej = await api("PATCH", `/api/v1/phone-requests/${sub4.data.id}`, { action: "reject", note: "Could not verify the number" }, superAdmin);
  check("SUPER_ADMIN rejects with note", rej.status === 200 && rej.data?.status === "REJECTED");
  const rejAudit = await db.auditLog.findFirst({ where: { action: "PHONE_CHANGE_REQUEST_REJECTED", resourceId: sub4.data.id } });
  check("PHONE_CHANGE_REQUEST_REJECTED audit written", !!rejAudit);
  // restore original customer phone (from seed QA state)
  const originalPhone = "6731234567";
  await api("PATCH", `/api/v1/users/${custUser!.id}`, { phone: originalPhone }, superAdmin);

  console.log("\n── 9. Cache/identity refresh (§25) — session reflects profile changes ──");
  const sess = await api("GET", "/api/v1/auth/session", undefined, customer);
  check("session payload carries avatarUrl field", "avatarUrl" in (sess.data?.user ?? {}));
  check("session reflects updated identity (name unchanged by customer attack)", sess.data?.user?.name === custUser!.name);

  console.log(`\n════════ RESULT: ${passed} passed, ${failed} failed ════════`);
  await db.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("QA crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
