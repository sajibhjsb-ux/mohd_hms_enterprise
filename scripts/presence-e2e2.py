#!/usr/bin/env python3
"""PRESENCE E2E (upstream architecture) — PHASE 1: two-device realtime.

Verifies the canonical tree (origin/main, tasks 34-header-presence + ch35/QR
+ PDF): backend-authoritative presence:count pill, staff online-user dropdown
(presence:list RPC + presence:update push), live logout update, multi-tab
user-dedupe (count never inflated by sockets), "(you)" marker, "N devices"
badge. One browser process (CDP contexts) — the sandbox OOM-kills next-server
when a second Chromium competes for the 4GB cgroup.
"""
import subprocess, time, json, sys
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"  # via the Caddy gateway (as the real preview does)
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

def api_login(page, email):
    return page.request.post(APP + "/api/v1/auth/login", data={"email": email, "password": "Password@123"}).status

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

def keepalive(page):
    try:
        page.mouse.move(320, 220, steps=2); page.mouse.move(640, 300, steps=2)
    except Exception:
        pass

def open_app(page, path="/dashboard"):
    page.goto(APP + path, wait_until="load")
    page.wait_for_timeout(2500)
    dismiss_dialogs(page)
    if page.locator('button[aria-label="Profile"]').count() == 0 and page.locator("input[type=password]").count() == 0:
        page.goto(APP + path, wait_until="load")
        page.wait_for_timeout(3500)
        dismiss_dialogs(page)

def count_text(page):
    loc = page.locator('[data-testid="header-online-count"]')
    return loc.first.inner_text().strip() if loc.count() else None

def pill_state(page):
    pill = page.locator('[data-testid="header-online-pill"]')
    if not pill.count():
        return None
    t = " ".join(pill.first.inner_text().split())
    unavailable = "Online unavailable" in t
    return t, unavailable

def wait_count(page, want, timeout_s=12):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = count_text(page)
        if last == want:
            return True
        keepalive(page)
        page.wait_for_timeout(300)
    print(f"    [count] never reached '{want}', last='{last}'")
    return False

def dropdown_state(page):
    dd = page.locator('[data-testid="header-online-dropdown"]')
    if not dd.count():
        return None
    names = [n.strip().replace(" (you)", "") for n in dd.locator(".font-medium").all_inner_texts() if n.strip() and n.strip() != "Online users"]
    summary = dd.locator('[data-testid="header-online-summary"]').inner_text().strip()
    return {
        "names": names,
        "summary": summary,
        "unavailable": "Online status unavailable" in (dd.inner_text() or ""),
        "live_badge": "Live" in (dd.inner_text() or ""),
        "devices_badge": dd.locator("text=2 devices").count() > 0,
        "you_marker": "(you)" in (dd.inner_text() or ""),
    }

def open_dropdown(page):
    dismiss_dialogs(page)
    if page.locator('[data-testid="header-online-pill"]').count() == 0:
        sess = page.request.get(APP + "/api/v1/auth/session")
        print(f"    [pill-diag] url={page.url} session_api={sess.status} profile={page.locator('button[aria-label=\'Profile\']').count()} dialogs={page.locator('[role=\'dialog\']').count()}")
        print(f"    [pill-diag] body: {' '.join(page.locator('body').inner_text().split())[:180]}")
        page.screenshot(path="/tmp/pill-diag.png")
    page.locator('[data-testid="header-online-pill"]').first.click()
    page.wait_for_selector('[data-testid="header-online-dropdown"]', state="visible", timeout=8000)
    page.wait_for_timeout(600)

def close_dropdown(page):
    for _ in range(4):
        if page.locator('[data-testid="header-online-dropdown"]').count() == 0:
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        if page.locator('[data-testid="header-online-dropdown"]').count() == 0:
            return
        page.mouse.click(20, 500)
        page.wait_for_timeout(500)
    print("    [warn] dropdown did not close")

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    cdp = r.stdout.strip().splitlines()[-1].strip()
    browser = p.chromium.connect_over_cdp(cdp)
    ctx_a = browser.contexts[0]
    for extra in list(ctx_a.pages):
        extra.close()
    page_a = ctx_a.new_page()
    page_a.set_default_timeout(15000)
    presence_http = []
    page_a.on("request", lambda req: presence_http.append(req.url) if "/api/v1/realtime/presence" in req.url else None)
    ctx_b = browser.new_context(viewport={"width": 1280, "height": 800})
    page_b = ctx_b.new_page(); page_b.set_default_timeout(15000)
    tab_a2 = None

    try:
        print("── 1. Device A (SUPER_ADMIN): login → backend count pill ──")
        ok("A API login 200", api_login(page_a, "admin@mohdhms.com") == 200)
        open_app(page_a)
        ok("A pill shows '1' (WS presence:count, §10/§30)", wait_count(page_a, "1"), count_text(page_a))
        rt = rt_presence()
        ok("Server-side authoritative presence matches (1 user)", isinstance(rt, list) and len(rt) == 1 and rt[0]["name"] == "MohdAdmin", rt)
        ok("Zero HTTP presence calls while LIVE (WS-only, §25)", len(presence_http) == 0, presence_http[:2])

        print("── 2. Device B (ADMIN): login → A flips to 2 without reload (§11) ──")
        ok("B API login 200", api_login(page_b, "operations@mohdhms.com") == 200)
        open_app(page_b)
        try:
            page_b.wait_for_selector('button[aria-label="Profile"]', timeout=25000)
            ok("B shell mounted", True, page_b.url)
        except Exception:
            ok("B shell mounted", False, f"url={page_b.url} pw={page_b.locator('input[type=password]').count()}")
        ok("A pill realtime-updated to '2'", wait_count(page_a, "2"), count_text(page_a))

        print("── 3. A opens the Online Users dropdown (§13 loaded state) ──")
        open_dropdown(page_a)
        st = dropdown_state(page_a)
        ok("Dropdown lists 2 users, sorted", st and st["names"] == sorted(["MohdAdmin", "Operations Manager"]), st and st["names"])
        ok("(you) marker on the viewer", st and st["you_marker"], st)
        ok("Real backend names (no hardcoding)", st and "MohdAdmin" in st["names"] and "Operations Manager" in st["names"], st and st["names"])
        ok("Footer '2 users currently online'", st and st["summary"] == "2 users currently online", st and st["summary"])
        page_a.screenshot(path="/tmp/up-two-devices-live.png")
        close_dropdown(page_a)

        print("── 4. B logs out while A's dropdown is open → live update (§18) ──")
        open_dropdown(page_a)
        page_b.locator('button[aria-label="Profile"]').click(); page_b.wait_for_timeout(700)
        page_b.locator("text=Sign out").first.click(); page_b.wait_for_timeout(2500)
        st = dropdown_state(page_a)
        ok("Dropdown dropped to 1 user LIVE (push while open)", st and st["names"] == ["MohdAdmin"] and st["summary"] == "1 user currently online", st)
        close_dropdown(page_a)
        ok("A pill back to '1'", wait_count(page_a, "1"), count_text(page_a))

        print("── 5. Multi-tab dedupe: A's 2nd tab → count stays 1 (§16) ──")
        tab_a2 = ctx_a.new_page(); tab_a2.set_default_timeout(15000)
        tab_a2.goto(APP + "/dashboard", wait_until="load")
        tab_a2.wait_for_timeout(2500)
        dismiss_dialogs(tab_a2)
        if tab_a2.locator('button[aria-label="Profile"]').count() == 0 and tab_a2.locator("input[type=password]").count() == 0:
            tab_a2.goto(APP + "/dashboard", wait_until="load")
            tab_a2.wait_for_timeout(3500)
            dismiss_dialogs(tab_a2)
        deadline = time.time() + 20
        admin_entry = {}
        while time.time() < deadline:
            rt = rt_presence()
            admin_entry = next((e for e in rt if e.get("name") == "MohdAdmin"), {})
            if admin_entry.get("sockets", 0) >= 2:
                break
            keepalive(page_a); page_a.wait_for_timeout(900)
        ok("Server: 2 sockets for A but ONE presence entry", admin_entry.get("sockets", 0) >= 2, admin_entry)
        ok("Tab-1 count STAYS '1' (users, not sockets)", count_text(page_a) == "1", count_text(page_a))
        ok("Tab-2 received its own count ('1')", wait_count(tab_a2, "1", 8), count_text(tab_a2))
        open_dropdown(page_a)
        st = dropdown_state(page_a)
        ok("'2 devices' badge on the multi-socket user (list detail only)", st and st["devices_badge"], st)
        close_dropdown(page_a)
        tab_a2.close(); page_a.wait_for_timeout(1500)

        print("── 6. Steady state ──")
        ok("A steady at '1'", wait_count(page_a, "1"), count_text(page_a))
        ok("Still ZERO HTTP presence calls (header is WS-only)", len(presence_http) == 0, presence_http[:2])

    finally:
        try:
            if tab_a2: tab_a2.close()
        except Exception: pass
        try:
            ctx_b.close()
        except Exception: pass
        page_a.close()

print("\n══ UPSTREAM PHASE 1 SUMMARY ══")
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
for n, c, d in results:
    if not c:
        print(f"  FAILED: {n} ({d})")
sys.exit(1 if fails else 0)
