import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = {
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "list" : "html",
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "mobile-small-android",
      use: { device: "Pixel 5", locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "mobile-iphone-se",
      use: { device: "iPhone SE", locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "mobile-iphone-13",
      use: { device: "iPhone 13", locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "mobile-iphone-14-pro-max",
      use: { device: "iPhone 14 Pro Max", locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "mobile-samsung-galaxy",
      use: { viewport: { width: 360, height: 800 }, locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "tablet-ipad",
      use: { device: "iPad Air", locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "tablet-landscape",
      use: { viewport: { width: 1024, height: 768 }, locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "desktop-laptop",
      use: { viewport: { width: 1366, height: 768 }, locale: "en-US", timezoneId: "Asia/Brunei" },
    },
    {
      name: "desktop-large",
      use: { viewport: { width: 1920, height: 1080 }, locale: "en-US", timezoneId: "Asia/Brunei" },
    },
  ],
  webServer: undefined,
};

export default config;
