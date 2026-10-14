// MOHD.HMS ENTERPRISE — Role-scoped presence PRIVACY test (STEP 18).
//
// Proves the backend enforces presence visibility per role over BOTH
// transports, using the SAME shared policy the app uses:
//   SUPER_ADMIN | ADMIN   → scope "all"        (all users + total count)
//   SUPERVISOR            → scope "technicians" (technicians only)
//   TECHNICIAN/FINANCE/CUSTOMER → NO presence events, REST scope "self"
//
// Self-contained: logs in one user per role itself. Run against a live app:
//   BASE=http://127.0.0.1:3101 bun run scripts/presence-role-scope-test.ts
// (single-active-device policy: one session per distinct user — all 6 are
// distinct, so the logins do not supersede each other.)

import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE || "http://127.0.0.1:3101";
const PW = "Password@123";

const USERS: Array<{ key: string; email: string; expect: "all" | "technicians" | "self" }> = [
  { key: "super", email: "admin@mohdhms.com", expect: "all" },
  { key: "admin", email: "operations@mohdhms.com", expect: "all" },
  { key: "supervisor", email: "supervisor@mohdhms.com", expect: "technicians" },
  { key: "tech", email: "ahmad.tech@mohdhms.com", expect: "self" },
  { key: "finance", email: "finance@mohdhms.com", expect: "self" },
  { key: "customer", email: "customer1@demo.my", expect: "self" },
];

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

async function loginCookie(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`login ${email} -> ${res.status}`);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("hms_session="));
  if (!setCookie) throw new Error(`no session cookie for ${email}`);
  return setCookie.split(";")[0];
}

async function restScope(cookie: string): Promise<any> {
  const res = await fetch(`${BASE}/api/v1/realtime/presence`, { headers: { cookie } });
  return res.ok ? (await res.json()).data : null;
}

type Rec = { count: any[]; update: any[] };
function connect(cookie: string, rec: Rec): Socket {
  const s = io(BASE, {
    path: "/socket.io", addTrailingSlash: false,
    transports: ["websocket", "polling"], reconnection: false, forceNew: true,
    extraHeaders: { Cookie: cookie },
  });
  s.on("presence:count", (p) => rec.count.push(p));
  s.on("presence:update", (p) => rec.update.push({ scope: p.scope, roles: [...new Set((p.presence ?? []).map((x: any) => x.role))] }));
  return s;
}

console.log(`══ Presence role-scope test vs ${BASE} ══`);

const cookies: Record<string, string> = {};
for (const u of USERS) cookies[u.key] = await loginCookie(u.email);

console.log("── REST: each role only gets its scope ──");
for (const u of USERS) {
  const d = await restScope(cookies[u.key]);
  check(`REST ${u.key}: scope=${u.expect}`, d?.scope === u.expect, JSON.stringify({ scope: d?.scope, count: d?.count, connectedClients: d?.connectedClients }));
  if (u.expect === "self") {
    check(`REST ${u.key}: no count & no other identity`, d?.count === null && d?.connectedClients === null && (d?.online?.length ?? 0) === 0, JSON.stringify(d?.online));
  }
}

console.log("── WS: open one socket per role, collect 5s ──");
const recs: Record<string, Rec> = {};
const socks: Socket[] = [];
for (const u of USERS) { recs[u.key] = { count: [], update: [] }; socks.push(connect(cookies[u.key], recs[u.key])); }
await new Promise((r) => setTimeout(r, 5000));
for (const s of socks) s.close();
await new Promise((r) => setTimeout(r, 300));

for (const u of USERS) {
  const rec = recs[u.key];
  if (u.expect === "self") {
    check(`WS ${u.key}: receives ZERO presence events`, rec.count.length === 0 && rec.update.length === 0, JSON.stringify(rec));
  } else {
    const scopes = new Set([...rec.count.map((c) => c.scope), ...rec.update.map((x) => x.scope)]);
    check(`WS ${u.key}: only scope "${u.expect}"`, scopes.size > 0 && [...scopes].every((s) => s === u.expect), JSON.stringify([...scopes]));
    if (u.expect === "technicians") {
      const badRoles = rec.update.flatMap((x) => x.roles).filter((r: string) => r !== "TECHNICIAN");
      check(`WS supervisor: update contains ONLY TECHNICIAN roles`, badRoles.length === 0, JSON.stringify(badRoles));
    }
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
