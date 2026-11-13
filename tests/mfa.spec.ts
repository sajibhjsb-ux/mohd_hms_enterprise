// tests/mfa.spec.ts
// MFA_ENCRYPTION_KEY=<32-byte base64> MFA_E2E=1 bunx playwright test -c playwright.e2e.local.config.ts tests/mfa.spec.ts
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { generate as generateTotp } from "otplib";

const PASSWORD = "Password@123";
const EMAIL = "mfa-super@example.com";
const ADMIN = "mfa-admin@example.com";
const SUPERVISOR = "mfa-supervisor@example.com";

test.describe.configure({ mode: "serial" });

let lastSecret = "";
let lastTotpCode = "";
let recoveryCodes: string[] = [];
let adminId = "";
let supervisorId = "";

const mfaDescribe = process.env.MFA_E2E ? test.describe : () => ({});
mfaDescribe("MFA enrolment and login flows", () => {
  test.beforeAll(() => {
    execSync("bun --conditions=react-server scripts/mfa-test-fixtures.ts", { stdio: "inherit" });
  });

  async function apiFetch(page: any, path: string, method: "GET" | "POST" | "PUT", data?: unknown) {
    return page.evaluate(async ({ path, method, data }) => {
      const init: RequestInit = { method, credentials: "same-origin" };
      if (data !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(data);
      }
      const r = await fetch("http://127.0.0.1:37717" + path, init);
      return { status: r.status, ok: r.ok, body: await r.json().catch(() => null) };
    }, { path, method, data });
  }

  async function login(page: any, email: string) {
    await page.goto("/?auth=login");
    // Let Next.js hydrate the login form first; otherwise the submit handler
    // runs with empty form state and the server answers 400.
    await page.waitForTimeout(1500);
    await page.fill("#auth-email", email);
    await page.fill("#auth-password", PASSWORD);
    await page.click("button:has-text('Log In')");
    await page.waitForFunction(() => window.location.href.includes("auth=mfa") || window.location.pathname === "/dashboard", { timeout: 20_000 });
  }

  async function completeEnroll(page: any) {
    const enrollRes = await apiFetch(page, "/api/v1/auth/mfa/enroll", "POST");
    expect(enrollRes.ok).toBe(true);
    const { secret } = (enrollRes.body as { data: { secret: string } }).data;
    lastSecret = secret;
    const code = await generateTotp({ secret });
    lastTotpCode = code;
    const confirmRes = await apiFetch(page, "/api/v1/auth/mfa/confirm-enrollment", "POST", { code });
    expect(confirmRes.ok).toBe(true);
    recoveryCodes = (confirmRes.body as { data: { recoveryCodes: string[] } }).data.recoveryCodes;
    expect(recoveryCodes.length).toBe(10);
    await page.goto("/dashboard");
  }

  async function enrolUser(page: any, email: string) {
    await login(page, email);
    if (page.url().includes("auth=mfa-enroll")) await completeEnroll(page);
  }

  async function sessionUserId(page: any) {
    const res = await apiFetch(page, "/api/v1/auth/session", "GET");
    return (res.body as { data: { user: { id: string } } }).data.user.id;
  }

  test("pending MFA challenge cannot access a protected API", async ({ page }) => {
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa-enroll");
    const res = await apiFetch(page, "/api/v1/admin/security/mfa-policy", "GET");
    expect(res.status).toBe(401);
  });

  test("mandatory enrolment then login with TOTP", async ({ page }) => {
    await enrolUser(page, EMAIL);
    const res = await apiFetch(page, "/api/v1/auth/session", "GET");
    expect(res.ok).toBe(true);

    await apiFetch(page, "/api/v1/auth/logout", "POST");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    const code = await generateTotp({ secret: lastSecret });
    await page.getByLabel("6-digit authentication code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await page.goto("/dashboard");
  });

  test("reused TOTP step is rejected", async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByLabel("6-digit authentication code").fill(lastTotpCode);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Invalid verification code.")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(31_000);
    await page.getByLabel("6-digit authentication code").fill(await generateTotp({ secret: lastSecret }));
    await page.getByRole("button", { name: "Verify" }).click();
    await page.goto("/dashboard");
  });

  test("recovery code is single use", async ({ page }) => {
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.fill("#mfa-recovery-code", recoveryCodes[0]);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await page.waitForFunction(() => window.location.pathname === "/dashboard", { timeout: 20_000 });

    await apiFetch(page, "/api/v1/auth/logout", "POST");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.fill("#mfa-recovery-code", recoveryCodes[0]);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(page.getByText("Invalid verification code.")).toBeVisible({ timeout: 10_000 });
  });

  test("admin cannot escalate or self-reset", async ({ page }) => {
    await enrolUser(page, ADMIN);
    adminId = await sessionUserId(page);

    const escalate = await apiFetch(page, "/api/v1/admin/security/mfa-policy", "PUT", {
      policies: [{ role: "SUPER_ADMIN", policyMode: "OPTIONAL", gracePeriodDays: 0 }],
    });
    expect(escalate.status).toBe(403);

    const selfReset = await apiFetch(page, "/api/v1/admin/security/mfa-reset", "POST", { userId: adminId, reason: "testing" });
    expect(selfReset.status).toBe(400);

    const usersRes = await apiFetch(page, "/api/v1/admin/security/mfa-users", "GET");
    expect(usersRes.ok).toBe(true);
    supervisorId = (usersRes.body as { data: { users: { email: string; id: string }[] } }).data.users.find((u) => u.email === SUPERVISOR)!.id;

    const reset = await apiFetch(page, "/api/v1/admin/security/mfa-reset", "POST", { userId: supervisorId, reason: "lost device" });
    expect(reset.status).toBe(200);
  });
});
