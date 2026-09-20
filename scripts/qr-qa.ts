/**
 * MOHD.HMS ENTERPRISE — QR scanner QA (scripts/qr-qa.ts)
 *
 * Proves the NEW camera scanner's decode + resolution chain against the REAL
 * running server and the REAL existing QR generation endpoints:
 *
 *   1. Equipment QR  (GET /api/v1/equipment/{id}/qr)  → PNG → jsQR decode
 *      → must equal the deep-link URL → resolveQrValue → equipment token
 *      → existing lookup endpoint (staff + owner-customer + foreign customer).
 *   2. IRMS report QR (GET /api/v1/irms/reports/{id}/qr) → PNG → jsQR decode
 *      → must equal the report URL → resolveQrValue → irms reports route.
 *   3. Security / negative cases for the resolver (external URL, arbitrary
 *      text, unknown deep-link type, scanner self-reference, hidden module).
 *
 * Run: bun scripts/qr-qa.ts   (dev server must be running on :3000)
 */

import sharp from "sharp";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";

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
  return { res, data };
}

/** Decode a PNG (buffer) to RGBA via sharp, then run the SAME jsQR decoder the scanner page uses. */
async function decodeQrPng(png: Buffer): Promise<string | null> {
  const jsQR = (await import("jsqr")).default;
  const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const code = jsQR(new Uint8ClampedArray(raw.data), raw.info.width, raw.info.height, {
    inversionAttempts: "dontInvert",
  });
  return code?.data ?? null;
}

async function main() {
  // Window shim BEFORE importing the resolver (resolve.ts checks same-origin).
  (globalThis as unknown as { window: { location: { origin: string } } }).window = { location: { origin: BASE } };
  const { resolveQrValue } = await import("../src/components/hms/modules/scan/resolve");

  const ALL = ["dashboard", "complaints", "work-orders", "equipment", "pm", "customers", "users",
    "employees", "technicians", "inventory", "purchases", "quotations", "invoices", "finance",
    "hr", "whatsapp", "irms", "vehicles", "reports", "audit", "settings", "profile", "terms", "privacy"];
  const STAFF_VISIBLE = ALL.filter((k) => !["profile"].includes(k));
  const CUSTOMER_VISIBLE = ["dashboard", "complaints", "equipment", "invoices", "quotations", "profile", "terms", "privacy"];

  console.log("— 1. Staff login (existing session machinery)");
  const staffJar: Jar = new Map();
  const login = await api("POST", "/api/v1/auth/login", { email: "operations@mohdhms.com", password: PASSWORD }, staffJar);
  check("staff login 200", login.res.status === 200);

  console.log("— 2. Equipment QR: existing generation → jsQR decode → resolver → existing lookup endpoint");
  let eqToken = "";
  let eqId = "";
  {
    const list = await api("GET", "/api/v1/equipment?pageSize=1", undefined, staffJar);
    const rows = (list.data as { data?: Array<{ id: string }> })?.data ?? [];
    check("equipment list has a row", rows.length > 0);
    eqId = rows[0]?.id ?? "";
    if (eqId) {
      const qr = await api("GET", `/api/v1/equipment/${eqId}/qr`, undefined, staffJar);
      check("equipment QR endpoint 200", qr.res.status === 200);
      const qrData = (qr.data as { data?: { url?: string; dataUrl?: string } })?.data;
      const url = qrData?.url ?? "";
      const dataUrl = qrData?.dataUrl ?? "";
      check("QR encodes the equipment deep-link format", /\/\?resource=equipment:.+/.test(url), url);
      const png = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ""), "base64");
      const decoded = await decodeQrPng(png);
      check("jsQR decodes the generated equipment QR", decoded === url, `decoded=${decoded}`);
      eqToken = (url.split("resource=equipment:")[1] ?? "").trim();
      const resolution = resolveQrValue(decoded ?? "", ALL, STAFF_VISIBLE);
      check("resolver → equipment-token", JSON.stringify(resolution) === JSON.stringify({ kind: "equipment-token", token: eqToken }), JSON.stringify(resolution));
      // Labels encode the configured public_url which may differ from the
      // current origin (www vs apex / staging) — the app's own deep-link
      // format must still resolve (host is never navigated to).
      const alt = resolveQrValue(`https://other-host.example.com/?resource=equipment:${eqToken}`, ALL, STAFF_VISIBLE);
      check("deep link on a different host → equipment-token (public_url origin)", JSON.stringify(alt) === JSON.stringify({ kind: "equipment-token", token: eqToken }), JSON.stringify(alt));

      // The exact call the scanner page makes after detection:
      const lookup = await api("GET", `/api/v1/equipment/-/qr?token=${encodeURIComponent(eqToken)}`, undefined, staffJar);
      const lookupData = (lookup.data as { data?: { equipmentId?: string } })?.data;
      check("existing token lookup resolves the unit", lookup.res.status === 200 && lookupData?.equipmentId === eqId);

      // Bare token + equipment:{token} conventions (same as the shell QR dialog):
      check("bare token → equipment-token", resolveQrValue(eqToken, ALL, STAFF_VISIBLE).kind === "equipment-token");
      check("equipment:{token} → equipment-token", resolveQrValue(`equipment:${eqToken}`, ALL, STAFF_VISIBLE).kind === "equipment-token");
    }
  }

  console.log("— 3. IRMS report QR: existing generation → jsQR decode → resolver → route");
  {
    const list = await api("GET", "/api/v1/irms/reports?pageSize=1", undefined, staffJar);
    const rows = (list.data as { data?: Array<{ id: string }> })?.data ?? [];
    if (rows.length === 0) {
      console.log("  (no inspection reports seeded — skipping IRMS decode test)");
    } else {
      const id = rows[0].id;
      const res = await fetch(`${BASE}/api/v1/irms/reports/${id}/qr`, { headers: { cookie: cookieHeader(staffJar) } });
      check("IRMS QR endpoint 200 + PNG", res.status === 200 && res.headers.get("content-type")?.includes("image/png"));
      const decoded = await decodeQrPng(Buffer.from(await res.arrayBuffer()));
      check("jsQR decodes the generated IRMS QR", decoded === `${BASE}/irms/reports/${id}`, `decoded=${decoded}`);
      const resolution = resolveQrValue(decoded ?? "", ALL, STAFF_VISIBLE);
      check(
        "resolver → irms reports route (RESOURCE_ROUTES mapping)",
        JSON.stringify(resolution) === JSON.stringify({ kind: "route", module: "irms", seg: ["reports", id], query: {} }),
        JSON.stringify(resolution)
      );
    }
  }

  console.log("— 4. Resolver security / negative cases (spec §18–§21)");
  {
    check("external URL refused", resolveQrValue("https://evil.example.com/equipment/x", ALL, STAFF_VISIBLE).kind === "unsupported");
    check("external arbitrary deep-link host never navigated (only token extracted)", resolveQrValue("https://evil.example.com/?resource=equipment:abc", ALL, STAFF_VISIBLE).kind === "equipment-token");
    check("arbitrary text refused", resolveQrValue("hello canteen menu tuesday", ALL, STAFF_VISIBLE).kind === "unsupported");
    check("short arbitrary code refused", resolveQrValue("EQ-001", ALL, STAFF_VISIBLE).kind === "unsupported");
    check("unknown deep-link type refused", resolveQrValue(`${BASE}/?resource=complaint:xyz`, ALL, STAFF_VISIBLE).kind === "unsupported");
    check("scanner self-reference refused", resolveQrValue(`${BASE}/scan`, ALL, STAFF_VISIBLE).kind === "unsupported");
    check("bare origin refused", resolveQrValue(`${BASE}/`, ALL, STAFF_VISIBLE).kind === "unsupported");
    check("empty refused", resolveQrValue("  ", ALL, STAFF_VISIBLE).kind === "unsupported");
    const perm = resolveQrValue(`${BASE}/users/123`, ALL, CUSTOMER_VISIBLE);
    check("module hidden from the user → permission refusal", perm.kind === "unsupported" && perm.reason === "permission", JSON.stringify(perm));
    const okRoute = resolveQrValue(`${BASE}/complaints?status=open`, ALL, CUSTOMER_VISIBLE);
    check(
      "same-origin module URL preserves query params",
      JSON.stringify(okRoute) === JSON.stringify({ kind: "route", module: "complaints", seg: [], query: { status: "open" } }),
      JSON.stringify(okRoute)
    );
  }

  console.log("— 5. Customer RBAC on the lookup endpoint (IDOR / cross-tenant QR, spec §21/§38)");
  {
    const custJar: Jar = new Map();
    const clogin = await api("POST", "/api/v1/auth/login", { email: "customer1@demo.my", password: PASSWORD }, custJar);
    check("customer login 200", clogin.res.status === 200);
    if (eqToken) {
      const ownList = await api("GET", "/api/v1/equipment?pageSize=200", undefined, custJar);
      const ownRows = (ownList.data as { data?: Array<{ id: string }> })?.data ?? [];
      const ownsEq = ownRows.some((r) => r.id === eqId);
      const foreign = await api("GET", `/api/v1/equipment/-/qr?token=${encodeURIComponent(eqToken)}`, undefined, custJar);
      if (ownsEq) {
        check("customer can resolve their OWN equipment token", foreign.res.status === 200);
      } else {
        check("customer scanning ANOTHER customer's equipment token is refused (404, not leaked)", foreign.res.status === 404, `status=${foreign.res.status}`);
      }
      const anon = await fetch(`${BASE}/api/v1/equipment/-/qr?token=${encodeURIComponent(eqToken)}`);
      check("logged-out scanner lookup refused (401)", anon.status === 401, `status=${anon.status}`);
    }
  }

  console.log(`\nQR scanner QA: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  process.exit(1);
});
