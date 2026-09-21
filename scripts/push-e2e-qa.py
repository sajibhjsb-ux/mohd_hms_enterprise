#!/usr/bin/env python3
"""Push notification E2E QA (Firebase/FCM pipeline — spec §40/§41).

Drives a REAL browser against the REAL dev server and verifies the full push
path with an actual delivery:

  1. login (existing auth flow)
  2. service worker ready + notification permission granted
  3. enable push via the Profile UI (→ VAPID subscription in sandbox; the FCM
     transport is inactive here because no Firebase credentials exist)
  4. real business event (complaint created) → NotificationService → push
     queue → worker → transport → browser service worker → notification shown
  5. background delivery: page closed at send time, notification still received
  6. payload deep-link data correct (route the SW will open on click)

Playwright notes (learned the hard way):
  • channel="chromium" — new headless is required for Notification permission.
  • launch_persistent_context — the Push API is disabled in incognito-like
    ephemeral contexts; a real profile directory is required.
  • getNotifications lives on the registration (serviceWorker.ready).

Usage: python3 scripts/push-e2e-qa.py
"""
import json
import sys
import time
import tempfile
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EMAIL = "operations@mohdhms.com"
PASSWORD = "Password@123"


def api(method: str, path: str, payload: dict | None = None, cookie: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f" [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        profile = tempfile.mkdtemp(prefix="push-e2e-")
        ctx = p.chromium.launch_persistent_context(
            profile,
            headless=True,
            channel="chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
            permissions=["notifications"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # ── 1. login ──
        page.goto(BASE, wait_until="load", timeout=30000)
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Continue with Email").click()
        page.get_by_role("textbox", name="Email Address").fill(EMAIL)
        page.get_by_role("textbox", name="Password").fill(PASSWORD)
        page.get_by_role("button", name="Log In").click()
        page.wait_for_url("**/dashboard", timeout=20000)
        check("login", True, page.url)

        # ── 2. SW + permission ──
        page.wait_for_timeout(2500)  # SW registration is idle-deferred
        sw_ready = page.evaluate("() => navigator.serviceWorker.ready.then(() => true).catch(() => false)")
        check("service worker registered + active", bool(sw_ready))
        perm = page.evaluate("() => Notification.permission")
        check("notification permission granted", perm == "granted", perm)

        # ── 3. enable push via the Profile UI ──
        page.goto(f"{BASE}/profile", wait_until="load")
        page.wait_for_timeout(2500)
        clicked = page.evaluate("""() => {
          const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Enable on this device'));
          if (!b) return false; b.click(); return true;
        }""")
        page.wait_for_timeout(5000)
        state = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          return { endpoint: sub ? sub.endpoint.slice(0, 60) : null, permission: Notification.permission };
        }""")
        check("enable flow completed (browser subscribed)", bool(clicked) and state["endpoint"] is not None, str(state))

        cookies = ctx.cookies(BASE)
        cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)

        code, dev = api("GET", "/api/v1/push/devices", None, cookie)
        legacy_active = [d for d in dev.get("data", {}).get("legacy", []) if d.get("active")]
        check("device registration persisted (PushSubscription row)", code == 200 and len(legacy_active) >= 1,
              f"legacy active={len(legacy_active)}")

        # ── 4. REAL business event → push delivery ──
        code, custs = api("GET", "/api/v1/customers?pageSize=1", None, cookie)
        cust_list = custs.get("data") or []
        customer_id = cust_list[0]["id"] if cust_list else ""
        stamp = int(time.time())
        code, created = api("POST", "/api/v1/complaints", {
            "title": f"Push E2E verification {stamp}",
            "description": "End-to-end push notification pipeline test.",
            "priority": "HIGH",
            "customerId": customer_id,
        }, cookie)
        check("business event created (complaint)", code in (200, 201), f"HTTP {code} {json.dumps(created.get('error', {}))[:120]}")

        # The worker kicks immediately after enqueue; allow a settle window.
        deadline = time.time() + 25
        notifs = []
        while time.time() < deadline:
            notifs = page.evaluate("""async () => {
              const ns = await (await navigator.serviceWorker.ready).getNotifications();
              return ns.map(n => ({ title: n.title, body: n.body, url: (n.data || {}).url, icon: n.icon }));
            }""")
            if notifs:
                break
            page.wait_for_timeout(2000)
        titles = [n.get("title", "") for n in notifs]
        check("push RECEIVED by service worker (business event)", len(notifs) >= 1, f"titles={titles}")
        if notifs:
            n = notifs[0]
            check("notification shows app icon", bool(n.get("icon")), str(n.get("icon")))
            check("payload carries deep-link route", bool(n.get("url")), str(n.get("url")))
            check("payload url is in-app relative (RBAC-safe)", str(n.get("url", "")).startswith("/") and not str(n.get("url", "")).startswith("//"))

        # ── 5. background delivery: close the page, send admin test push ──
        page.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.forEach(n => n.close()))")
        page.close()

        code, me = api("GET", "/api/v1/auth/session", None, cookie)
        user_id = me.get("data", {}).get("user", {}).get("id", "")
        code, test_res = api("POST", "/api/v1/push/admin/test", {
            "userId": user_id,
            "title": "Background delivery test",
            "body": "Sent while no tab was open.",
        }, cookie)
        status = test_res.get("data", {}).get("status")
        check("admin test push pipeline result = SENT", status == "SENT",
              json.dumps(test_res.get("data", {}))[:180])

        page2 = ctx.new_page()
        page2.goto(f"{BASE}/dashboard", wait_until="load", timeout=30000)
        page2.wait_for_timeout(2000)
        bg_notifs = page2.evaluate("""async () => {
          const ns = await (await navigator.serviceWorker.ready).getNotifications();
          return ns.map(n => ({ title: n.title, body: n.body, url: (n.data || {}).url }));
        }""")
        bg_titles = [n.get("title", "") for n in bg_notifs]
        check("background push RECEIVED (no open tab at send time)", any("Background delivery test" in t for t in bg_titles), f"titles={bg_titles}")

        # ── 6. push log is authoritative ──
        code, logs = api("GET", "/api/v1/push/admin/overview", None, cookie)
        recent = logs.get("data", {}).get("recent", [])
        sent_rows = [r for r in recent if r.get("status") == "SENT"]
        check("PushLog records SENT deliveries", len(sent_rows) >= 2, f"sent rows={len(sent_rows)}")
        if sent_rows:
            r0 = sent_rows[0]
            check("delivery row links business resource", bool(r0.get("resourceType")), f"resourceType={r0.get('resourceType')}")

        page2.screenshot(path="/home/z/tmp-verify/push-e2e-final.png")
        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("no page errors", not real_errors, "; ".join(real_errors[:3]))

        ctx.close()

    failed = [r for r in results if not r[1]]
    print(f"\n=== {len(results) - len(failed)}/{len(results)} checks passed ===")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
