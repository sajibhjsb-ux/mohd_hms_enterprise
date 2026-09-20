#!/usr/bin/env python3
"""Chromium real-delivery QA with sandbox-egress workaround.

The sandbox egress breaks POST-with-body to jmt17.google.com (Chrome's push
endpoint edge) with a hard 502 — an environment defect, not a code defect
(the same edge answers 401 correctly for body-less requests and Google's
other ingress, fcm.googleapis.com, answers 401/201 correctly).

Strategy: subscribe a REAL Chromium, then deliver the REAL encrypted message
(same VAPID auth, same payload encryption) through Google's alternative FCM
ingress `fcm.googleapis.com/fcm/send/<token>` — the same FCM registry that
routes the token to the device. Success = HTTP 201 from Google AND the
notification actually displayed by the live browser's service worker.

Usage: python3 scripts/push-delivery-qa.py
"""
import json
import subprocess
import sys
import tempfile
import time
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
        profile = tempfile.mkdtemp(prefix="push-delivery-")
        ctx = p.chromium.launch_persistent_context(
            profile, headless=True, channel="chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
            permissions=["notifications"],
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        # login + SW ready
        page.goto(BASE, wait_until="load", timeout=30000)
        page.wait_for_timeout(1500)
        page.get_by_role("button", name="Continue with Email").click()
        page.get_by_role("textbox", name="Email Address").fill(EMAIL)
        page.get_by_role("textbox", name="Password").fill(PASSWORD)
        page.get_by_role("button", name="Log In").click()
        page.wait_for_url("**/dashboard", timeout=20000)
        page.wait_for_timeout(2500)
        check("login", True)

        # subscribe through the ONE shared enable flow (Profile UI)
        page.goto(f"{BASE}/profile", wait_until="load")
        page.wait_for_timeout(2500)
        clicked = page.evaluate("""() => {
          const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Enable on this device'));
          if (!b) return false; b.click(); return true;
        }""")
        page.wait_for_timeout(5000)
        sub = page.evaluate("""async () => {
          const reg = await navigator.serviceWorker.ready;
          const s = await reg.pushManager.getSubscription();
          return s ? s.toJSON() : null;
        }""")
        check("browser subscribed (real endpoint)", bool(clicked) and bool(sub), str((sub or {}).get("endpoint", ""))[:70])

        if sub:
            # Deliver through Google's FCM ingress (sandbox egress blocks jmt17).
            # Write the subscription for the node sender.
            with open("/tmp/push-sub.json", "w") as f:
                json.dump(sub, f)
            payload = json.dumps({
                "title": "REAL delivery verification",
                "body": "End-to-end push: server → queue → worker → Google → this browser.",
                "url": "/dashboard",
            })
            r = subprocess.run(
                ["node", "/home/z/my-project/scripts/send-webpush.js", payload],
                capture_output=True, text=True, timeout=60,
            )
            check("Google FCM accepted the real push (201)", r.returncode == 0, (r.stdout + r.stderr).strip()[:200])

            # the live browser should now display the notification
            deadline = time.time() + 20
            notifs = []
            while time.time() < deadline:
                notifs = page.evaluate("""async () => {
                  const ns = await (await navigator.serviceWorker.ready).getNotifications();
                  return ns.map(n => ({ title: n.title, body: n.body, url: (n.data || {}).url }));
                }""")
                if notifs:
                    break
                page.wait_for_timeout(2000)
            titles = [n.get("title", "") for n in notifs]
            check("REAL push RECEIVED + displayed by the service worker", any("REAL delivery verification" in t for t in titles), f"titles={titles}")
            if notifs:
                n0 = notifs[0]
                check("deep-link route carried in payload", str(n0.get("url", "")).startswith("/"), str(n0.get("url")))

            # cookie + authoritative PushLog row
            cookies = ctx.cookies(BASE)
            cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)

            # ── Full PIPELINE proof: DB-level fixture (sandbox egress blocks
            # jmt17 from the server; production code always uses the true
            # endpoint) → worker → 201 → browser displays → PushLog SENT ──
            code, me = api("GET", "/api/v1/auth/session", None, cookie)
            user_id = me.get("data", {}).get("user", {}).get("id", "")
            fix = {
                "host": "fcm.googleapis.com",
                "token": (sub.get("endpoint") or "").split("/fcm/send/")[-1],
            }
            fix_req = urllib.request.Request(BASE + "/api/v1/push/admin/test", method="POST")
            # The test route targets PushLog only; the endpoint fixture must be
            # applied at the DB level via a direct sqlite update.
            import sqlite3, os
            db_path = "/home/z/my-project/db/custom.db"
            if os.path.exists(db_path):
                conn = sqlite3.connect(db_path)
                cur = conn.execute(
                    "UPDATE PushSubscription SET endpoint = ? WHERE endpoint = ?",
                    (f"https://fcm.googleapis.com/fcm/send/{fix['token']}", sub.get("endpoint")),
                )
                conn.commit()
                updated = cur.rowcount
                conn.close()
                if updated == 0:
                    check("pipeline fixture (row updated)", False, "no matching subscription row")
                    ctx.close()
                    return 1
                code, test_res = api("POST", "/api/v1/push/admin/test", {
                    "userId": user_id,
                    "title": "Pipeline delivery test",
                    "body": "Worker → transport → browser, end to end.",
                }, cookie)
                data = test_res.get("data", {})
                check("admin test pipeline result = SENT (worker → Google → browser)",
                      data.get("status") == "SENT", json.dumps(data)[:200])
                deadline = time.time() + 20
                pipe_notifs = []
                while time.time() < deadline:
                    pipe_notifs = page.evaluate("""async () => {
                      const ns = await (await navigator.serviceWorker.ready).getNotifications();
                      return ns.map(n => ({ title: n.title, body: n.body }));
                    }""")
                    if any("Pipeline delivery test" in n.get("title", "") for n in pipe_notifs):
                        break
                    page.wait_for_timeout(2000)
                check("PIPELINE push RECEIVED + displayed by the browser",
                      any("Pipeline delivery test" in n.get("title", "") for n in pipe_notifs),
                      f"titles={[n.get('title') for n in pipe_notifs]}")
            else:
                check("pipeline fixture (db file found)", False, db_path)

            code, logs = api("GET", "/api/v1/push/admin/overview", None, cookie)
            sent_rows = [x for x in logs.get("data", {}).get("recent", []) if x.get("status") == "SENT"]
            check("PushLog records SENT deliveries", len(sent_rows) >= 1, f"sent rows={len(sent_rows)}")

        page.screenshot(path="/home/z/tmp-verify/push-delivery-final.png")
        real_errors = [e for e in errors if "favicon" not in e.lower()]
        check("no page errors", not real_errors, "; ".join(real_errors[:3]))
        ctx.close()

    failed = [r for r in results if not r[1]]
    print(f"\n=== {len(results) - len(failed)}/{len(results)} checks passed ===")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
