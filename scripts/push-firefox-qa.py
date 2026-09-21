#!/usr/bin/env python3
"""Firefox push delivery QA — REAL end-to-end Web Push receipt.

The sandbox egress breaks POST bodies to jmt17.google.com (Chrome's push
endpoint) with a hard 502, so Chrome deliveries cannot complete HERE. Mozilla's
autopush (updates.push.services.mozilla.com) answers correctly, so Firefox
provides the real-delivery proof for the SAME pipeline: server → push queue →
worker → web-push transport → browser push service → service worker →
showNotification.

Usage: python3 scripts/push-firefox-qa.py
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


def api(method: str, path: str, payload=None, cookie: str | None = None):
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

    def check(name, ok, detail=""):
        results.append((name, ok, detail))
        print(f" [{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    with sync_playwright() as p:
        profile = tempfile.mkdtemp(prefix="push-ff-")
        browser = p.firefox.launch_persistent_context(
            profile,
            headless=True,
            viewport={"width": 1366, "height": 900},
            # Headless Firefox ships with the push service disabled; a real
            # delivery test needs the DOM push machinery + testing permission.
            firefox_user_prefs={
                "dom.push.enabled": True,
                "dom.push.connection.enabled": True,
                "dom.serviceWorkers.enabled": True,
                "notification.prompt.testing": True,
                "notification.prompt.testing.allow": True,
            },
        )
        browser.grant_permissions(["notifications"], origin=BASE)
        page = browser.pages[0] if browser.pages else browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # login
        page.goto(BASE, wait_until="load", timeout=60000)
        page.wait_for_timeout(2000)
        page.get_by_role("button", name="Continue with Email").click()
        page.get_by_role("textbox", name="Email Address").fill(EMAIL)
        page.get_by_role("textbox", name="Password").fill(PASSWORD)
        page.get_by_role("button", name="Log In").click()
        page.wait_for_url("**/dashboard", timeout=30000)
        check("login", True, page.url)

        # permission granted via the context API (Playwright Firefox supports it)
        perm = page.evaluate("() => Notification.permission")
        if perm != "granted":
            check("notification permission granted", False, perm)
            browser.close()
            return 1
        check("notification permission granted", True, perm)

        # enable push via the Profile UI (the ONE shared flow)
        page.goto(f"{BASE}/profile", wait_until="load")
        page.wait_for_timeout(2500)
        clicked = page.evaluate("""() => {
          const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Enable on this device'));
          if (!b) return false; b.click(); return true;
        }""")
        page.wait_for_timeout(6000)
        state = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          return { endpoint: sub ? sub.endpoint.slice(0, 60) : null, permission: Notification.permission };
        }""")
        check("enable flow completed (browser subscribed)", bool(clicked) and state["endpoint"] is not None,
              f"endpoint={state['endpoint']}")

        cookies = browser.cookies()
        cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)

        # REAL business event → push delivery (complaint → ADMIN role)
        code, custs = api("GET", "/api/v1/customers?pageSize=1", None, cookie)
        cust_list = custs.get("data") or []
        stamp = int(time.time())
        code, created = api("POST", "/api/v1/complaints", {
            "title": f"Firefox push E2E {stamp}",
            "description": "Real end-to-end push delivery verification.",
            "priority": "HIGH",
            "customerId": cust_list[0]["id"] if cust_list else "",
        }, cookie)
        check("business event created (complaint)", code in (200, 201), f"HTTP {code}")

        deadline = time.time() + 25
        notifs = []
        while time.time() < deadline:
            notifs = page.evaluate("() => navigator.serviceWorker.ready.then(r => r.getNotifications())")
            if notifs:
                break
            page.wait_for_timeout(2000)
        titles = [n.title for n in notifs]
        check("REAL push RECEIVED by the browser (business event)", len(notifs) >= 1, f"titles={titles}")
        if notifs:
            n = notifs[0]
            check("notification body present", bool(n.body), (n.body or "")[:80])
            check("deep-link route in payload", str((n.data or {}).get("url", "")).startswith("/"),
                  str((n.data or {}).get("url")))

        # PushLog authoritative record
        code, logs = api("GET", "/api/v1/push/admin/overview", None, cookie)
        sent_rows = [r for r in logs.get("data", {}).get("recent", []) if r.get("status") == "SENT"]
        check("PushLog records SENT deliveries", len(sent_rows) >= 1, f"sent rows={len(sent_rows)}")

        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("no page errors", not real_errors, "; ".join(real_errors[:3]))

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n=== {len(results) - len(failed)}/{len(results)} checks passed ===")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
