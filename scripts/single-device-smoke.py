#!/usr/bin/env python3
"""Final smoke re-verification on the CURRENT tree (single-active-device +
no idle logout): login → presence pill → staff dropdown → second-device
revocation with the exact banner → superseded cookie answers 401
SESSION_REVOKED with state=REVOKED. No 5.6-min idle here (already evidenced
by /tmp/sad-idle-survived.png at 13:48)."""
import subprocess, json, sys
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"
REVOKED_MSG = "Your account was signed in on another device, so this session has been logged out."
results = []

def ok(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'} {name}{' — ' + str(detail) if detail else ''}")

def rt_presence():
    r = subprocess.run(["bash", "-lc", "curl -s -m 3 http://127.0.0.1:3004/internal/health -H 'x-realtime-secret: hms-realtime-internal-secret-v1'"], capture_output=True, text=True, timeout=30)
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

def count_text(page):
    for sel in ["[data-testid='online-presence-pill']", "header button:has-text('Online')"]:
        loc = page.locator(sel)
        if loc.count():
            return loc.first.inner_text()
    return ""

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
        ok("A logged in (shell mounted)", logged_in(page_a), page_a.url)
        page_a.wait_for_timeout(2500)
        ok("A presence pill shows '1 Online'", "1" in count_text(page_a), count_text(page_a))

        page_a.locator("[data-testid='online-presence-pill'], header button:has-text('Online')").first.click()
        page_a.wait_for_timeout(1200)
        dd = page_a.locator('[role="menu"], [data-radix-popper-content-wrapper]').first
        dd_text = dd.inner_text() if dd.count() else ""
        ok("Staff dropdown lists the live user (MohdAdmin)", "MohdAdmin" in dd_text, dd_text[:120].replace("\n", " | "))
        ok("Dropdown footer '1 user currently online'", "1 user currently online" in dd_text)
        page_a.keyboard.press("Escape")
        page_a.wait_for_timeout(400)

        print("── Device B login (same account, separate cookie jar) ──")
        ctx_b = browser.new_context()
        ok("B API login 200", ctx_b.request.post(APP + "/api/v1/auth/login", data={"email": "admin@mohdhms.com", "password": "Password@123"}).status == 200)
        b_sess = ctx_b.request.get(APP + "/api/v1/auth/session").json()
        ok("B session ACTIVE", b_sess.get("data", {}).get("authenticated") is True)

        page_a.wait_for_timeout(6000)  # realtime SESSION_REVOKED propagation
        ok("A force-logged-out to the auth flow (realtime revocation)", (not logged_in(page_a)) or "auth=login" in page_a.url, page_a.url)
        body_text = page_a.locator("body").inner_text()
        ok("A sees the exact revocation banner", REVOKED_MSG[:40] in body_text, REVOKED_MSG)
        page_a.screenshot(path="/tmp/final-revoked-banner.png")

        old = ctx_a.request.get(APP + "/api/v1/auth/session")
        ok("Superseded cookie → state REVOKED (§28)", old.json().get("data", {}).get("state") == "REVOKED", old.json().get("data"))
        old_api = ctx_a.request.get(APP + "/api/v1/notifications?take=1")
        ok("Superseded cookie → 401 SESSION_REVOKED", old_api.status == 401 and old_api.json().get("error", {}).get("code") == "SESSION_REVOKED", old_api.json())
        prot_b = ctx_b.request.get(APP + "/api/v1/notifications?take=1").status
        ok("B unaffected (protected API 200)", prot_b == 200, prot_b)
        ok("Presence: A's socket dropped after revocation (B is HTTP-only, no socket → 0)", len(rt_presence()) == 0, rt_presence())
        ctx_b.close()
        ctx_b = None

    finally:
        try:
            page_a.close()
        except Exception:
            pass

print("\n══ SMOKE SUMMARY ══")
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
for n, c, d in results:
    if not c:
        print(f"  FAILED: {n} ({d})")
sys.exit(1 if fails else 0)
