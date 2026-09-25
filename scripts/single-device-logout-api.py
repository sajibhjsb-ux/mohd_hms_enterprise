#!/usr/bin/env python3
"""§18 explicit logout — API-contract level (authoritative) + UI retry probe."""
import subprocess, sys, time, json
from playwright.sync_api import sync_playwright

APP = "http://localhost:81"
res = []
def ok(name, cond, detail=""):
    res.append(bool(cond))
    print(f"  {'PASS' if cond else 'FAIL'} {name}{' — ' + str(detail) if detail else ''}", flush=True)

with sync_playwright() as p:
    r = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20)
    browser = p.chromium.connect_over_cdp(r.stdout.strip().splitlines()[-1].strip())
    ctx = browser.new_context()  # isolated device jar, API-only (zero renderer memory)

    # ── §18 server contract: explicit logout destroys the session ──
    st = ctx.request.post(APP + "/api/v1/auth/login", data={"email": "operations@mohdhms.com", "password": "Password@123"}).status
    ok("login 200", st == 200, st)
    pre = ctx.request.get(APP + "/api/v1/auth/session")
    ok("session ACTIVE before logout", pre.status == 200 and pre.json()["data"]["authenticated"] is True, pre.status)
    lo = ctx.request.post(APP + "/api/v1/auth/logout", data={})
    ok("logout 200", lo.status == 200, lo.status)
    post = ctx.request.get(APP + "/api/v1/auth/session")
    ok("session state INVALID after explicit logout (§18/§28)", post.status == 200 and post.json()["data"]["authenticated"] is False and post.json()["data"]["state"] == "INVALID", post.text[:80])
    # The destroyed session cannot come back (§15: no silent restore).
    again = ctx.request.get(APP + "/api/v1/auth/session")
    ok("stays logged out on revalidation", again.json()["data"]["authenticated"] is False, again.text[:60])
    ctx.close()

    # ── UI path: profile menu → Sign out (with 502-resilient probing) ──
    page = browser.contexts[0].new_page()
    page.set_default_timeout(15000)
    try:
        ctx2 = browser.contexts[0]
        ctx2.request.post(APP + "/api/v1/auth/login", data={"email": "operations@mohdhms.com", "password": "Password@123"})
        page.goto(APP + "/dashboard", wait_until="load"); page.wait_for_timeout(4000)
        ok("UI logged in", page.locator('button[aria-label="Profile"]').count() > 0, page.url)
        page.locator('button[aria-label="Profile"]').click(); page.wait_for_timeout(900)
        page.get_by_text("Sign out", exact=True).click()
        # signOut() never blocks on a failed POST (by design) — give it a moment
        deadline = time.time() + 10
        gone = False
        while time.time() < deadline:
            if page.locator('button[aria-label="Profile"]').count() == 0:
                gone = True
                break
            page.wait_for_timeout(500)
        ok("UI logged out after Sign out click", gone, page.url)
        pw = subprocess.run(["bash", "-lc",
            "cd /home/z/my-project && cat > q-log.ts << 'EOF'\nimport { PrismaClient } from \"@prisma/client\";\nconst db = new PrismaClient();\nconst ops = await db.user.findUnique({ where: { email: \"operations@mohdhms.com\" } });\nconst n = await db.session.count({ where: { userId: ops!.id } });\nconsole.log(JSON.stringify({ n }));\nawait db.$disconnect();\nEOF\nbun ./q-log.ts; rm -f ./q-log.ts"],
            capture_output=True, text=True, timeout=60)
        n = json.loads(pw.stdout.strip().splitlines()[-1])["n"]
        ok("session row DELETED from DB after explicit logout (authoritative)", n == 0, n)
    finally:
        page.close()

print(f"{sum(res)}/{len(res)} PASS", flush=True)
sys.exit(0 if all(res) else 1)
