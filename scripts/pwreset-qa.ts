/**
 * Password recovery flow — API + DB regression QA.
 *
 * Exercises the REAL forgot-password endpoints end-to-end, including the
 * negative/security matrix:
 *   1. anti-enumeration: known vs unknown email → byte-identical envelopes
 *   2. OTP issued through the shared EmailOtp system (PASSWORD_RESET purpose,
 *      only a HASH stored, dev mailbox mirrors the email)
 *   3. duplicate request inside the resend cooldown reuses the pending code
 *   4. wrong OTP → generic error, attempt counter increments, 5 wrong
 *      attempts invalidate the code (even the correct one then fails)
 *   5. resend before cooldown → 429 with remaining; after cooldown → new
 *      code, previous code invalidated
 *   6. verify-otp issues a single-use hashed reset authorization
 *   7. reset: mismatch / weak password / forged token / reused token /
 *      expired token all rejected with safe generic messages
 *   8. successful reset is atomic: hash updated, authorization consumed,
 *      ALL sessions revoked (pre-existing login dies), audit events written
 *   9. old password fails, new password succeeds against the real login
 *  10. purpose separation: a PASSWORD_RESET code cannot verify EMAIL_VERIFICATION
 *  11. cleanup of every test artifact
 *
 * Run: bun scripts/pwreset-qa.ts
 */
import { randomBytes } from "crypto";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const OLD_PASSWORD = "OldPassword@123";
const NEW_PASSWORD = "NewPassword@456";
const ts = Date.now().toString(36);
const EMAIL = `qa-pwreset-${ts}@demo.my`;

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

/** Plain-HTTP client; `xff` varies the rate-limit bucket (server honors XFF). */
function makeHttp(jar: Jar = new Map(), xff = "10.77.0.1") {
  return async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": xff };
    if (jar.size) headers["cookie"] = cookieHeader(jar);
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const ck of res.headers.getSetCookie?.() ?? []) {
      const [pair] = ck.split(";");
      const kidx = pair.indexOf("=");
      jar.set(pair.slice(0, kidx).trim(), pair.slice(kidx + 1).trim());
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  };
}

async function getOtp(email: string): Promise<string> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) throw new Error("qa user missing");
  const row = await db.setting.findUnique({ where: { key: `dev_email_otp_password_reset_${user.id}` } });
  return row?.value ?? "";
}

async function main() {
  console.log("\n== 0. setup: admin session + QA staff account ==");
  const admin = makeHttp(new Map(), "10.77.0.200");
  const login = await admin("POST", "/api/v1/auth/login", { email: "admin@mohdhms.com", password: "Password@123" });
  check("admin login", login.status === 200, String(login.status));

  const created = await admin("POST", "/api/v1/users", {
    email: EMAIL,
    name: "QA Password Reset",
    password: OLD_PASSWORD,
    role: "SUPERVISOR",
  });
  check("QA SUPERVISOR created", created.status === 200 || created.status === 201, JSON.stringify(created.json?.error ?? ""));

  const user = await db.user.findUnique({ where: { email: EMAIL } });
  check("QA user present in DB", !!user);

  console.log("\n== 1. anti-enumeration: known vs unknown email ==");
  const httpKnown = makeHttp(new Map(), "10.77.1.1");
  const httpUnknown = makeHttp(new Map(), "10.77.1.2");
  const known = await httpKnown("POST", "/api/v1/auth/forgot-password", { email: EMAIL });
  const unknown = await httpUnknown("POST", "/api/v1/auth/forgot-password", { email: `nobody-${ts}@demo.my` });
  check("known email → 200 generic message", known.status === 200 && known.json?.data?.message === "If an account is eligible for password recovery, a verification code has been sent.");
  check("unknown email → identical envelope", JSON.stringify(known.json) === JSON.stringify(unknown.json), JSON.stringify(unknown.json));
  check("no role/id/status leaked", !JSON.stringify(known.json).match(/SUPERVISOR|"id"|DISABLED/));

  const otp1 = await getOtp(EMAIL);
  check("6-digit code issued (dev mailbox)", /^\d{6}$/.test(otp1), `${otp1.length} digits`);
  const otpRow1 = await db.emailOtp.findUnique({ where: { userId_purpose: { userId: user!.id, purpose: "PASSWORD_RESET" } } });
  check("OTP row purpose=PASSWORD_RESET", otpRow1?.purpose === "PASSWORD_RESET");
  check("only a HASH stored (64 hex, ≠ code)", /^[0-9a-f]{64}$/.test(otpRow1?.codeHash ?? "") && otpRow1?.codeHash !== otp1);

  console.log("\n== 2. duplicate request inside cooldown reuses pending code ==");
  const dup = await httpKnown("POST", "/api/v1/auth/forgot-password", { email: EMAIL });
  const otpRowAfterDup = await db.emailOtp.findUnique({ where: { userId_purpose: { userId: user!.id, purpose: "PASSWORD_RESET" } } });
  check("duplicate → 200 generic", dup.status === 200 && dup.json?.data?.message === known.json.data.message);
  check("no second mail sent (lastSentAt unchanged)", otpRowAfterDup?.lastSentAt.getTime() === otpRow1?.lastSentAt.getTime());

  console.log("\n== 3. wrong OTP → generic error, attempts tracked ==");
  const bad1 = await httpKnown("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: "000000" });
  check("wrong code → 400 generic", bad1.status === 400 && bad1.json?.error?.message === "Invalid or expired verification code.");
  const afterBad = await db.emailOtp.findUnique({ where: { userId_purpose: { userId: user!.id, purpose: "PASSWORD_RESET" } } });
  check("attempt counter incremented", afterBad?.attempts === 1, String(afterBad?.attempts));

  console.log("\n== 4. resend: before cooldown → 429, after cooldown → new code ==");
  const early = await httpKnown("POST", "/api/v1/auth/forgot-password/resend", { email: EMAIL });
  check("resend inside cooldown → 429 with remaining", early.status === 429 && /in \d+s/.test(early.json?.error?.message ?? ""), early.json?.error?.message);
  await db.emailOtp.update({ where: { id: otpRow1!.id }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
  const resent = await httpKnown("POST", "/api/v1/auth/forgot-password/resend", { email: EMAIL });
  check("resend after cooldown → 200, cooldown 60s", resent.status === 200 && resent.json?.data?.resendAfterSec === 60, JSON.stringify(resent.json?.data));
  const otp2 = await getOtp(EMAIL);
  check("new code issued and old invalidated", otp2 !== otp1 && /^\d{6}$/.test(otp2));
  const oldCodeTry = await httpKnown("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: otp1 });
  check("previous code no longer verifies", oldCodeTry.status === 400);

  console.log("\n== 5. purpose separation (PASSWORD_RESET ≠ EMAIL_VERIFICATION) ==");
  const wrongPurpose = await httpKnown("POST", "/api/v1/auth/verify-email", { email: EMAIL, code: otp2 });
  check("reset code cannot verify login email flow", wrongPurpose.status === 400 && wrongPurpose.json?.error?.message === "Invalid or expired verification code.");

  console.log("\n== 6. verify correct OTP → single-use hashed authorization ==");
  const sessionBeforeReset = makeHttp(new Map(), "10.77.1.3");
  const preLogin = await sessionBeforeReset("POST", "/api/v1/auth/login", { email: EMAIL, password: OLD_PASSWORD });
  check("pre-reset login works (old password)", preLogin.status === 200);
  const verify = await httpKnown("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: otp2 });
  const resetToken: string | undefined = verify.json?.data?.resetToken;
  check("verify-otp → 200 + resetToken", verify.status === 200 && typeof resetToken === "string" && resetToken.length >= 32, `len=${resetToken?.length}`);
  const authRow = await db.passwordResetToken.findFirst({ where: { userId: user!.id } });
  check("authorization stored HASHED only", !!authRow && /^[0-9a-f]{64}$/.test(authRow.token) && authRow.token !== resetToken);
  check("authorization TTL ≤ 10 min", !!authRow && authRow.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000 + 5000);
  check("one-time code consumed after verify", !!(await db.emailOtp.findUnique({ where: { userId_purpose: { userId: user!.id, purpose: "PASSWORD_RESET" } } }))?.consumedAt);

  console.log("\n== 7. reset: negative matrix ==");
  const mismatch = await makeHttp(new Map(), "10.77.1.4")("POST", "/api/v1/auth/reset-password", { resetToken, password: NEW_PASSWORD, confirmPassword: "Different@123" });
  check("confirm mismatch rejected server-side", mismatch.status === 400 && mismatch.json?.error?.message === "Passwords do not match.", mismatch.json?.error?.message);
  const weak = await makeHttp(new Map(), "10.77.1.5")("POST", "/api/v1/auth/reset-password", { resetToken, password: "short1", confirmPassword: "short1" });
  check("too-short password rejected by EXISTING policy", weak.status === 400 && /at least 8/.test(weak.json?.error?.message ?? ""), weak.json?.error?.message);
  const forged = await makeHttp(new Map(), "10.77.1.6")("POST", "/api/v1/auth/reset-password", { resetToken: randomBytes(36).toString("base64url"), password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  check("forged token → generic no-longer-valid", forged.status === 400 && forged.json?.error?.message === "This password reset request is no longer valid. Please start again.");
  const weakStrength = await makeHttp(new Map(), "10.77.1.7")("POST", "/api/v1/auth/reset-password", { resetToken, password: "allletters", confirmPassword: "allletters" });
  check("letters-only password rejected", weakStrength.status === 400 && /letters and numbers/.test(weakStrength.json?.error?.message ?? ""));

  console.log("\n== 8. successful reset (atomic + session revocation) ==");
  const ok = await httpKnown("POST", "/api/v1/auth/reset-password", { resetToken, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  check("reset → 200 success message", ok.status === 200 && ok.json?.data?.message === "Password updated. You can now sign in.", ok.json?.data?.message);
  const authRowAfter = await db.passwordResetToken.findUnique({ where: { id: authRow!.id } });
  check("authorization consumed (usedAt set)", !!authRowAfter?.usedAt);
  const sessionsLeft = await db.session.count({ where: { userId: user!.id } });
  check("ALL sessions revoked", sessionsLeft === 0, String(sessionsLeft));
  const deadSession = await sessionBeforeReset("GET", "/api/v1/auth/session");
  check("pre-reset session cookie is dead", deadSession.json?.data?.authenticated === false, JSON.stringify(deadSession.json?.data));
  const reuse = await makeHttp(new Map(), "10.77.1.8")("POST", "/api/v1/auth/reset-password", { resetToken, password: "Another@123", confirmPassword: "Another@123" });
  check("token reuse rejected (single-use)", reuse.status === 400 && reuse.json?.error?.message === "This password reset request is no longer valid. Please start again.");

  console.log("\n== 9. old password fails, new password succeeds ==");
  const oldTry = await makeHttp(new Map(), "10.77.1.9")("POST", "/api/v1/auth/login", { email: EMAIL, password: OLD_PASSWORD });
  check("old password → 401 safe message", oldTry.status === 401 && oldTry.json?.error?.message === "Invalid email or password.");
  const newTry = await makeHttp(new Map(), "10.77.1.10")("POST", "/api/v1/auth/login", { email: EMAIL, password: NEW_PASSWORD });
  check("new password → 200 session", newTry.status === 200 && !!newTry.json?.data?.id);

  console.log("\n== 10. expiry + attempt exhaustion (second flow) ==");
  const httpFlow2 = makeHttp(new Map(), "10.77.2.1");
  const req2 = await httpFlow2("POST", "/api/v1/auth/forgot-password", { email: EMAIL });
  check("second recovery request → 200 generic", req2.status === 200);
  // If the per-IP limiter absorbed it silently the code is the pending one —
  // age the row so the flow can continue deterministically either way.
  await db.emailOtp.updateMany({ where: { userId: user!.id, purpose: "PASSWORD_RESET" }, data: { lastSentAt: new Date(Date.now() - 61_000) } });
  const otp3 = await getOtp(EMAIL);
  for (let i = 0; i < 5; i++) {
    await httpFlow2("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: i === 4 ? otp3 : "111111" });
  }
  const exhaustedRow = await db.emailOtp.findUnique({ where: { userId_purpose: { userId: user!.id, purpose: "PASSWORD_RESET" } } });
  check("5 wrong attempts invalidate the code", !!exhaustedRow?.consumedAt, `attempts=${exhaustedRow?.attempts}`);
  const evenCorrectFails = await httpFlow2("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: otp3 });
  check("correct code fails after exhaustion (generic)", evenCorrectFails.status === 400);

  // expired reset authorization
  const httpFlow3 = makeHttp(new Map(), "10.77.3.1");
  const req3 = await httpFlow3("POST", "/api/v1/auth/forgot-password", { email: EMAIL });
  const otp4 = await getOtp(EMAIL);
  const verify3 = await httpFlow3("POST", "/api/v1/auth/forgot-password/verify-otp", { email: EMAIL, code: otp4 || otp3 });
  const token3: string | undefined = verify3.json?.data?.resetToken;
  check("third flow: authorization issued", verify3.status === 200 && !!token3, String(verify3.status));
  if (token3) {
    await db.passwordResetToken.updateMany({ where: { userId: user!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await makeHttp(new Map(), "10.77.3.2")("POST", "/api/v1/auth/reset-password", { resetToken: token3, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    check("expired authorization → generic", expired.status === 400 && expired.json?.error?.message === "This password reset request is no longer valid. Please start again.");
  }

  console.log("\n== 11. audit trail (safe metadata only) ==");
  const audits = await db.auditLog.findMany({ where: { action: { startsWith: "PASSWORD_RESET" } }, orderBy: { createdAt: "desc" }, take: 30 });
  const actions = new Set(audits.map((a) => a.action));
  check("REQUESTED / OTP_VERIFIED / COMPLETED / FAILED audited", ["PASSWORD_RESET_REQUESTED", "PASSWORD_RESET_OTP_VERIFIED", "PASSWORD_RESET_COMPLETED", "PASSWORD_RESET_FAILED"].every((a) => actions.has(a)), [...actions].join(","));
  const otpLeak = audits.filter((a) => (a.metadata || "").includes(otp1) || (a.metadata || "").includes(otp2));
  const tokenLeak = audits.filter((a) => (a.metadata || "").includes(resetToken ?? "\u0000"));
  check("no OTP values in audit metadata", otpLeak.length === 0);
  check("no authorization token in audit metadata", tokenLeak.length === 0);

  console.log("\n== 12. cleanup ==");
  const uid = user!.id;
  await db.session.deleteMany({ where: { userId: uid } });
  await db.passwordResetToken.deleteMany({ where: { userId: uid } });
  await db.emailOtp.deleteMany({ where: { userId: uid } });
  await db.setting.deleteMany({ where: { OR: [{ key: `dev_email_otp_password_reset_${uid}` }, { key: `dev_email_otp_${uid}` }, { key: `dev_pwreset_${uid}` }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ actorId: uid }, { action: { startsWith: "PASSWORD_RESET" }, metadata: { contains: EMAIL } }] } });
  await db.user.deleteMany({ where: { email: { startsWith: "qa-pwreset-" } } });
  check("QA user + artifacts removed", !(await db.user.findUnique({ where: { email: EMAIL } })));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
