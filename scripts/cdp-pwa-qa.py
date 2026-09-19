#!/usr/bin/env python3
"""PWA offline QA via Playwright over the agent-browser CDP endpoint.

Usage: cdp-pwa-qa.py <offline|online|full>
- offline/online: toggle network emulation for the shared browser.
- full: offline → reload app (expect cached shell) → screenshot → online recovery.
"""
import subprocess
import sys
from playwright.sync_api import sync_playwright

def cdp_endpoint() -> str:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    url = r.stdout.strip().splitlines()[-1].strip()
    return url

mode = sys.argv[1] if len(sys.argv) > 1 else "status"
endpoint = cdp_endpoint()

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp(endpoint)
    ctx = browser.contexts[0]
    page = ctx.pages[0] if ctx.pages else ctx.new_page()

    if mode in ("offline", "online", "full"):
        ctx.set_offline(mode in ("offline", "full"))
        print(f"emulation set: {'OFFLINE' if mode in ('offline','full') else 'ONLINE'}")

    if mode == "full":
        # 1. offline reload — SW should serve the cached shell
        page.goto("http://localhost:3000/dashboard", wait_until="load", timeout=20000)
        page.wait_for_timeout(2500)
        title = page.title()
        pill = page.locator("text=Offline — some features are unavailable").count()
        body_len = len(page.content())
        print(f"[offline reload] title={title!r} offlinePill={pill} htmlBytes={body_len}")
        page.screenshot(path="/home/z/tmp-verify/pwa-offline-shell.png")
        # 2. unknown route offline → app router handles; SW may fall back to cached
        page.goto("http://localhost:3000/reports", wait_until="load", timeout=20000)
        page.wait_for_timeout(2000)
        print(f"[offline nav] url={page.url} htmlBytes={len(page.content())}")
        # 3. back online — recovery
        ctx.set_offline(False)
        print("emulation set: ONLINE")
        page.wait_for_timeout(4000)
        recovering = page.locator("text=Back online — synchronizing").count()
        print(f"[recovery] syncIndicator={recovering}")
        page.screenshot(path="/home/z/tmp-verify/pwa-recovered.png")

    browser.close()
