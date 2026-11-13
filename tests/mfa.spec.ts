// tests/mfa.spec.ts
// MFA_E2E=1 bunx playwright test tests/mfa.spec.ts --project=desktop-laptop
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { authenticator } from "otplib";

const EMAIL = "mfa-super@example.com";
const ADMIN = "mfa-admin@example.com";
const SUPERVISOR = "mfa-supervisor@example.com";
const PASSWORD = "Password@123";

test.describe.configure({ mode: "serial" });

test.describe.skipIf(!process.env.MFA_E2E)("MFA enrolment and login flows", () => {
  test.beforeAll(() => {
    execSync("bun --conditions=react-server scripts/mfa-test-fixtures.ts", { stdio: "inherit" });
  });

  let recoveryCodes: string[] = [];
  let lastTotpCode = "";
  let adminId = "";
  let supervisorId = "";

  async function login(page: any, email: string) {
    await page.goto("/?auth=login");
    await page.fill("#auth-email", email);
    await page.fill("#auth-password", PASSWORD);
    await page.click("button:has-text('Log In')");
    await page.waitForURL(/\/(\?auth=(mfa|mfa-enroll))|dashboard/, { timeout: 20_000 });
  }

  async function completeEnroll(page: any) {
    const res = await page.request.post("/api/v1/auth/mfa/enroll");
    expect(res.ok()).toBe(true);
    const { secret } = await res.json();
    const code = authenticator.generate(secret);
    await page.getByLabel("6-digit authentication code").fill(code);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Save your recovery codes")).toBeVisible({ timeout: 15_000 });
    recoveryCodes = await page.locator('[data-testid="mfa-recovery-code"]').allTextContents();
    expect(recoveryCodes.length).toBe(10);
    await page.check("#mfa-codes-saved");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL("**/dashboard", { timeout: 20_000 });
  }

  async function completeTotp(page: any, code?: string) {
    const token = code ?? authenticator.generate("unused"); // placeholder replaced below
    await page.getByLabel("6-digit authentication code").fill(token);
    await page.getByRole("button", { name: "Verify" }).click();
  }

  async function enrollCurrentUser(page: any, email: string) {
    await login(page, email);
    if (page.url().includes("auth=mfa-enroll")) await completeEnroll(page);
    else if (page.url().includes("auth=mfa")) {
      const res = await page.request.post("/api/v1/auth/mfa/enroll");
      const { secret } = await res.json();
      await completeTotp(page, authenticator.generate(secret));
      await page.waitForURL("**/dashboard", { timeout: 20_000 });
    }
  }

  test("pending MFA challenge cannot access a protected API", async ({ page }) => {
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa-enroll");
    const res = await page.request.get("/api/v1/admin/security/mfa-policy");
    expect(res.status()).toBe(401);
  });

  test("mandatory enrolment then login with TOTP", async ({ page }) => {
    await enrollCurrentUser(page, EMAIL);
    const session = await page.request.get("/api/v1/auth/session");
    expect((await session.json()).authenticated).toBe(true);

    await page.request.post("/api/v1/auth/logout");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    const res = await page.request.post("/api/v1/auth/mfa/enroll");
    const { secret } = await res.json();
    lastTotpCode = authenticator.generate(secret);
    await completeTotp(page, lastTotpCode);
    await page.waitForURL("**/dashboard", { timeout: 20_000 });
  });

  test("reused TOTP step is rejected", async ({ page }) => {
    await page.request.post("/api/v1/auth/logout");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByLabel("6-digit authentication code").fill(lastTotpCode);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText("Invalid verification code.")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(31_000);
    const res = await page.request.post("/api/v1/auth/mfa/enroll");
    const { secret } = await res.json();
    await completeTotp(page, authenticator.generate(secret));
    await page.waitForURL("**/dashboard", { timeout: 20_000 });
  });

  test("recovery code is single use", async ({ page }) => {
    await page.request.post("/api/v1/auth/logout");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.fill("#mfa-recovery-code", recoveryCodes[0]);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await page.waitForURL("**/dashboard", { timeout: 20_000 });

    await page.request.post("/api/v1/auth/logout");
    await login(page, EMAIL);
    expect(page.url()).toContain("auth=mfa");
    await page.getByRole("button", { name: "Use a recovery code" }).click();
    await page.fill("#mfa-recovery-code", recoveryCodes[0]);
    await page.getByRole("button", { name: "Use recovery code" }).click();
    await expect(page.getByText("Invalid verification code.")).toBeVisible({ timeout: 10_000 });
  });

  test("admin cannot escalate or self-reset", async ({ page }) => {
    await enrollCurrentUser(page, ADMIN);
    const me = (await (await page.request.get("/api/v1/auth/session")).json()).user;
    adminId = me.id;

    const escalate = await page.request.put("/api/v1/admin/security/mfa-policy", {
      data: { policies: [{ role: "SUPER_ADMIN", policyMode: "OPTIONAL", gracePeriodDays: 0 }] },
    });
    expect(escalate.status()).toBe(403);

    const selfReset = await page.request.post("/api/v1/admin/security/mfa-reset", {
      data: { userId: adminId, reason: "testing" },
    });
    expect(selfReset.status()).toBe(400);

    await page.request.post("/api/v1/auth/logout");
    await login(page, SUPERVISOR);
    if (page.url().includes("auth=mfa-enroll")) await completeEnroll(page);
    else if (page.url().includes("auth=mfa")) {
      const res = await page.request.post("/api/v1/auth/mfa/enroll");
      const { secret } = await res.json();
      await completeTotp(page, authenticator.generate(secret));
      await page.waitForURL("**/dashboard", { timeout: 20_000 });
    }
    const sup = (await (await page.request.get("/api/v1/auth/session")).json()).user;
    supervisorId = sup.id;

    await page.request.post("/api/v1/auth/logout");
    await login(page, ADMIN);
    const reset = await page.request.post("/api/v1/admin/security/mfa-reset", {
      data: { userId: supervisorId, reason: "lost device" },
    });
    expect(reset.status()).toBe(200);
  });
});
