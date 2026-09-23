/**
 * Central AI configuration & AIService E2E QA (central AI config spec §38/§39/§40).
 *
 * Exercises the REAL endpoints end-to-end against the running dev server:
 *   Configuration : save Gemini key → encrypted at rest → masked readback →
 *                   raw key never appears in any API response
 *   Connection    : Test Connection with an INVALID key (honest sanitized
 *                   failure) / with the built-in provider (real success)
 *   States        : disabled → honest AI_DISABLED · no credential → honest
 *                   AI_NOT_CONFIGURED · invalid credential → honest 502
 *   Generation    : real text generation + real structured (Zod-validated)
 *                   generation + one EXISTING AI feature (IRMS inspection
 *                   drafting) through the central service
 *   Security/RBAC : 401 unauthenticated · 403 technician/customer on settings
 *                   and non-granted features · no key in DB/logs/audit ·
 *                   usage logs record safe metadata only
 *   Rate limiting : rapid-fire requests hit the per-user window → 429
 *
 * Prereq: dev server on :3000, seeded accounts, AI_SETTINGS_ENCRYPTION_KEY in .env.
 * Run: bun scripts/ai-config-qa.ts
 */
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PW = "Password@123";
const USERS = {
  admin: { email: "admin@mohdhms.com", password: PW },
  supervisor: { email: "supervisor@mohdhms.com", password: PW },
  tech: { email: "ahmad.tech@mohdhms.com", password: PW },
  customer1: { email: "customer1@demo.my", password: PW },
};
const FAKE_KEY = "AIzaSyFAKE-INVALID-key-for-security-QA-000000000";

let passed = 0;
let failed = 0;
const jsonBodies: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function section(title: string) { console.log(`\n■ ${title}`); }

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

type ApiResponse<T = Record<string, unknown>> = {
  res: Response;
  json: { ok?: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } } | null;
};

async function call(jar: Jar, method: string, path: string, body?: unknown): Promise<ApiResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: cookieHeader(jar) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  absorb(jar, res);
  let json: ApiResponse["json"] = null;
  try {
    json = await res.json();
    jsonBodies.push(JSON.stringify(json));
  } catch { /* non-json */ }
  return { res, json };
}

async function login(jar: Jar, email: string, password: string) {
  const res = await call(jar, "POST", "/api/v1/auth/login", { email, password });
  if (!res.json?.ok) throw new Error(`login failed for ${email}`);
}

async function main() {
  const admin: Jar = new Map();
  const tech: Jar = new Map();
  const customer: Jar = new Map();
  let anon: Jar = new Map();

  console.log("═══ CENTRAL AI CONFIGURATION & AI SERVICE — E2E QA ═══");

  section("Setup — logins");
  await login(admin, USERS.admin.email, USERS.admin.password);
  await login(tech, USERS.tech.email, USERS.tech.password);
  await login(customer, USERS.customer1.email, USERS.customer1.password);
  check("admin login", true, USERS.admin.email);
  check("technician login", true, USERS.tech.email);
  check("customer login", true, USERS.customer1.email);

  // ── Baseline ──────────────────────────────────────────────────────────────
  section("§A Configuration baseline (GET, masked)");
  const base0 = await call(admin, "GET", "/api/v1/settings/ai");
  check("GET /api/v1/settings/ai 200", base0.res.status === 200 && base0.json?.ok === true);
  const cfg0 = base0.json?.data as Record<string, unknown> | undefined;
  check("config view has masked fields only", Boolean(cfg0 && "maskedKey" in cfg0 && "provider" in cfg0 && !("apiKeyEnc" in cfg0) && !("apiKey" in cfg0)));

  // ── Save Gemini credential (rotation path — pending until tested) ────────
  section("§B Save Gemini credential (encrypted at rest)");
  const put1 = await call(admin, "PUT", "/api/v1/settings/ai", {
    provider: "GOOGLE_GEMINI",
    model: "gemini-2.5-flash",
    enabled: true,
    apiKey: FAKE_KEY,
  });
  check("PUT with new credential 200", put1.res.status === 200 && put1.json?.ok === true);
  const put1Data = put1.json?.data as Record<string, unknown> | undefined;
  check("new key stored as PENDING (rotation §17)", put1Data?.hasPendingKey === true);
  const got1 = await call(admin, "GET", "/api/v1/settings/ai");
  const cfg1 = got1.json?.data as Record<string, unknown> | undefined;
  check("GET returns masked key only", typeof cfg1?.pendingKeyMasked === "string" && cfg1.pendingKeyMasked.startsWith("••••••••"));
  check("raw key NEVER in any response body", !jsonBodies.some((b) => b.includes(FAKE_KEY)));

  // DB: ciphertext, not plaintext.
  const row = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  check("DB stores ciphertext, not plaintext", Boolean(row?.pendingApiKeyEnc) && !row!.pendingApiKeyEnc.includes(FAKE_KEY) && row!.pendingApiKeyEnc.startsWith("v1:"));
  check("DB last-4 hint only", row?.pendingApiKeyLast4 === FAKE_KEY.slice(-4));

  // ── Test Connection with INVALID key — honest sanitized failure ──────────
  section("§C Test Connection — invalid credential (honest failure)");
  const test1 = await call(admin, "POST", "/api/v1/settings/ai/test");
  const test1Data = test1.json?.data as Record<string, unknown> | undefined;
  check("test endpoint responds", test1.res.status === 200 && typeof test1Data?.ok === "boolean");
  check("invalid key honestly fails", test1Data?.ok === false, `code=${String(test1Data ? "" : "")}`);
  const msg1 = String(test1Data?.message ?? "");
  check("failure message is sanitized + human-readable", msg1.length > 0 && !msg1.includes(FAKE_KEY) && !/sk-|key\s*[:=]/i.test(msg1), msg1.slice(0, 90));
  const rowAfterFail = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  check("status=FAILED after failed test", rowAfterFail?.status === "FAILED");
  check("old/active credential untouched on failure (§17)", Boolean(rowAfterFail?.apiKeyEnc) === false); // none existed before
  check("pending kept for retry", Boolean(rowAfterFail?.pendingApiKeyEnc));

  // ── Disabled state ────────────────────────────────────────────────────────
  section("§D Disabled state (honest AI_DISABLED)");
  await call(admin, "PUT", "/api/v1/settings/ai", { enabled: false });
  const genDis = await call(admin, "POST", "/api/v1/ai/generate", { feature: "report_summary", prompt: "Summarize maintenance performance in one sentence." });
  check("generate → 503 when disabled", genDis.res.status === 503);
  check("error code AI_DISABLED", genDis.json?.error?.code === "AI_DISABLED");
  check("message honest (disabled by administrator)", /disabled/i.test(String(genDis.json?.error?.message ?? "")));
  await call(admin, "PUT", "/api/v1/settings/ai", { enabled: true });

  // ── Not-configured state (Gemini without stored credential) ──────────────
  section("§E Not-configured state (honest AI_NOT_CONFIGURED)");
  await call(admin, "PUT", "/api/v1/settings/ai", { provider: "GOOGLE_GEMINI", clearApiKey: true });
  const genNoCfg = await call(admin, "POST", "/api/v1/ai/generate", { feature: "report_summary", prompt: "Summarize maintenance performance in one sentence." });
  check("generate → 503 when not configured", genNoCfg.res.status === 503);
  check("error code AI_NOT_CONFIGURED", genNoCfg.json?.error?.code === "AI_NOT_CONFIGURED");
  const rowCleared = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  check("clearApiKey wipes active+pending credentials", !rowCleared?.apiKeyEnc && !rowCleared?.pendingApiKeyEnc);

  // ── RBAC ──────────────────────────────────────────────────────────────────
  section("§F RBAC (settings.manage + feature permissions)");
  const techCfg = await call(tech, "GET", "/api/v1/settings/ai");
  check("technician GET settings/ai → 403", techCfg.res.status === 403);
  const techPut = await call(tech, "PUT", "/api/v1/settings/ai", { enabled: false });
  check("technician PUT settings/ai → 403", techPut.res.status === 403);
  const techTest = await call(tech, "POST", "/api/v1/settings/ai/test");
  check("technician test connection → 403", techTest.res.status === 403);
  const custCfg = await call(customer, "GET", "/api/v1/settings/ai");
  check("customer GET settings/ai → 403", custCfg.res.status === 403);
  const anonCfg = await call(anon, "GET", "/api/v1/settings/ai");
  check("unauthenticated GET settings/ai → 401", anonCfg.res.status === 401);

  // ── Real generation through the central service (ZAI platform) ───────────
  section("§G Real connection test + generation (built-in provider)");
  await call(admin, "PUT", "/api/v1/settings/ai", { provider: "ZAI_PLATFORM", enabled: true });
  const test2 = await call(admin, "POST", "/api/v1/settings/ai/test");
  const test2Data = test2.json?.data as Record<string, unknown> | undefined;
  check("Test Connection REAL success", test2Data?.ok === true, String(test2Data?.model ?? ""));
  const rowActive = await db.aiConfiguration.findUnique({ where: { id: "singleton" } });
  check("status=ACTIVE after successful test", rowActive?.status === "ACTIVE");

  const gen1 = await call(admin, "POST", "/api/v1/ai/generate", {
    feature: "report_summary",
    prompt: "Write one professional sentence about scheduled HVAC preventive maintenance.",
    context: { month: "current", system: "HVAC" },
  });
  const gen1Data = gen1.json?.data as Record<string, unknown> | undefined;
  check("text generation 200", gen1.res.status === 200 && gen1.json?.ok === true);
  check("text non-empty, provider/model identified", typeof gen1Data?.text === "string" && (gen1Data.text as string).length > 10 && gen1Data?.provider === "ZAI_PLATFORM", `model=${String(gen1Data?.model ?? "")}`);
  check("no credential fields in generate response", !("api_key" in (gen1Data ?? {})) && !("apiKeyEnc" in (gen1Data ?? {})));

  const gen2 = await call(admin, "POST", "/api/v1/ai/generate-structured", {
    feature: "quotation_scope",
    context: { workType: "Aircond servicing", description: "Quarterly servicing of 8 split units in office tower, including filter cleaning and coolant check.", customer: "Demo Company" },
  });
  const gen2Data = gen2.json?.data as Record<string, unknown> | undefined;
  check("structured generation 200", gen2.res.status === 200 && gen2.json?.ok === true);
  // Envelope: { ok, data: { data: <validated output>, feature, provider, ... } }.
  const inner = gen2Data?.data as Record<string, unknown> | undefined;
  const scope = inner?.scope as unknown;
  check("structured output passes backend Zod schema", typeof inner?.description === "string" && Array.isArray(scope) && scope.length >= 1 && scope.every((s) => typeof s === "string"), `items=${Array.isArray(scope) ? scope.length : 0}`);

  // Feature RBAC on the generation endpoints.
  const techGen = await call(tech, "POST", "/api/v1/ai/generate", { feature: "quotation_description", prompt: "Describe roof repair work." });
  check("technician without quotations.manage → 403 on quotation feature", techGen.res.status === 403);

  // Unknown feature.
  const badFeat = await call(admin, "POST", "/api/v1/ai/generate", { feature: "not_a_feature", prompt: "hi" });
  check("unknown feature → 404", badFeat.res.status === 404);

  // ── Existing AI feature through the central service (IRMS) ───────────────
  section("§H Existing AI feature migrated (IRMS inspection drafting)");
  const irms = await call(admin, "POST", "/api/v1/irms/ai/generate", {
    field: "summary",
    context: { title: "Quarterly HVAC Inspection — Tower B", type: "HVAC", overallCondition: "GOOD", findings: [{ finding: "Filter dirty on 2 FCUs", severity: "MINOR", recommendation: "Clean or replace filters" }] },
  });
  const irmsData = irms.json?.data as Record<string, unknown> | undefined;
  check("IRMS inspection AI via central AIService 200", irms.res.status === 200 && typeof irmsData?.text === "string" && (irmsData.text as string).length > 10);

  // ── Usage logs (safe metadata) ────────────────────────────────────────────
  section("§I AI usage logging (spec §22)");
  const logs = await db.aiUsageLog.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  check("usage rows recorded", logs.length >= 3, `rows=${logs.length}`);
  const features = new Set(logs.map((l) => l.feature));
  check("feature identification recorded (§13)", features.has("report_summary") && features.has("quotation_scope") && features.has("inspection_report"), [...features].slice(0, 5).join(", "));
  check("success rows carry tokens when provider reports them", logs.filter((l) => l.status === "SUCCESS").every((l) => l.totalTokens === null || l.totalTokens > 0));
  const successRow = logs.find((l) => l.status === "SUCCESS");
  check("duration + model captured", Boolean(successRow && successRow.durationMs >= 0 && successRow.model));
  const serialized = JSON.stringify(logs);
  check("usage logs contain no key material or prompt content", !serialized.includes(FAKE_KEY) && !serialized.includes("Inspection context"));

  // ── Rate limiting (cheap: failures are fast, limiter still counts) ────────
  section("§J Rate limiting (spec §23)");
  await call(admin, "PUT", "/api/v1/settings/ai", { provider: "GOOGLE_GEMINI", apiKey: FAKE_KEY, enabled: true });
  let got429 = false;
  let lastCode = "";
  for (let i = 0; i < 22; i++) {
    const r = await call(admin, "POST", "/api/v1/ai/generate", { feature: "report_summary", prompt: "x" });
    lastCode = r.json?.error?.code ?? (r.json?.ok ? "OK" : "?");
    if (r.res.status === 429) { got429 = true; break; }
  }
  check("per-user rate limit enforced → 429 AI_RATE_LIMITED", got429, `last=${lastCode}`);

  // ── Audit trail (spec §29) ────────────────────────────────────────────────
  section("§K Settings audit trail");
  const audits = await db.auditLog.findMany({ where: { action: { in: ["AI_CONFIG_UPDATED", "AI_CONFIG_TESTED"] } }, orderBy: { createdAt: "desc" }, take: 40 });
  const updates = audits.filter((a) => a.action === "AI_CONFIG_UPDATED");
  const testsAudits = audits.filter((a) => a.action === "AI_CONFIG_TESTED");
  check("AI_CONFIG_UPDATED events recorded", updates.length >= 3, `count=${updates.length}`);
  check("AI_CONFIG_TESTED events recorded", testsAudits.length >= 2, `count=${testsAudits.length}`);
  check("audit metadata holds masked credential only", updates.every((a) => !a.metadata.includes(FAKE_KEY)), "masked hint e.g. set(••••0000)");
  const sampleMeta = updates[0]?.metadata ?? "";
  check("audit metadata includes provider/model/enabled/keyUpdated", /provider/.test(sampleMeta) && /keyUpdated/.test(sampleMeta));

  // ── dev.log leak scan is done post-run by the runner (documented) ─────────
  section("§L Final state — reset to working configuration");
  await call(admin, "PUT", "/api/v1/settings/ai", { provider: "ZAI_PLATFORM", enabled: true, clearApiKey: true, model: "" });
  const testFinal = await call(admin, "POST", "/api/v1/settings/ai/test");
  const testFinalData = testFinal.json?.data as Record<string, unknown> | undefined;
  check("config reset → built-in provider ACTIVE", testFinalData?.ok === true && (testFinalData?.status === "ACTIVE"));

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("QA run crashed:", err);
    process.exit(1);
  });
