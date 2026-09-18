/**
 * Mobile auth experience — API regression QA (Task 29).
 *
 * Exercises the REAL auth endpoints end-to-end:
 *   1. staff login unchanged (no OTP step) + wrong-password path
 *   2. admin-provisioned CUSTOMER account (emailVerified null) → login returns
 *      otpRequired + issues a 6-digit code (EmailOtp row + dev mailbox Setting)
 *   3. verify-email with wrong code → GENERIC error (no enumeration)
 *   4. resend cooldown enforced server-side (429 with remaining, then success)
 *   5. verify-email with the correct code → session opens, emailVerified set,
 *      payload shape identical to login; second login skips OTP (verified)
 *   6. 5 wrong attempts invalidate the code; resend resets the flow
 *   7. "Remember me" extends the session TTL (30d vs 7d) — x-session-expires-at
 *   8. cleanup of all test artifacts
 *
 * Run: bun scripts/auth-mobile-qa.ts
 */
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";
const ts = Date.now().toString(36);

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Jar = Map<string, string>;
function cookieHeader(jar: Jar): string {
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
  return { res, data };
}

function daysUntil(iso: string | undefined | null): number {
  if (!iso) return -1;
  return Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

async function main() {
  console.log("— 1. Staff login (unchanged) + wrong password");
  {
    const { res, data } = await api("POST", "/api/v1/auth/login", {
      email: "admin@mohdhms.com",
      password: PASSWORD,
    });
    const d = data as { data?: { id?: string; role?: string; permissions?: string[]; otpRequired?: boolean } };
    check("staff login 200", res.status === 200);
    check("staff login returns session payload", !!d.data?.id && Array.isArray(d.data.permissions));
    check("no otpRequired for staff", d.data?.otpRequired !== true);
    check("staff role preserved", d.data?.role === "SUPER_ADMIN");

    const bad = await api("POST", "/api/v1/auth/login", { email: "admin@mohdhms.com", password: "wrong" });
    check("wrong password 401", bad.res.status === 401);
    check(
      "safe generic message",
      (bad.data as { error?: { message?: string } })?.error?.message === "Invalid email or password."
    );
  }

  console.log("— 2. Remember me extends session TTL");
  {
    const jar = new Map<string, string>();
    const r7 = await api("POST", "/api/v1/auth/login", { email: "operations@mohdhms.com", password: PASSWORD }, jar);
    const d7 = daysUntil(r7.res.headers.get("x-session-expires-at"));
    check("default session ≈ 7 days", r7.res.status === 200 && d7 >= 6 && d7 <= 8, `~${d7}d`);

    const jar30 = new Map<string, string>();
    const r30 = await api(
      "POST",
      "/api/v1/auth/login",
      { email: "operations@mohdhms.com", password: PASSWORD, remember: true },
      jar30
    );
    const d30 = daysUntil(r30.res.headers.get("x-session-expires-at"));
    check("remember-me session ≈ 30 days", r30.res.status === 200 && d30 >= 29 && d30 <= 31, `~${d30}d`);
  }

  console.log("— 3. Admin provisions a customer (emailVerified null) → OTP required at login");
  let customerEmail = "";
  let adminJar = new Map<string, string>();
  {
    await api("POST", "/api/v1/auth/login", { email: "admin@mohdhms.com", password: PASSWORD }, adminJar);
    customerEmail = `qa-cust-${ts}@demo.my`;
    const created = await api(
      "POST",
      "/api/v1/users",
      { email: customerEmail, name: "QA OTP Customer", password: PASSWORD, role: "CUSTOMER", phone: "+6737000001" },
      adminJar
    );
    check("customer user created via users API", created.res.status === 200 || created.res.status === 201);

    const u = await db.user.findUnique({ where: { email: customerEmail }, select: { id: true, emailVerified: true } });
    check("customer emailVerified is null", !!u && u.emailVerified === null);

    const jar = new Map<string, string>();
    const login = await api("POST", "/api/v1/auth/login", { email: customerEmail, password: PASSWORD }, jar);
    const d = login.data as { data?: { otpRequired?: boolean; email?: string; resendAfterSec?: number; expiresInSec?: number } };
    check("login → otpRequired challenge", login.res.status === 200 && d.data?.otpRequired === true);
    check("challenge carries the email", d.data?.email === customerEmail);
    check("resend cooldown from server (30s)", d.data?.resendAfterSec === 30, `${d.data?.resendAfterSec}s`);
    check("code expiry from server (600s)", d.data?.expiresInSec === 600, `${d.data?.expiresInSec}s`);

    const otp = await db.emailOtp.findFirst({ where: { user: { email: customerEmail } } });
    check("EmailOtp row created (64-hex sha256, unconsumed)", !!otp && otp.codeHash.length === 64 && otp.consumedAt === null);
    const mailbox = await db.setting.findUnique({ where: { key: `dev_email_otp_${u?.id}` } });
    check("dev mailbox holds the 6-digit code", !!mailbox && /^\d{6}$/.test(mailbox.value));
    globalThis.__otp = { userId: u!.id, code: mailbox!.value };
  }

  console.log("— 4. verify-email: wrong code → generic error (no enumeration)");
  {
    // Flip the first digit of the real code so the submission is definitely wrong.
    const first = globalThis.__otp.code[0];
    const definitelyWrong = globalThis.__otp.code.replace(first, first === "9" ? "8" : "9");
    const w2 = await api("POST", "/api/v1/auth/verify-email", { email: customerEmail, code: definitelyWrong });
    const e = (w2.data as { error?: { message?: string } })?.error;
    check("wrong code → 400", w2.res.status === 400);
    check(
      "generic message (spec wording)",
      e?.message === "Invalid or expired verification code."
    );
    const attempts = await db.emailOtp.findUnique({
      where: { userId_purpose: { userId: globalThis.__otp.userId, purpose: "EMAIL_VERIFICATION" } },
    });
    check("attempt counter incremented", (attempts?.attempts ?? 0) >= 1, `attempts=${attempts?.attempts}`);
  }

  console.log("— 5. Resend cooldown: immediate resend → 429 with remaining; expired → success");
  {
    const early = await api("POST", "/api/v1/auth/resend-verification", { email: customerEmail });
    check("early resend → 429 RATE_LIMITED", early.res.status === 429);
    const msg = (early.data as { error?: { message?: string } })?.error?.message ?? "";
    const m = msg.match(/in (\d+)s/);
    check("429 carries remaining cooldown", !!m && Number(m[1]) >= 1 && Number(m[1]) <= 30, msg);

    console.log("    waiting 31s for the server-enforced cooldown…");
    await new Promise((r) => setTimeout(r, 31_000));
    const later = await api("POST", "/api/v1/auth/resend-verification", { email: customerEmail });
    const d = later.data as { data?: { resent?: boolean; resendAfterSec?: number } };
    check("resend after cooldown → 200", later.res.status === 200 && d.data?.resent === true);
    const attempts = await db.emailOtp.findUnique({
      where: { userId_purpose: { userId: globalThis.__otp.userId, purpose: "EMAIL_VERIFICATION" } },
    });
    check("resend reset attempts + invalidated old code", attempts?.attempts === 0);
    const mailbox = await db.setting.findUnique({ where: { key: `dev_email_otp_${globalThis.__otp.userId}` } });
    check("new code issued in dev mailbox", !!mailbox && /^\d{6}$/.test(mailbox.value));
    globalThis.__otp.code = mailbox!.value;
  }

  console.log("— 6. verify-email with the correct code → session opens");
  {
    const jar = new Map<string, string>();
    const v = await api("POST", "/api/v1/auth/verify-email", { email: customerEmail, code: globalThis.__otp.code, remember: true }, jar);
    const d = v.data as { data?: { id?: string; role?: string; email?: string; customerId?: string | null; permissions?: string[]; profileComplete?: boolean } };
    check("verify → 200 with session payload", v.res.status === 200 && !!d.data?.id);
    check("role + customerId + permissions present", d.data?.role === "CUSTOMER" && !!d.data?.customerId && Array.isArray(d.data?.permissions));
    const u = await db.user.findUnique({ where: { email: customerEmail }, select: { emailVerified: true } });
    check("emailVerified stamped in DB", !!u?.emailVerified);
    const otpRow = await db.emailOtp.findUnique({
      where: { userId_purpose: { userId: globalThis.__otp.userId, purpose: "EMAIL_VERIFICATION" } },
    });
    check("code consumed (single-use)", !!otpRow?.consumedAt);
    const mailbox = await db.setting.findUnique({ where: { key: `dev_email_otp_${globalThis.__otp.userId}` } });
    check("dev mailbox cleared after success", mailbox === null);

    const session = await api("GET", "/api/v1/auth/session", undefined, jar);
    const sd = session.data as { data?: { authenticated?: boolean; user?: { email?: string } } };
    check("session cookie works after verification", sd.data?.authenticated === true && sd.data?.user?.email === customerEmail);
    const dExp = daysUntil(v.res.headers.get("x-session-expires-at"));
    check("remember-me honored through verification", dExp >= 29, `~${dExp}d`);

    // Replay: another verification attempt now → generic failure (already verified)
    const replay = await api("POST", "/api/v1/auth/verify-email", { email: customerEmail, code: globalThis.__otp.code });
    check("verify after verified → generic 400", replay.res.status === 400);

    // Next login skips OTP entirely
    const jar2 = new Map<string, string>();
    const login2 = await api("POST", "/api/v1/auth/login", { email: customerEmail, password: PASSWORD }, jar2);
    const d2 = login2.data as { data?: { otpRequired?: boolean; id?: string } };
    check("subsequent login → straight session (no OTP)", login2.res.status === 200 && d2.data?.otpRequired !== true && !!d2.data?.id);
  }

  console.log("— 7. Attempt exhaustion: 5 wrong codes invalidate; resend recovers");
  {
    const email2 = `qa-cust2-${ts}@demo.my`;
    await api(
      "POST",
      "/api/v1/users",
      { email: email2, name: "QA OTP Two", password: PASSWORD, role: "CUSTOMER" },
      adminJar
    );
    const login = await api("POST", "/api/v1/auth/login", { email: email2, password: PASSWORD });
    check("second customer → otpRequired", login.res.status === 200 && (login.data as { data?: { otpRequired?: boolean } }).data?.otpRequired === true);
    const u = await db.user.findUnique({ where: { email: email2 }, select: { id: true } });

    for (let i = 0; i < 5; i++) {
      await api("POST", "/api/v1/auth/verify-email", { email: email2, code: "11111".concat(String(i)) });
    }
    const row = await db.emailOtp.findUnique({
      where: { userId_purpose: { userId: u!.id, purpose: "EMAIL_VERIFICATION" } },
    });
    check("row consumed after 5 bad attempts", !!row?.consumedAt && row.attempts === 5, `attempts=${row?.attempts}`);
    const sixth = await api("POST", "/api/v1/auth/verify-email", { email: email2, code: "999999" });
    check("6th attempt → generic 400", sixth.res.status === 400);

    console.log("    waiting 31s for cooldown before recovery resend…");
    await new Promise((r) => setTimeout(r, 31_000));
    const re = await api("POST", "/api/v1/auth/resend-verification", { email: email2 });
    check("resend after exhaustion → 200", re.res.status === 200);
    const mailbox = await db.setting.findUnique({ where: { key: `dev_email_otp_${u!.id}` } });
    const jar = new Map<string, string>();
    const ok2 = await api("POST", "/api/v1/auth/verify-email", { email: email2, code: mailbox?.value }, jar);
    check("fresh code verifies (flow recovers)", ok2.res.status === 200);
  }

  console.log("— 8. Enumeration safety: unknown email → identical shapes");
  {
    const v = await api("POST", "/api/v1/auth/verify-email", { email: `nobody-${ts}@example.com`, code: "123456" });
    const r = await api("POST", "/api/v1/auth/resend-verification", { email: `nobody-${ts}@example.com` });
    check("verify unknown → same generic 400", v.res.status === 400 && (v.data as { error?: { message?: string } })?.error?.message === "Invalid or expired verification code.");
    check("resend unknown → same 200 envelope", r.res.status === 200 && (r.data as { data?: { resent?: boolean } })?.data?.resent === true);
    const auditFail = await db.auditLog.count({ where: { action: "EMAIL_VERIFICATION_FAILED" } });
    check("failed verifications audited", auditFail >= 1);
  }

  console.log("— 9. Cleanup");
  {
    const users = await db.user.findMany({ where: { email: { startsWith: `qa-cust` } } });
    for (const u of users) {
      await db.emailOtp.deleteMany({ where: { userId: u.id } });
      await db.session.deleteMany({ where: { userId: u.id } });
      await db.setting.deleteMany({ where: { key: `dev_email_otp_${u.id}` } });
      const cust = u.customerId;
      await db.user.delete({ where: { id: u.id } });
      if (cust) await db.customer.deleteMany({ where: { id: cust, code: { startsWith: "CUS" } } });
    }
    const left = await db.user.count({ where: { email: { startsWith: "qa-cust" } } });
    check("test accounts + artifacts removed", left === 0);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

declare global {
  var __otp: { userId: string; code: string };
}

main()
  .catch((e) => {
    console.error("QA harness crashed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
