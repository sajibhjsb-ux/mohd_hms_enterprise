/**
 * Customer onboarding + profile + job-request eligibility regression QA (Task 28).
 *
 * Exercises the REAL endpoints end-to-end against a running dev server:
 *   1. New Google user  → auto-provisioned CUSTOMER + canonical Customer record
 *                        (transactional) → lands on /profile/complete
 *   2. Direct API job request before onboarding → 403 PROFILE_INCOMPLETE
 *   3. Profile PATCH (multi-line address, optional company) → exact round-trip
 *   4. Job request AFTER completion → 201; repeat Google login → no duplicates
 *   5. Existing verified email via Google → links (no duplicate user/customer)
 *   6. Admin-created CUSTOMER user → Customer record auto-created → same rules
 *   7. Admin customer create with blank company name → 201
 *   8. Invalid mobile rejected; staff PATCH unchanged behaviour
 *   9. PostgreSQL verification of every persisted value; QA rows cleaned up
 *
 * Prereq: dev server on :3000 + mini-services/google-mock on :3040 and
 *         .env.local wired to the mock (see Task 28 worklog).
 * Run: bun scripts/customer-onboarding-qa.ts
 */
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const MOCK = "http://localhost:3040";
const ADMIN = { email: "admin@mohdhms.com", password: "Password@123" };

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

type Jar = Map<string, string>;
function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response) {
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function api(jar: Jar, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  absorb(jar, res);
  let json: unknown = null;
  try { json = await res.json(); } catch { /* non-json (redirects) */ }
  return { res, json: json as { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string; message?: string; details?: unknown } } };
}

/** Drive the real OAuth start → mock consent → callback chain, keeping cookies.
 *  Returns the last redirect target (the app's landing page). */
async function googleLogin(email: string, name?: string) {
  await fetch(`${MOCK}/mock/user`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  const jar: Jar = new Map();
  let res = await fetch(`${BASE}/api/v1/auth/google`, { redirect: "manual" });
  absorb(jar, res);
  let hops = 0;
  let location = res.headers.get("location") ?? "";
  let lastRedirect = location;
  while (res.status >= 300 && res.status < 400 && location && hops < 10) {
    const target = location.startsWith("http") ? location : `${BASE}${location}`;
    const isMock = new URL(target).host === new URL(MOCK).host;
    res = await fetch(target, {
      redirect: "manual",
      headers: isMock ? undefined : { cookie: cookieHeader(jar) },
    });
    absorb(jar, res);
    location = res.headers.get("location") ?? "";
    if (location) lastRedirect = location;
    hops++;
  }
  return { jar, finalUrl: lastRedirect, status: res.status };
}

async function passwordLogin(email: string, password: string) {
  const jar: Jar = new Map();
  const { res } = await api(jar, "POST", "/api/v1/auth/login", { email, password });
  return { jar, ok: res.ok };
}

const created = {
  userIds: [] as string[],
  customerIds: [] as string[],
  complaintIds: [] as string[],
};

async function cleanup() {
  for (const id of created.complaintIds) {
    await db.complaint.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const uid of created.userIds) {
    await db.user.deleteMany({ where: { id: uid, email: { contains: "qa." } } }).catch(() => undefined);
  }
  for (const cid of created.customerIds) {
    await db.customer.deleteMany({ where: { id: cid, email: { contains: "qa." } } }).catch(() => undefined);
  }
  // Admin QA customer (blank company) is created with a distinctive email.
  await db.customer.deleteMany({ where: { email: "qa.blankco@example.test" } }).catch(() => undefined);
  // Restore the seeded portal account untouched by the link test.
  await db.user.update({ where: { email: "customer1@demo.my" }, data: { googleId: null } }).catch(() => undefined);
}

const MULTI_LINE_ADDRESS = "No. 12, Jalan Selayun 88,\nKampung Selayun Tagap B, Mukim Gadong 'A',\nBandar Seri Begawan BA2311";

async function main() {
  console.log("── 1. New Google user: provisioning + onboarding gate ──");
  {
    const NEW = "qa.google.new@gmail.com";
    const flow = await googleLogin(NEW, "QA Google New");
    check("oauth flow completes", flow.finalUrl.includes("/profile/complete"), `landed ${new URL(flow.finalUrl).pathname}`);
    const jar = flow.jar;

    const prof = await api(jar, "GET", "/api/v1/profile");
    const p = prof.json.data as { user: { email: string; role: string }; customer: { code: string; phone: string; address: string; companyName: string } | null; profileComplete: boolean; missingFields: string[] };
    check("profile API: customer linked", !!p.customer, p.customer?.code);
    check("profile API: role CUSTOMER", p.user.role === "CUSTOMER");
    check("profile API: incomplete derived", p.profileComplete === false && p.missingFields.includes("mobile") && p.missingFields.includes("address"));

    const user = await db.user.findUnique({ where: { email: NEW }, include: { customer: true } });
    check("DB: user provisioned with role CUSTOMER", user?.role === "CUSTOMER");
    check("DB: user.customerId linked", !!user?.customerId && user.customerId === p.customer?.id);
    check("DB: googleId stored", !!user?.googleId);
    check("DB: companyName optional (empty)", user?.customer?.companyName === "");
    check("DB: phone starts empty", user?.customer?.phone === "");

    // Direct API job request BEFORE onboarding (spec §12).
    const blocked = await api(jar, "POST", "/api/v1/complaints", { title: "QA blocked request", description: "Should be rejected before onboarding.", priority: "MEDIUM" });
    check("direct API blocked pre-onboarding", blocked.res.status === 403 && blocked.json.error?.code === "PROFILE_INCOMPLETE", `${blocked.res.status} ${blocked.json.error?.code ?? ""}`);

    // PATCH profile: multi-line address, company left blank, invalid mobile first.
    const badMobile = await api(jar, "PATCH", "/api/v1/profile", { name: "QA Google New", mobile: "not-a-number", address: MULTI_LINE_ADDRESS, companyName: "" });
    check("invalid mobile rejected", badMobile.res.status === 400);

    const patched = await api(jar, "PATCH", "/api/v1/profile", { name: "QA Google New", mobile: "+673 1234567", address: MULTI_LINE_ADDRESS, companyName: "" });
    check("profile PATCH ok", patched.res.status === 200);
    const pdata = patched.json.data as { profileComplete: boolean; address: string; phone: string; companyName: string };
    check("PATCH returns complete state", pdata.profileComplete === true);
    check("multi-line address exact round-trip", pdata.address === MULTI_LINE_ADDRESS);
    check("company name stays blank", pdata.companyName === "");

    const reread = await api(jar, "GET", "/api/v1/profile");
    const rp = reread.json.data as { customer: { address: string; phone: string }; profileComplete: boolean };
    check("GET after PATCH: newlines intact", rp.customer.address === MULTI_LINE_ADDRESS);
    check("GET after PATCH: complete", rp.profileComplete === true);

    // Job request AFTER completion.
    const okReq = await api(jar, "POST", "/api/v1/complaints", { title: "QA post-onboarding request", description: "Should be accepted after profile completion.", priority: "HIGH" });
    const okData = okReq.json.data as { id: string; code: string } | undefined;
    check("job request accepted after completion", okReq.res.status === 201 && !!okData?.code, okData?.code);
    if (okData) created.complaintIds.push(okData.id);
    if (user) created.userIds.push(user.id);
    if (user?.customerId) created.customerIds.push(user.customerId);

    // Repeat Google login → no duplicates, straight to dashboard.
    const again = await googleLogin(NEW);
    check("repeat login lands on dashboard", again.finalUrl.includes("/dashboard"), `landed ${new URL(again.finalUrl).pathname}`);
    const dupUsers = await db.user.count({ where: { email: NEW } });
    const dupCustomers = await db.customer.count({ where: { email: NEW } });
    check("no duplicate users", dupUsers === 1);
    check("no duplicate customer records", dupCustomers === 1);
  }

  console.log("── 2. Existing verified email links without duplication ──");
  {
    const before = await db.user.count({ where: { email: "customer1@demo.my" } });
    const custBefore = await db.customer.findFirst({ where: { email: "ops@sunrisemall.my" }, select: { id: true, code: true } });
    const { finalUrl } = await googleLogin("customer1@demo.my", "Tan Mei Ling");
    check("existing customer lands on dashboard", finalUrl.includes("/dashboard"), `landed ${new URL(finalUrl).pathname}`);
    const after = await db.user.count({ where: { email: "customer1@demo.my" } });
    check("no duplicate user for existing email", before === 1 && after === 1);
    const u = await db.user.findUnique({ where: { email: "customer1@demo.my" }, include: { customer: true } });
    check("existing customer relationship preserved", u?.customer?.code === custBefore?.code, u?.customer?.code);
    check("googleId linked onto existing account", !!u?.googleId);
    const custAfter = await db.customer.count({ where: { email: "ops@sunrisemall.my" } });
    check("no duplicate customer record", custAfter === 1);
  }

  console.log("── 3. Admin-created CUSTOMER user gets a Customer record + same rules ──");
  {
    const admin = await passwordLogin(ADMIN.email, ADMIN.password);
    check("admin login", admin.ok);
    const mk = await api(admin.jar, "POST", "/api/v1/users", {
      email: "qa.adminmade@example.test", password: "Password123", name: "QA Admin Made", role: "CUSTOMER", phone: "",
    });
    check("admin creates CUSTOMER user", mk.res.status === 201, `status ${mk.res.status}`);
    const madeUser = await db.user.findUnique({ where: { email: "qa.adminmade@example.test" }, include: { customer: true } });
    check("DB: customer record auto-created+linked", !!madeUser?.customerId && !!madeUser.customer, madeUser?.customer?.code);
    if (madeUser) created.userIds.push(madeUser.id);
    if (madeUser?.customerId) created.customerIds.push(madeUser.customerId);

    const login = await passwordLogin("qa.adminmade@example.test", "Password123");
    check("password login works", login.ok);
    const blocked = await api(login.jar, "POST", "/api/v1/complaints", { title: "QA adminmade blocked", description: "Blocked before onboarding.", priority: "LOW" });
    check("new CUSTOMER user also gated", blocked.res.status === 403 && blocked.json.error?.code === "PROFILE_INCOMPLETE", `${blocked.res.status} ${blocked.json.error?.code ?? ""}`);
    const fixed = await api(login.jar, "PATCH", "/api/v1/profile", { name: "QA Admin Made", mobile: "+673 7654321", address: "Unit 3, Jalan Kuala Abang,\nBandar Seri Begawan", companyName: "" });
    check("onboarding via password login works", fixed.res.status === 200 && (fixed.json.data as { profileComplete: boolean }).profileComplete === true);
    const okReq = await api(login.jar, "POST", "/api/v1/complaints", { title: "QA adminmade allowed", description: "Accepted after onboarding.", priority: "MEDIUM" });
    const okData = okReq.json.data as { id: string } | undefined;
    check("job request accepted after onboarding", okReq.res.status === 201);
    if (okData) created.complaintIds.push(okData.id);
  }

  console.log("── 4. Company name optional in admin customer create ──");
  {
    const admin = await passwordLogin(ADMIN.email, ADMIN.password);
    const mk = await api(admin.jar, "POST", "/api/v1/customers", {
      contactPerson: "QA Blank Co", email: "qa.blankco@example.test", phone: "+673 5550101", address: "Somewhere in Brunei",
    });
    const data = mk.json.data as { id: string; companyName: string; code: string } | undefined;
    check("blank companyName accepted", mk.res.status === 201 && data?.companyName === "", data?.code);
    if (data) created.customerIds.push(data.id);
  }

  console.log("── 5. Staff PATCH behaviour unchanged + security ──");
  {
    const admin = await passwordLogin(ADMIN.email, ADMIN.password);
    const patch = await api(admin.jar, "PATCH", "/api/v1/profile", { name: "MohdAdmin", phone: "+673 0000000" });
    check("staff name/phone patch ok", patch.res.status === 200);
    const reject = await api(admin.jar, "PATCH", "/api/v1/profile", { address: "nope" });
    check("staff blocked from customer-only fields", reject.res.status === 400);

    // IDOR: a customer PATCH must write ONLY the session-linked record —
    // customer2@demo.my owns CUS-0002 (facilities@greenview.my); CUS-0001
    // (ops@sunrisemall.my) belongs to a different portal user and must stay
    // untouched no matter what the body contains.
    const cust = await passwordLogin("customer2@demo.my", "Password@123");
    const otherBefore = await db.customer.findFirst({ where: { email: "ops@sunrisemall.my" }, select: { phone: true, contactPerson: true, address: true } });
    const self = await api(cust.jar, "PATCH", "/api/v1/profile", { name: "Dr. Suresh Nair", mobile: "+60 3-7966 4400", address: "12 Jalan Gasing" });
    check("customer self-edit accepted", self.res.status === 200);
    const other = await db.customer.findFirst({ where: { email: "ops@sunrisemall.my" }, select: { phone: true, contactPerson: true, address: true } });
    check(
      "IDOR: other customer record untouched",
      JSON.stringify(other) === JSON.stringify(otherBefore),
      JSON.stringify(other)
    );
    const selfAfter = await db.customer.findFirst({ where: { email: "facilities@greenview.my" }, select: { phone: true, contactPerson: true } });
    check("self-edit wrote own record only", selfAfter?.phone === "+60 3-7966 4400" && selfAfter?.contactPerson === "Dr. Suresh Nair");
  }

  console.log("── 6. Customer counting uses the canonical source ──");
  {
    const total = await db.customer.count();
    const { res, json } = await (async () => {
      const admin = await passwordLogin(ADMIN.email, ADMIN.password);
      return api(admin.jar, "GET", "/api/v1/customers?pageSize=200");
    })();
    const meta = (json as { meta?: { total?: number } }).meta;
    check("customers API total == DB count", res.status === 200 && meta?.total === total, `api ${meta?.total} vs db ${total}`);
  }

  await cleanup();
  const remainUsers = await db.user.count({ where: { email: { contains: "qa." } } });
  check("cleanup removed QA users", remainUsers === 0, `${remainUsers} left`);

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("QA harness crashed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
