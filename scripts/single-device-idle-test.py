#!/usr/bin/env python3
"""§37 TEST 3 — >5-minute IDLE test: no inactivity auto-logout exists.

Login → open the app → idle 5.6 minutes with ZERO interaction (the inactivity
activity-ping system no longer exists) → the session must still be active,
APIs working, presence online, no warning dialog. Then §18 explicit logout.
"""
import subprocess, time, json, sys
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"
results = []

def ok(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'} {name}{' — ' + str(detail) if detail else ''}")

def sh(cmd):
    return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=30)

def rt_presence():
    r = sh("curl -s -m 3 http://127.0.0.1:3004/internal/health -H 'x-realtime-secret: hms-realtime-internal-secret-v1'")
    try:
        return json.loads(r.stdout)["data"]["presence"]
    except Exception:
        return []

def dismiss_dialogs(page):
    for _ in range(4):
        if page.locator('[role="dialog"]').count() == 0:
            return
        btn = page.locator('[role="dialog"] button:has-text("Continue")')
        if btn.count():
            btn.first.click()
        else:
            page.keyboard.press("Escape")
        page.wait_for_timeout(800)

def logged_in(page):
    return page.locator('button[aria-label="Profile"]').count() > 0

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    cdp = r.stdout.strip().splitlines()[-1].strip()
    browser = p.chromium.connect_over_cdp(cdp)
    ctx_a = browser.contexts[0]
    for extra in list(ctx_a.pages):
        extra.close()
    page_a = ctx_a.new_page()
    page_a.set_default_timeout(15000)

    try:
        ok("A API login 200", ctx_a.request.post(APP + "/api/v1/auth/login", data={"email": "admin@mohdhms.com", "password": "Password@123"}).status == 200)
        page_a.goto(APP + "/terms", wait_until="load")
        page_a.wait_for_timeout(2500)
        dismiss_dialogs(page_a)
        ok("A logged in", logged_in(page_a), page_a.url)

        print("    ... idling 5.6 minutes with ZERO interaction ...")
        idle_seconds = 336
        stepped = 0
        while stepped < idle_seconds:
            page_a.wait_for_timeout(10000)
            stepped += 10
            if stepped % 120 == 0:
                print(f"    [idle] {stepped}s elapsed")

        ok("§35/§37-3: still logged in after 5.6 minutes idle", logged_in(page_a) and "auth=login" not in page_a.url, page_a.url)
        ok("No inactivity warning dialog exists anywhere", page_a.locator('[data-testid="idle-warning-dialog"]').count() == 0)
        sess = page_a.evaluate("fetch('/api/v1/auth/session').then(r => r.json())")
        ok("Session API still ACTIVE (authenticated)", sess.get("data", {}).get("authenticated") is True, sess.get("data"))
        prot = page_a.evaluate("fetch('/api/v1/notifications?take=1').then(r => r.status)")
        ok("Protected APIs keep working (200)", prot == 200, prot)
        ok("Presence still shows the idle device online", any(e["name"] == "MohdAdmin" for e in rt_presence()), rt_presence())
        page_a.screenshot(path="/tmp/sad-idle-survived.png")

        print("── §18: explicit logout still works ──")
        page_a.locator('button[aria-label="Profile"]').click(); page_a.wait_for_timeout(700)
        page_a.locator("text=Sign out").first.click(); page_a.wait_for_timeout(2500)
        ok("Manual logout lands on the auth flow", (not logged_in(page_a)) or "auth=login" in page_a.url, page_a.url)
        prot2 = page_a.evaluate("fetch('/api/v1/notifications?take=1').then(r => r.status)")
        ok("Session gone after explicit logout (401)", prot2 == 401, prot2)

    finally:
        page_a.close()

print("\n══ IDLE TEST SUMMARY ══")
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
for n, c, d in results:
    if not c:
        print(f"  FAILED: {n} ({d})")
sys.exit(1 if fails else 0)
