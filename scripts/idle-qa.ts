/**
 * MOHD.HMS ENTERPRISE — Idle session timeout QA (scripts/idle-qa.ts)
 *
 * Run against a dev server started with SESSION_IDLE_TIMEOUT_SECONDS=5
 * (spec §21: automated tests use the short value; production stays 300):
 *
 *   1. Server config exposure: GET /auth/session reports idleTimeoutSeconds=5.
 *   2. Active path: periodic genuine-activity reports keep the session alive.
 *   3. Background path: GET /auth/session heartbeat (existing polling) does
 *      NOT advance lastActivityAt — the session still expires.
 *   4. Enforcement: after the idle threshold, an authenticated API answers
 *      401 SESSION_EXPIRED, the Session row is DELETED, and the audit trail
 *      contains SESSION_EXPIRED_IDLE_TIMEOUT.
 *   5. Activity endpoint updates lastActivityAt; scoped to the caller's token.
 *
 * Run: bun scripts/idle-qa.ts   (server on :3000 with the 5s timeout)
 */

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  try { data = await res.json(); } catch { /* non-json */ }
  const payload = (data && typeof data === "object" && "data" in (data as Record<string, unknown>))
    ? (data as { data: unknown }).data
    : data;
  return { status: res.status, data: payload } as { status: number; data: any };
}

async function login(email: string): Promise<Jar> {
  const jar: Jar = new Map();
  const res = await api("POST", "/api/v1/auth/login", { email, password: PASSWORD }, jar);
  if (res.status !== 200) throw new Error(`login failed for ${email}`);
  return jar;
}

async function main() {
  console.log("\n── 1. Server-config exposure (§2) ──");
  const supervisor = await login("supervisor@mohdhms.com");
  const sess = await api("GET", "/api/v1/auth/session", undefined, supervisor);
  check("session payload exposes idleTimeoutSeconds", sess.data?.idleTimeoutSeconds === 5, `got ${sess.data?.idleTimeoutSeconds}`);

  console.log("\n── 2. Activity endpoint advances lastActivityAt (scoped) ──");
  const supUser = await db.user.findUnique({ where: { email: "supervisor@mohdhms.com" } });
  const before = await db.session.findFirst({ where: { userId: supUser!.id }, orderBy: { createdAt: "desc" } });
  await sleep(1200);
  const act = await api("POST", "/api/v1/auth/activity", undefined, supervisor);
  check("POST /auth/activity → 200", act.status === 200, `got ${act.status}`);
  const after = await db.session.findFirst({ where: { id: before!.id } });
  check("lastActivityAt advanced in DB", after!.lastActivityAt.getTime() > before!.lastActivityAt.getTime() + 500);

  console.log("\n── 3. Active user stays logged in (§13/§22) ──");
  for (let i = 0; i < 3; i++) {
    await sleep(2200);
    await api("POST", "/api/v1/auth/activity", undefined, supervisor);
  }
  const stillAlive = await api("GET", "/api/v1/auth/session", undefined, supervisor);
  check("9+ seconds of REPORTED activity → session alive", stillAlive.data?.authenticated === true);
  const aliveRow = await db.session.findFirst({ where: { id: before!.id } });
  check("session row still exists for active user", !!aliveRow);

  console.log("\n── 4. Background polling does NOT extend the session (§8/§25) ──");
  // Stop reporting activity; run the EXISTING background heartbeat pattern
  // (GET /auth/session) several times across the idle window.
  for (let i = 0; i < 3; i++) {
    await sleep(2200);
    await api("GET", "/api/v1/auth/session", undefined, supervisor);
  }
  const postPoll = await api("GET", "/api/v1/auth/session", undefined, supervisor);
  check("heartbeat requests did not keep the session alive", postPoll.data?.authenticated !== true || postPoll.status === 401);
  const gone = await db.session.findFirst({ where: { id: before!.id } });
  check("Session row DELETED after idle threshold (server-enforced)", gone === null);

  console.log("\n── 5. Expired session rejected + audited (§3/§26) ──");
  const supervisor2 = await login("supervisor@mohdhms.com");
  const row2 = await db.session.findFirst({ where: { userId: supUser!.id }, orderBy: { createdAt: "desc" } });
  await sleep(6200); // cross the 5s idle threshold with NO activity
  const me = await api("GET", "/api/v1/auth/session", undefined, supervisor2);
  check("authenticated call after idle → not authenticated", me.data?.authenticated !== true);
  const profile = await api("GET", "/api/v1/profile", undefined, supervisor2);
  check("protected API answers 401 SESSION_EXPIRED", profile.status === 401 && profile.data?.error?.code === "SESSION_EXPIRED", `got ${profile.status}/${profile.data?.error?.code ?? "?"}`);
  const row2after = await db.session.findFirst({ where: { id: row2!.id } });
  check("session invalidated server-side (row gone)", row2after === null);
  const auditRow = await db.auditLog.findFirst({
    where: { action: "SESSION_EXPIRED_IDLE_TIMEOUT", actorId: supUser!.id },
    orderBy: { createdAt: "desc" },
  });
  check("SESSION_EXPIRED_IDLE_TIMEOUT audit written (no secrets)", !!auditRow && !JSON.stringify(auditRow.metadata).toLowerCase().includes("token"));

  console.log("\n── 6. Dead token cannot resurrect anything (§26) ──");
  const resurrect = await api("POST", "/api/v1/auth/activity", undefined, supervisor2);
  // The token was already deleted server-side in section 5 → generic 401
  // (SESSION_EXPIRED was verified at the exact moment of crossing the
  // threshold; a dead token afterwards is plain UNAUTHORIZED).
  check("activity ping with a dead session token → 401", resurrect.status === 401, `got ${resurrect.status}`);

  console.log(`\n════════ RESULT: ${passed} passed, ${failed} failed ════════`);
  await db.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (e) => {
  console.error("QA crashed:", e);
  await db.$disconnect();
  process.exit(1);
});
