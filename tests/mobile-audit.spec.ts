/**
 * MOHD.HMS ENTERPRISE — FacilityPro Mobile Responsiveness & Functional Audit.
 *
 * Runs the same audit across mobile phones, tablets and desktops against the
 * locally running app (http://127.0.0.1:3000). Captures:
 *   - JavaScript console errors
 *   - Failed network requests (4xx / 5xx)
 *   - Horizontal overflow (body scrollWidth > viewport width)
 *   - Page load success per route
 *
 * Tests use a pre-saved authenticated SUPER_ADMIN session (see
 * tests/auth-setup.spec.ts) — one login only, avoiding the rate limit.
 * All navigation is read-only — no records created, edited or deleted.
 */

import { test, expect } from "@playwright/test";

// Read-only module list pages safe to open (SUPER_ADMIN sees all).
const MODULE_LIST_PAGES = [
  "dashboard",
  "complaints",
  "work-orders",
  "checklists",
  "equipment",
  "pm",
  "customers",
  "users",
  "employees",
  "technicians",
  "inventory",
  "purchases",
  "quotations",
  "invoices",
  "finance",
  "hr",
  "email",
  "whatsapp",
  "irms",
  "files",
  "vehicles",
  "reports",
  "audit",
  "settings",
];

async function captureViolations(page) {
  const jsErrors: string[] = [];
  const failedRequests: { url: string; status: number } = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") jsErrors.push(msg.text());
  });
  page.on("pageerror", (err) => jsErrors.push(err.message));
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push({ url: res.url(), status: res.status() });
    }
  });
  return { jsErrors, failedRequests };
}

async function measureOverflow(page) {
  return await page.evaluate(() => {
    const body = document.documentElement;
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: body.scrollWidth,
      overflow: body.scrollWidth > window.innerWidth,
      overflowPx: Math.max(0, body.scrollWidth - window.innerWidth),
    };
  });
}

test.use({ storageState: "playwright/.auth/admin.json" });

test.describe("FacilityPro mobile audit", () => {
  test("dashboard loads without overflow or errors", async ({ page }) => {
    const { jsErrors, failedRequests } = await captureViolations(page);
    await page.goto("/dashboard");
    await page.waitForTimeout(1_500);
    const overflow = await measureOverflow(page);
    await page.screenshot({ fullPage: true });
    expect(overflow.overflow).toBe(false);
    expect(jsErrors.filter((e) => !e.includes("favicon") && !e.includes("chrome-extension"))).toEqual([]);
    expect(failedRequests.filter((r) => r.status >= 500)).toEqual([]);
  });

  test.describe("module list pages — read-only navigation", () => {
    for (const module of MODULE_LIST_PAGES) {
      test(`${module} loads without overflow or errors`, async ({ page }) => {
        const { jsErrors, failedRequests } = await captureViolations(page);
        await page.goto(`/${module}`);
        await page.waitForTimeout(1_500); // let the module render + fetch
        const overflow = await measureOverflow(page);
        await page.screenshot({ fullPage: true });
        expect(overflow.overflow, `${module}: horizontal overflow`).toBe(false);
        const criticalJs = jsErrors.filter((e) => !e.includes("favicon") && !e.includes("chrome-extension"));
        expect(criticalJs, `${module}: JS errors`).toEqual([]);
        expect(failedRequests.filter((r) => r.status >= 500), `${module}: 5xx responses`).toEqual([]);
      });
    }
  });
});
