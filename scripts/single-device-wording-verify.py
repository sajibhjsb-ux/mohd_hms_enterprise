#!/usr/bin/env python3
"""§4/§30 — Login & Session Security wording: single-device policy stated,
5-minute timeout nowhere, auto-login OFF state copy exact."""
import subprocess, sys
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"
res = []
def ok(name, cond, detail=""):
    res.append(bool(cond))
    print(f"  {'PASS' if cond else 'FAIL'} {name}{' — ' + str(detail) if detail else ''}", flush=True)

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    browser = p.chromium.connect_over_cdp(r.stdout.strip().splitlines()[-1].strip())
    ctx = browser.contexts[0]
    for extra in list(ctx.pages):
        try: extra.close()
        except Exception: pass
    page = ctx.new_page()
    page.set_default_timeout(20000)
    try:
        st = ctx.request.post(APP + "/api/v1/auth/login", data={"email": "admin@mohdhms.com", "password": "Password@123"}).status
        ok("login 200", st == 200, st)
        page.goto(APP + "/profile", wait_until="load")
        page.wait_for_selector('[data-testid="security-sessions-card"]', timeout=20000)
        card = page.locator('[data-testid="security-sessions-card"]')
        text = card.inner_text()
        ok("card title 'Login & Session Security'", "Login & Session Security" in text)
        ok("single-device policy stated (§30)", "Only one device can be actively signed in to this account at a time" in text and "another device automatically ends the previous active session" in text)
        ok("password-never-stored stated", "Your password is never stored" in text)
        ok("no 5-minute timeout wording anywhere on the card", "5-minute" not in text and "5 minute" not in text and "inactivity" not in text.lower())
        ok("auto login OFF state copy exact (§30)", "Auto login disabled for this device." in text, )
        ok("active sessions list rendered", page.locator('[data-testid="session-list"]').count() == 1)
        # whole-page sweep for stray legacy wording
        body = page.locator("body").inner_text()
        ok("no 5-minute/inactivity wording anywhere on the profile page", "5-minute" not in body and "inactivity timeout" not in body.lower())
        page.screenshot(path="/tmp/final-security-card.png", full_page=True)
    finally:
        page.close()

print(f"{sum(res)}/{len(res)} PASS", flush=True)
sys.exit(0 if all(res) else 1)
