#!/usr/bin/env python3
"""Complete PWA QA: SW update via UI, warm caches, offline boot, recovery."""
import subprocess
from playwright.sync_api import sync_playwright

def cdp():
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    return r.stdout.strip().splitlines()[-1].strip()

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(cdp())
    ctx = browser.contexts[0]
    page = ctx.pages[0]

    # 1. Trigger SW update check
    page.evaluate("(async () => { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update(); })()")
    # Wait for the update dialog (organic UI flow) up to 12s
    try:
        btn = page.get_by_role("button", name="Refresh now")
        btn.wait_for(state="visible", timeout=12000)
        print("[update UI] dialog appeared -> clicking Refresh now")
        btn.click()
    except Exception:
        # Fallback: activate programmatically
        page.evaluate("""(async () => {
            const r = await navigator.serviceWorker.getRegistration();
            if (r && r.waiting) r.waiting.postMessage({type: 'SKIP_WAITING'});
        })()""")
        print("[update UI] dialog not shown -> programmatic SKIP_WAITING")
    page.wait_for_timeout(5000)
    page.reload(wait_until="load", timeout=30000)
    page.wait_for_timeout(4000)
    st = page.evaluate("""(async () => {
        const r = await navigator.serviceWorker.getRegistration();
        const out = [];
        for (const k of await caches.keys()) out.push(k+'='+(await (await caches.open(k)).keys()).length);
        return {active: r?.active?.state, waiting: !!r?.waiting, caches: out.join(' | ')};
    })()""")
    print("[state]", st)

    # 2. Warm-up pass (fills v2 caches)
    page.reload(wait_until="load", timeout=30000)
    page.wait_for_timeout(4000)
    st = page.evaluate("""(async () => {
        const out = [];
        for (const k of await caches.keys()) out.push(k+'='+(await (await caches.open(k)).keys()).length);
        return out.join(' | ');
    })()""")
    print("[warmup caches]", st)

    # 3. OFFLINE reload
    ctx.set_offline(True)
    page.reload(wait_until="load", timeout=20000)
    page.wait_for_timeout(4000)
    on_line = page.evaluate("navigator.onLine")
    mounted = page.locator('button[aria-label*="dashboard" i]').count()
    pill = page.locator("text=Offline — some features").count()
    notif = page.locator('button[aria-label*="Notifications" i]').count()
    print(f"[OFFLINE reload] onLine={on_line} appMounted={mounted>0} offlinePill={pill>0} notifBell={notif>0}")
    page.screenshot(path="/home/z/tmp-verify/pwa-offline-dashboard.png")

    # 4. Offline navigation to an uncached route → offline.html fallback
    page.goto("http://localhost:3000/unknown-route-xyz", wait_until="load", timeout=20000)
    page.wait_for_timeout(1500)
    print(f"[OFFLINE unknown route] url={page.url} title={page.title()!r}")

    # 5. ONLINE recovery (no reload — live app listens)
    page.goto("http://localhost:3000/dashboard", wait_until="load", timeout=20000)
    page.wait_for_timeout(1500)
    ctx.set_offline(False)
    page.wait_for_timeout(4500)
    recovering = page.locator("text=Back online — synchronizing").count()
    toast = page.locator("text=Synchronization complete").count()
    pill_gone = page.locator("text=Offline — some features").count() == 0
    print(f"[RECOVERY] syncPill={recovering>0} completeToast={toast>0} offlinePillGone={pill_gone}")
    page.screenshot(path="/home/z/tmp-verify/pwa-recovery.png")

    browser.close()
