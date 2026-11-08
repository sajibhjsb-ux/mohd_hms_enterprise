/**
 * Auth setup — logs in once as a seeded SUPER_ADMIN and persists the session
 * cookie to storageState so every audit test is already authenticated.
 * This avoids hitting the login rate limit (8 attempts / 5 min per IP+email).
 * Read-only: no records created, edited or deleted.
 */

import { test, expect } from "@playwright/test";

const EMAIL = "admin@mohdhms.com";
const PASSWORD = "Password@123";
const STORAGE_STATE = "playwright/.auth/admin.json";

test.use({ storageState: { cookies: [], origins: [] } });

test("authenticate as SUPER_ADMIN and save session", async ({ page }) => {
  await page.goto("/?auth=login");
  await page.click("#auth-email");
  await page.type("#auth-email", EMAIL, { delay: 5 });
  await page.click("#auth-password");
  await page.type("#auth-password", PASSWORD, { delay: 5 });
  await page.click("button:has-text('Log In')");
  await page.waitForURL("**/dashboard", { timeout: 20_000 });
  await expect(page.locator("header")).toBeVisible({ timeout: 10_000 });
  // Persist the authenticated session (cookie) for all subsequent tests.
  await page.context().storageState({ path: STORAGE_STATE });
});
