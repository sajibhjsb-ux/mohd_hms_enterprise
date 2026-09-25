#!/usr/bin/env python3
"""SINGLE ACTIVE DEVICE E2E — one account, one active session; NO inactivity logout.

Structured for the sandbox's 4GB cgroup (next-server's turbopack build holds
~2.4GB; two simultaneous page renderers OOM it — so at most ONE browser page
is open at any moment; device B is exercised through the authoritative HTTP
layer, which is exactly the §9 backend-enforcement surface).

§37 TEST 1: device A login → ACTIVE, Online=1.
§37 TEST 2: device B login (same account) → A force-logged-out with the exact
            banner, A's old cookie answers 401 SESSION_REVOKED, B stays active,
            presence drops.
§24: three rapid logins → exactly ONE active session row in the DB.
§37 TEST 3 + §35: >5 minutes idle → still logged in, APIs work, no warning UI.
§18: explicit logout works.
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

def api_login(req, email, remember=False):
    return req.post(APP + "/api/v1/auth/login", data={"email": email, "password": "Password@123", "remember": remember}).status

def session_probe(req):
    r = req.get(APP + "/api/v1/auth/session")
    try:
        body = r.json()
    except Exception:
        body = {}
    return r.status, body

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

def open_app(page, path="/terms"):
    page.goto(APP + path, wait_until="load")
    page.wait_for_timeout(2500)
    dismiss_dialogs(page)
    if page.locator('button[aria-label="Profile"]').count() == 0 and page.locator("input[type=password]").count() == 0:
        page.goto(APP + path, wait_until="load")
        page.wait_for_timeout(3500)
        dismiss_dialogs(page)

def logged_in(page):
    return page.locator('button[aria-label="Profile"]').count() > 0

def count_text(page):
    loc = page.locator('[data-testid="header-online-count"]')
    return loc.first.inner_text().strip() if loc.count() else None

def wait_count(page, want, timeout_s=12):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = count_text(page)
        if last == want:
            return True
        page.wait_for_timeout(400)
    return False

REVOKED_MSG = "Your account was signed in on another device, so this session has been logged out."

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
        print("── §37 TEST 1: Device A logs in → ACTIVE, Online = 1 ──")
        ok("A API login 200 (admin)", api_login(ctx_a.request, "admin@mohdhms.com") == 200)
        open_app(page_a)
        ok("A logged in (shell mounted)", logged_in(page_a), page_a.url)
        ok("A pill count '1'", wait_count(page_a, "1"), count_text(page_a))
        rt = rt_presence()
        ok("Presence: exactly 1 online user (admin)", len(rt) == 1 and rt[0]["name"] == "MohdAdmin", rt)

        print("── §37 TEST 2: Device B logs in (same account) → A revoked ──")
        # Device B = its OWN cookie jar (a separate browser.new_context with NO
        # page — zero renderer memory in the 4GB cgroup). A device is a session
        # credential; B exercises the §9 backend-authoritative HTTP surface.
        ctx_b = browser.new_context()
        ok("B API login 200 (same account, own device jar)", api_login(ctx_b.request, "admin@mohdhms.com") == 200)
        b_status, b_body = session_probe(ctx_b.request)
        ok("B session ACTIVE (authenticated, fresh user payload)", b_status == 200 and b_body.get("data", {}).get("authenticated") is True, b_status)

        # A's page must be force-logged-out (realtime event → probe → 401 → logout)
        a_gone = False
        deadline = time.time() + 30
        while time.time() < deadline:
            if (not logged_in(page_a)) and "auth=login" in page_a.url:
                a_gone = True
                break
            page_a.wait_for_timeout(700)
        ok("A force-logged-out to the login screen (realtime revocation, §8)", a_gone, page_a.url)
        banner_ok = True
        try:
            page_a.wait_for_selector(f"text={REVOKED_MSG}", timeout=10000)
        except Exception:
            banner_ok = False
        ok("A sees the exact revocation banner (§26)", banner_ok, REVOKED_MSG)
        page_a.screenshot(path="/tmp/sad-revoked-banner.png")

        # Backend-authoritative (§9/§34): A's dead cookie still rides the page's
        # jar (the interceptor logout doesn't touch it) — the precise 401 code
        # proves the OLD credential no longer authorizes anything.
        old_status = page_a.evaluate("fetch('/api/v1/auth/session').then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))")
        ok("Session validation reports REVOKED for the old cookie (§28)", old_status.get("body", {}).get("data", {}).get("state") == "REVOKED", old_status)
        old_api = page_a.evaluate("fetch('/api/v1/notifications?take=1').then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))")
        ok("A cannot access protected APIs anymore (§9/§32)", old_api.get("status") == 401 and old_api.get("body", {}).get("error", {}).get("code") == "SESSION_REVOKED", old_api)

        # B stays ACTIVE through the revocation of the other device (§14)
        b_status2, b_body2 = session_probe(ctx_b.request)
        ok("B remains ACTIVE after A's logout (§14)", b_status2 == 200 and b_body2.get("data", {}).get("authenticated") is True, b_status2)

        # Presence: A's socket gone (logout disconnects immediately). Device B
        # holds no browser page in this harness, so nothing else stays online.
        deadline = time.time() + 25
        rt = []
        while time.time() < deadline:
            rt = rt_presence()
            if len(rt) == 0:
                break
            page_a.wait_for_timeout(1000)
        ok("Presence: A's socket dropped after revocation (§25)", len(rt) == 0, rt)
        try:
            ctx_b.close()
        except Exception:
            pass

        print("── §24: concurrent login race → exactly ONE active session ──")
        import concurrent.futures, urllib.request, urllib.error
        def rapid_login(i):
            req = urllib.request.Request(APP + "/api/v1/auth/login",
                data=json.dumps({"email": "operations@mohdhms.com", "password": "Password@123"}).encode(),
                headers={"Content-Type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    return resp.status
            except urllib.error.HTTPError as e:
                return e.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
            statuses = list(ex.map(rapid_login, range(3)))
        ok("3 rapid logins all succeed (200)", all(s == 200 for s in statuses), statuses)
        q = subprocess.run(["bash", "-lc",
            'cat > /home/z/my-project/.q-sess.ts << "EOF"\nimport { PrismaClient } from "@prisma/client";\nconst db = new PrismaClient();\nconst ops = await db.user.findUnique({ where: { email: "operations@mohdhms.com" }, select: { id: true } });\nconst active = await db.session.count({ where: { userId: ops.id, revokedAt: null, expiresAt: { gt: new Date() } } });\nconsole.log(JSON.stringify({ active }));\nawait db.$disconnect();\nEOF\ncd /home/z/my-project && bun .q-sess.ts; rm -f /home/z/my-project/.q-sess.ts'],
            capture_output=True, text=True, timeout=90)
        try:
            active = json.loads(q.stdout.strip().splitlines()[-1]).get("active")
        except Exception:
            active = None
        ok("DB: exactly ONE active session for the raced account", active == 1, (q.stdout + q.stderr).strip()[-150:])

        print("── A re-opens the app with the final (race-winning) session ──")
        ok("A re-login 200 (browser jar gets the final session)", api_login(ctx_a.request, "admin@mohdhms.com") == 200)
        open_app(page_a)
        ok("A logged in with the final session", logged_in(page_a), page_a.url)
        ok("A pill count '1'", wait_count(page_a, "1"), count_text(page_a))

        print("── §37 TEST 3 + §35: >5 minutes idle → REMAINS logged in ──")
        print("    ... idling 5.6 minutes with zero interaction (no activity pings exist anymore) ...")
        idle_seconds = 336
        stepped = 0
        while stepped < idle_seconds:
            page_a.wait_for_timeout(10000)
            stepped += 10
            if stepped % 60 == 0:
                alive = sh("curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:3000/").stdout.strip()
                print(f"    [idle] {stepped}s elapsed (server liveness {alive})")
        ok("A still logged in after 5.6 minutes idle (§35: 1min/5min/30min → stay)", logged_in(page_a) and "auth=login" not in page_a.url, page_a.url)
        ok("No inactivity warning dialog exists anywhere", page_a.locator('[data-testid="idle-warning-dialog"]').count() == 0)
        sess = page_a.evaluate("fetch('/api/v1/auth/session').then(r => r.status)")
        ok("APIs keep working after the idle period (200)", sess == 200, sess)
        ok("Presence still shows the idle device online", any(e["name"] == "MohdAdmin" for e in rt_presence()), rt_presence())

        print("── §18: explicit logout still works ──")
        page_a.locator('button[aria-label="Profile"]').click(); page_a.wait_for_timeout(700)
        page_a.locator("text=Sign out").first.click(); page_a.wait_for_timeout(2500)
        ok("Manual logout lands on the auth flow", (not logged_in(page_a)) or "auth=login" in page_a.url, page_a.url)
        logout_probe = page_a.evaluate("fetch('/api/v1/auth/session').then(r => r.status)")
        ok("Session gone after explicit logout (401)", logout_probe == 401, logout_probe)

    finally:
        page_a.close()

print("\n══ SINGLE-ACTIVE-DEVICE SUMMARY ══")
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
for n, c, d in results:
    if not c:
        print(f"  FAILED: {n} ({d})")
sys.exit(1 if fails else 0)
