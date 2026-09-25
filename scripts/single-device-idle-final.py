#!/usr/bin/env python3
"""§37 TEST 3 + §35 (>5 minutes idle → REMAINS logged in) + §18 explicit logout.
Minimal-memory phase: designed to run alone on a freshly restarted dev server.
Correlates any logout with the audit trail: if an admin LOGIN lands inside the
idle window, the logout was an external supersession (the FEATURE working) —
reported as interference, not a product failure."""
import subprocess, time, json, sys
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"
results = []

def ok(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"  {'PASS' if cond else 'FAIL'} {name}{' — ' + str(detail) if detail else ''}", flush=True)

def sh(cmd):
    return subprocess.run(["bash", "-lc", cmd], capture_output=True, text=True, timeout=60)

def admin_logins_since(ts_iso):
    r = sh(f"cd /home/z/my-project && cat > q-login.ts << 'EOF'\nimport {{ PrismaClient }} from \"@prisma/client\";\nconst db = new PrismaClient();\nconst rows = await db.auditLog.findMany({{ where: {{ action: \"LOGIN\", actorEmail: \"admin@mohdhms.com\", createdAt: {{ gt: new Date(\"{ts_iso}\") }} }}, orderBy: {{ createdAt: \"asc\" }}, select: {{ createdAt: true, ip: true }} }});\nfor (const r of rows) console.log(r.createdAt.toISOString(), r.ip ?? \"\");\nawait db.$disconnect();\nEOF\nbun ./q-login.ts; rm -f ./q-login.ts")
    lines = [l for l in r.stdout.strip().splitlines() if l and "user@" not in l and "PrismaClient" not in l]
    return lines

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    cdp = r.stdout.strip().splitlines()[-1].strip()
    browser = p.chromium.connect_over_cdp(cdp)
    ctx_a = browser.contexts[0]
    for extra in list(ctx_a.pages):
        try: extra.close()
        except Exception: pass
    page_a = ctx_a.new_page()
    page_a.set_default_timeout(15000)

    try:
        print("── setup: login → ACTIVE ──", flush=True)
        login_at = sh("date -u +%Y-%m-%dT%H:%M:%S.%3NZ").stdout.strip()
        st = ctx_a.request.post(APP + "/api/v1/auth/login", data={"email": "admin@mohdhms.com", "password": "Password@123"}).status
        ok("A API login 200", st == 200, st)
        page_a.goto(APP + "/terms", wait_until="load"); page_a.wait_for_timeout(3500)
        ok("A logged in (shell mounted)", page_a.locator('button[aria-label="Profile"]').count() > 0, page_a.url)

        print("── §37 TEST 3 + §35: >5.5 minutes idle → REMAINS logged in ──", flush=True)
        idle_seconds = 330
        stepped = 0
        server_deaths = 0
        while stepped < idle_seconds:
            page_a.wait_for_timeout(10000)
            stepped += 10
            if stepped % 60 == 0:
                alive = sh("curl -s -o /dev/null -w '%{http_code}' -m 5 http://localhost:3000/api/health").stdout.strip()
                if alive != "200": server_deaths += 1
                print(f"    [idle] {stepped}s elapsed (server {alive})", flush=True)
        still = page_a.locator('button[aria-label="Profile"]').count() > 0 and "auth=login" not in page_a.url
        ok("A still logged in after 5.5 minutes idle (§35)", still, page_a.url)
        ok("No inactivity warning dialog exists anywhere", page_a.locator('[data-testid="idle-warning-dialog"]').count() == 0)
        sess = page_a.evaluate("fetch('/api/v1/auth/session').then(r => r.status).catch(() => 0)")
        ok("APIs keep working after the idle period (200)", sess == 200, sess)
        ext = admin_logins_since(login_at)
        ok("No external login superseded the idle session (audit-correlated)", len(ext) == 0, ext)

        print("── §18: explicit logout still works ──", flush=True)
        page_a.locator('button[aria-label="Profile"]').click(); page_a.wait_for_timeout(700)
        page_a.locator("text=Sign out").first.click(); page_a.wait_for_timeout(2500)
        ok("Manual logout lands on the auth flow", (page_a.locator('button[aria-label="Profile"]').count() == 0) or "auth=login" in page_a.url, page_a.url)
        logout_probe = page_a.evaluate("fetch('/api/v1/auth/session').then(r => r.status).catch(() => 0)")
        ok("Session gone after explicit logout (401)", logout_probe == 401, logout_probe)
        if server_deaths:
            print(f"  NOTE: dev server restarted/dead {server_deaths}× during idle window (sandbox OOM watch)")
    finally:
        page_a.close()

print("\n══ IDLE+LOGOUT SUMMARY ══", flush=True)
fails = [n for n, c, _ in results if not c]
print(f"{sum(1 for _, c, _ in results if c)}/{len(results)} PASS")
sys.exit(1 if fails else 0)
