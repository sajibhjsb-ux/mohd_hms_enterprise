#!/usr/bin/env python3
"""PRESENCE E2E — PHASE 2: offline honesty, reconnect, RBAC, API contract.

Runs standalone (fresh logins) so the dev server's memory window stays small
(the sandbox OOM-kills next-server during long mixed workloads).
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

def rt_pid():
    return sh("ss -tlnp 2>/dev/null | grep ':3003 ' | sed -E 's/.*pid=([0-9]+).*/\\1/' | head -1").stdout.strip()

def rt_presence():
    r = sh("curl -s -m 3 http://127.0.0.1:3004/internal/health -H 'x-realtime-secret: hms-realtime-internal-secret-v1'")
    try:
        return json.loads(r.stdout)["data"]["presence"]
    except Exception:
        return []

def api_login(page, email):
    return page.request.post(APP + "/api/v1/auth/login", data={"email": email, "password": "Password@123"}).status

def open_app(page, path="/dashboard"):
    page.goto(APP + path, wait_until="load")
    page.wait_for_timeout(2500)
    dismiss_dialogs(page)
    if page.locator('button[aria-label="Profile"]').count() == 0 and page.locator("input[type=password]").count() == 0:
        page.goto(APP + path, wait_until="load")
        page.wait_for_timeout(3500)
        dismiss_dialogs(page)

def keepalive(page):
    try:
        page.mouse.move(320, 220, steps=2); page.mouse.move(640, 300, steps=2)
    except Exception:
        pass

def pill_text(page):
    loc = page.locator('[data-testid="header-online-count"]')
    return loc.first.inner_text().strip() if loc.count() else None

def pill_unavailable(page):
    return "Online unavailable" in " ".join(page.locator('[data-testid="header-online-pill"]').first.inner_text().split()) if page.locator('[data-testid="header-online-pill"]').count() else False

def wait_count(page, want, timeout_s=12):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = pill_text(page)
        if last == want:
            return True
        keepalive(page)
        page.wait_for_timeout(300)
    return False

def wait_pill_change(page, current, timeout_s=45):
    deadline = time.time() + timeout_s
    last = current
    while time.time() < deadline:
        last = pill_text(page)
        if last is not None and last != current:
            return True
        keepalive(page)
        page.wait_for_timeout(1000)
    print(f"    [pill] never left '{current}', last='{last}'")
    return False

def dropdown_state(page):
    dd = page.locator('[data-testid="header-online-dropdown"]')
    if not dd.count():
        return None
    return {
        "names": [n.strip().replace(" (you)", "") for n in dd.locator(".font-medium").all_inner_texts()],
        "summary": dd.locator('[data-testid="header-online-summary"]').inner_text().strip(),
        "unavailable_msg": "Online status unavailable" in (dd.inner_text() or ""),
        "rows": len([n for n in dd.locator(".font-medium").all_inner_texts() if n.strip()]),
    }

def close_dropdown(page):
    """Radix modal menus block outside clicks while open — verify closure."""
    for _ in range(4):
        if page.locator('[data-testid="online-users-dropdown"]').count() == 0:
            return
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        if page.locator('[data-testid="online-users-dropdown"]').count() == 0:
            return
        page.mouse.click(20, 500)  # far corner — radix outside-pointerdown close
        page.wait_for_timeout(500)
    print("    [warn] dropdown did not close")

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

def open_dropdown(page):
    dismiss_dialogs(page)
    page.locator('[data-testid="header-online-pill"]').first.click()
    page.wait_for_selector('[data-testid="header-online-dropdown"]', state="visible", timeout=8000)
    page.wait_for_timeout(600)

def diagnose(page, tag):
    try:
        print(f"    [{tag}-diag] url={page.url} pill={pill_text(page)}")
        print(f"    [{tag}-diag] body: {' '.join(page.locator('body').inner_text().split())[:160]}")
        page.screenshot(path=f"/tmp/diag-{tag}.png")
    except Exception as e:
        print(f"    [{tag}-diag] failed: {repr(e)[:100]}")

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    cdp = r.stdout.strip().splitlines()[-1].strip()
    browser_a = p.chromium.connect_over_cdp(cdp)
    ctx_a = browser_a.contexts[0]
    for extra in list(ctx_a.pages):
        extra.close()
    page_a = ctx_a.new_page()
    page_a.set_default_timeout(15000)
    presence_api_calls = []
    import time as _t
    page_a.on("request", lambda req: presence_api_calls.append((round(_t.time(), 1), req.url)) if "/api/v1/realtime/presence" in req.url else None)
    ctx_c = None

    try:
        print("── 1. A (SUPER_ADMIN) login → 1 Online ──")
        ok("A API login 200", api_login(page_a, "admin@mohdhms.com") == 200)
        open_app(page_a)
        ok("A pill '1'", wait_count(page_a, "1"), pill_text(page_a))

        print("── 2. Service killed → honest OFFLINE states (§13/§26/§27) ──")
        pid = rt_pid(); sh(f"kill {pid}"); time.sleep(1)
        ok("service killed", bool(pid) and not rt_pid())
        open_dropdown(page_a)  # during the outage the open dropdown must go honest
        deadline = time.time() + 30
        st = dropdown_state(page_a)
        while time.time() < deadline and not (st and st["unavailable_msg"]):
            keepalive(page_a); page.wait_for_timeout(1000)
            st = dropdown_state(page_a)
        ok("Dropdown honest while channel dead — 'Online status unavailable' (§13/§26)", bool(st and st["unavailable_msg"]), st)
        ok("No stale user list rendered as current", bool(st and st["rows"] == 0), st)
        page_a.screenshot(path="/tmp/up-offline-honest.png")
        close_dropdown(page_a)

        print("── 3. Service restarted → reconnect + snapshot, no reload (§20) ──")
        subprocess.Popen(["bash", "-lc", "cd /home/z/my-project/mini-services/realtime-service && exec bun --hot index.ts >> /tmp/rt-presence-restart.log 2>&1"], start_new_session=True)
        for _ in range(30):
            time.sleep(1)
            if rt_pid():
                break
        time.sleep(2)
        recovered = wait_count(page_a, "1", 30)
        if not recovered and pill_text(page_a) is None:
            diagnose(page_a, "reconnect")
        ok("A reconnected + count restored → '1' (no reload)", recovered, pill_text(page_a))
        try:
            open_dropdown(page_a)
            st = dropdown_state(page_a)
            ok("Dropdown LIVE after reconnect (list + summary)", st and st["names"] == ["MohdAdmin"] and st["summary"] == "1 user currently online", st)
            close_dropdown(page_a)
        except Exception as e:
            diagnose(page_a, "reconnect-dd")
            ok("dropdown live after reconnect", False, repr(e)[:110])

        print("── 4. RBAC: technician — no dropdown, API 403 (§8) ──")
        ctx_c = browser_a.new_context(viewport={"width": 1280, "height": 800})
        page_c = ctx_c.new_page(); page_c.set_default_timeout(15000)
        ok("C API login 200", api_login(page_c, "ahmad.tech@mohdhms.com") == 200)
        open_app(page_c)
        ok("Technician (staff) receives the live count pill", wait_count(page_c, "1", 12), pill_text(page_c))
        open_dropdown(page_c)
        stc = dropdown_state(page_c)
        ok("Technician dropdown lists staff online (staff-room scope)", bool(stc and "MohdAdmin" in stc["names"]), stc)
        close_dropdown(page_c)
        api_status = page_c.evaluate("fetch('/api/v1/realtime/presence').then(r => r.status)")
        ok("Management-only REST presence API stays 403 for technician (RBAC unchanged)", api_status == 403, api_status)
        ctx_c.close(); page_a.wait_for_timeout(2500)  # C's socket cleanup propagates

        print("── 5. A sanity: API schema + zero polling (§6/§25/§30) ──")
        calls_before_schema = len(presence_api_calls)
        raw = page_a.evaluate("fetch('/api/v1/realtime/presence').then(r => r.text())")
        api = json.loads(raw)
        d = api.get("data", {})
        schema_ok = (
            api.get("ok") is True and isinstance(d.get("online"), list)
            and all({"userId", "name", "role", "since"} <= set(u) for u in d["online"])
            and "password" not in raw.lower() and "token" not in raw.lower()
        )
        ok("Schema matches contract, no secrets", schema_ok, d.get("online"))
        # §25: a fallback request on dropdown-open while unavailable is sanctioned;
        # what must NEVER happen is a polling loop. Assert no two calls <10s apart.
        stamps = [s for s, _ in presence_api_calls]
        loop = any(b - a < 10 for a, b in zip(stamps, stamps[1:]))
        ok("No HTTP presence polling loop (≥10s apart; open-fallback allowed)", not loop, presence_api_calls)
        ok("A pill '1 Online' at end (only self online)", pill_text(page_a) == "1 Online", pill_text(page_a))

    finally:
        try:
            if ctx_c: ctx_c.close()
        except Exception: pass
        page_a.close()

print("\n══ PHASE 2 SUMMARY ══")
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
for n, c, d in results:
    if not c:
        print(f"  FAILED: {n} ({d})")
sys.exit(1 if fails else 0)
