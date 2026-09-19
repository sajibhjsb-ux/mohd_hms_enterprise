#!/usr/bin/env python3
"""Definitive PWA offline/recovery QA (Playwright over CDP)."""
import subprocess
from playwright.sync_api import sync_playwright

def cdp_endpoint() -> str:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    return r.stdout.strip().splitlines()[-1].strip()

endpoint = cdp_endpoint()

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(endpoint)
    ctx = browser.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()

    # ONLINE warm-up: ensure shell + chunks cached, app hydrated.
    page.goto("http://localhost:3000/dashboard", wait_until="load", timeout=30000)
    page.wait_for_timeout(3500)
    sw = page.evaluate("""navigator.serviceWorker.getRegistration().then(r => ({
        controller: !!navigator.serviceWorker.controller, active: r?.active?.state }))""")
    print("[online] SW:", sw)
    caches_ = page.evaluate("""caches.keys().then(async ks => {
        const out = [];
        for (const k of ks) out.push(k + '=' + (await caches.open(k)).keys().length);
        return out.join(' | ');
    })""")
    print("[online] caches:", caches_)
    app_mounted = page.locator('button[aria-label*="dashboard" i]').count()
    print("[online] app mounted (header brand):", app_mounted > 0)

    # OFFLINE: reload, expect cached shell + hydrated app + offline pill.
    ctx.set_offline(True)
    page.reload(wait_until="load", timeout=20000)
    page.wait_for_timeout(3000)
    on_line = page.evaluate("navigator.onLine")
    mounted = page.locator('button[aria-label*="dashboard" i]').count()
    pill = page.locator("text=Offline — some features").count()
    title = page.title()
    print(f"[offline reload] navigator.onLine={on_line} appMounted={mounted > 0} pill={pill} title={title!r}")
    page.screenshot(path="/home/z/tmp-verify/pwa-offline-dashboard.png")

    # ONLINE again WITHOUT reload — expect recovery indicator in the live app.
    ctx.set_offline(False)
    page.wait_for_timeout(4000)
    recovering = page.locator("text=Back online — synchronizing").count()
    complete_toast = page.locator("text=Synchronization complete").count()
    pill_after = page.locator("text=Offline — some features").count()
    print(f"[recovery] syncPill={recovering} completeToast={complete_toast} offlinePillGone={pill_after == 0}")
    page.screenshot(path="/home/z/tmp-verify/pwa-recovery.png")

    browser.close()
