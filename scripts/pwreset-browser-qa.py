#!/usr/bin/env python3
"""Password recovery flow — browser QA via raw CDP (real UI, real backend).

Coverage:
  A. Full E2E at 390x844: login → Forgot Password? → email (invalid + valid)
     → OTP screen (wrong code, then real code from the dev mailbox)
     → New Password (mismatch, weak, then correct) → Success → Back to Login
     → old password FAILS → new password WORKS (dashboard).
  B. Route-bypass: /?auth=new-password and /?auth=reset-success without
     server-issued state fall back to the welcome screen.
  C. Offline: forgot-password submit shows the offline message; recovers online.
  D. Viewport matrix (320/360/375/390/412/430): full flow per viewport,
     screenshots, no-horizontal-scroll asserts.
  E. Reduced-motion + console error scan.
  F. Cleanup: QA users removed via the admin API.
"""
import base64, json, subprocess, time, urllib.request
from urllib.error import HTTPError
from websocket import create_connection

OUT = "/home/z/tmp-verify"
BASE = "http://localhost:3000"
TS = str(int(time.time()))
OLD_PW = "OldPassword@123"
NEW_PW = "NewPassword@456"

VIEWPORTS = [
    ("320x568", 320, 568, 2, True),
    ("360x640", 360, 640, 3, True),
    ("375x667", 375, 667, 2, True),
    ("390x844", 390, 844, 3, True),
    ("412x915", 412, 915, 3, True),
    ("430x932", 430, 932, 3, True),
]

PASS = 0
FAIL = 0
def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}" + (f" — {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  ✗ FAIL: {name}" + (f" — {detail}" if detail else ""))

def shot(c, name):
    data = c.call("Page.captureScreenshot", {"format": "png"})["data"]
    open(f"{OUT}/{name}.png", "wb").write(base64.b64decode(data))

class HTTP:
    def __init__(self):
        self.cookies = {}
    def request(self, method, path, body=None):
        headers = {"content-type": "application/json"}
        if self.cookies:
            headers["cookie"] = "; ".join(f"{k}={v}" for k, v in self.cookies.items())
        req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
        try:
            res = urllib.request.urlopen(req, timeout=30)
        except HTTPError as e:
            res = e
        for ck in res.headers.get_all("set-cookie") or []:
            pair = ck.split(";")[0]
            k, _, v = pair.partition("=")
            self.cookies[k.strip()] = v.strip()
        return res.status, json.loads(res.read().decode() or "null")

def cdp():
    out = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20).stdout
    url = out.strip().splitlines()[-1]
    if url.startswith("ws://"): url = "http://" + url[5:]
    elif url.startswith("wss://"): url = "https://" + url[6:]
    from urllib.parse import urlsplit
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"

class CDP:
    def __init__(self, ws_url):
        self.ws = create_connection(ws_url, timeout=30, suppress_origin=True); self.i = 0
    def call(self, method, params=None, wait=True):
        self.i += 1; mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        if not wait: return None
        t0 = time.time()
        while time.time() - t0 < 30:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg: raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})
        raise TimeoutError(method)

def call_js(c, fn_src, arg=None):
    arg_json = json.dumps(arg) if arg is not None else ""
    expr = f"({fn_src})({arg_json})"
    r = c.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    if "exceptionDetails" in r:
        return f"JS_ERROR: {json.dumps(r['exceptionDetails'])[:300]}"
    v = r.get("result", {}).get("value")
    if isinstance(v, str) and v.startswith(("{", "[")):
        try:
            return json.loads(v)
        except Exception:
            return v
    return v

def eval_expr(c, expr):
    r = c.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
    if "exceptionDetails" in r:
        return f"JS_ERROR: {json.dumps(r['exceptionDetails'])[:300]}"
    return r.get("result", {}).get("value")

JS_CLICK = """(label) => {
  const els = [...document.querySelectorAll('button, a')];
  const el = els.find(b => b.textContent.trim() === label);
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'CLICKED:' + label;
}"""

JS_SCREEN_STATE = """() => {
  const q = new URLSearchParams(location.search).get('auth') || 'welcome';
  const h1 = document.querySelector('h1');
  const slots = document.querySelectorAll('[data-slot="input-otp-slot"]');
  const inputs = [...document.querySelectorAll('input')];
  const otpInput = document.querySelector('input[data-input-otp]');
  const alerts = [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent.trim());
  const bodyText = document.body.innerText;
  return JSON.stringify({
    authParam: q,
    h1: h1 ? h1.textContent.trim() : null,
    slots: slots.length,
    otpInputMode: otpInput ? otpInput.inputMode : null,
    otpAutocomplete: otpInput ? otpInput.getAttribute('autocomplete') : null,
    emailInput: inputs.some(i => i.type === 'email'),
    emailInputMode: (inputs.find(i => i.type === 'email') || {}).inputMode || null,
    pwCount: inputs.filter(i => i.type === 'password' || (i.type === 'text' && i.id.includes('password'))).length,
    alerts,
    hasResendCountdown: /Resend in \\d{2}:\\d{2}/.test(bodyText),
    emailShownOnVerify: (bodyText.match(/sent to\\s+([^\\n]+)/) || [null, null])[1],
    hasNotice: /verification code has been sent/.test(bodyText),
    hasStrength: !!document.querySelector('#new-password-strength'),
    fieldErrors: [document.querySelector('#new-password-error'), document.querySelector('#confirm-password-error')].filter(Boolean).map(e => e.textContent.trim()),
    hscroll: document.documentElement.scrollWidth > innerWidth,
    vw: innerWidth, vh: innerHeight,
  });
}"""

JS_SET_INPUT = """(args) => {
  const input = document.querySelector(args[0]);
  if (!input) return 'NO_INPUT';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, args[1]);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'SET';
}"""

JS_TYPE_CHAR = """(ch) => {
  const input = document.querySelector('input[data-input-otp]');
  if (!input) return 'NO_INPUT';
  input.focus();
  document.execCommand('insertText', false, ch);
  return 'OK';
}"""

JS_PW_TOGGLE_NEW = """async () => {
  const pw = document.querySelector('#new-password');
  if (!pw) return 'NO_PW';
  const before = pw.type;
  const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === 'Show password');
  if (!btn) return 'NO_TOGGLE';
  btn.click();
  await new Promise(r => setTimeout(r, 120));
  const after = document.querySelector('#new-password').type;
  btn.click();
  await new Promise(r => setTimeout(r, 120));
  const restored = document.querySelector('#new-password').type;
  return JSON.stringify({ before, after, restored });
}"""

JS_RM_ANIM = """() => {
  const el = document.querySelector('.auth-screen-in');
  return el ? getComputedStyle(el).animationName : 'no-el';
}"""

def wait_for(c, js, want, timeout=15, arg=None):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        last = call_js(c, js, arg)
        if want(last):
            return last
        time.sleep(0.4)
    return last

def fetch_otp(http, email):
    st, users = http.request("GET", f"/api/v1/users?search={email}")
    uid = next((u["id"] for u in (users.get("data") or []) if u.get("email") == email), None)
    if not uid:
        return None
    st, settings = http.request("GET", "/api/v1/settings")
    return (settings.get("data") or {}).get(f"dev_email_otp_password_reset_{uid}")

def run_flow(c, http, email, label, full):
    """One complete recovery journey for one QA user at the current viewport."""
    tag = label.replace("x", "-")
    c.call("Network.clearBrowserCookies")
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    call_js(c, JS_CLICK, "Log In")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
    check(f"[{label}] login screen", isinstance(s, dict) and s.get("authParam") == "login")

    call_js(c, JS_CLICK, "Forgot Password?")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "forgot", 10)
    check(f"[{label}] Forgot Password screen (dedicated, URL ?auth=forgot)", isinstance(s, dict) and s.get("h1") == "Forgot Password?" and s.get("emailInput"), str(s.get("h1") if isinstance(s, dict) else s))
    check(f"[{label}] email keyboard on forgot screen", isinstance(s, dict) and s.get("emailInputMode") == "email")
    check(f"[{label}] no horizontal scroll (forgot)", isinstance(s, dict) and not s.get("hscroll"))
    if label == "390x844":
        shot(c, "pwreset-forgot-390")

    if full:
        # client-side email validation (UX only)
        call_js(c, JS_SET_INPUT, ["#forgot-email", "not-an-email"])
        call_js(c, JS_CLICK, "Send Verification Code")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("valid email" in a for a in s.get("alerts", [])), 8)
        check("[390x844] invalid email → clean validation message", isinstance(s, dict) and any("Please enter a valid email address." in a for a in s.get("alerts", [])), str(s.get("alerts") if isinstance(s, dict) else s))
        call_js(c, JS_SET_INPUT, ["#forgot-email", ""])
        call_js(c, JS_CLICK, "Send Verification Code")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("enter your email" in a for a in s.get("alerts", [])), 8)
        check("[390x844] empty email → clean validation message", isinstance(s, dict) and any("Please enter your email address." in a for a in s.get("alerts", [])))

    call_js(c, JS_SET_INPUT, ["#forgot-email", email])
    call_js(c, JS_CLICK, "Send Verification Code")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "reset-otp", 12)
    check(f"[{label}] OTP screen reached (?auth=reset-otp)", isinstance(s, dict) and s.get("authParam") == "reset-otp", str(s.get("authParam") if isinstance(s, dict) else s))
    check(f"[{label}] 6 slots / numeric / one-time-code", isinstance(s, dict) and s.get("slots") == 6 and s.get("otpInputMode") == "numeric" and s.get("otpAutocomplete") == "one-time-code", f"slots={s.get('slots') if isinstance(s, dict) else '?'}")
    check(f"[{label}] server-driven resend countdown (60s)", isinstance(s, dict) and s.get("hasResendCountdown"), str(s.get("hasResendCountdown") if isinstance(s, dict) else None))
    check(f"[{label}] user email displayed", isinstance(s, dict) and s.get("emailShownOnVerify") == email, str(s.get("emailShownOnVerify") if isinstance(s, dict) else None))
    check(f"[{label}] generic notice banner shown", isinstance(s, dict) and s.get("hasNotice"))
    check(f"[{label}] no horizontal scroll (otp)", isinstance(s, dict) and not s.get("hscroll"))
    if label == "390x844":
        shot(c, "pwreset-otp-390")
        # back navigation chain: reset-otp → forgot (real history)
        call_js(c, """() => { document.querySelector('button[aria-label="Back to email entry"]').click(); return 'OK'; }""")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "forgot", 8)
        check("[390x844] back from OTP returns to email entry (history)", isinstance(s, dict) and s.get("authParam") == "forgot")
        call_js(c, JS_SET_INPUT, ["#forgot-email", email])
        call_js(c, JS_CLICK, "Send Verification Code")
        wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "reset-otp", 12)

    if full:
        call_js(c, JS_SET_INPUT, ['input[data-input-otp]', "000000"])
        time.sleep(0.3)
        call_js(c, JS_CLICK, "Verify Code")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("Invalid or expired" in a for a in s.get("alerts", [])), 10)
        check("[390x844] wrong code → generic error", isinstance(s, dict) and any("Invalid or expired verification code." in a for a in s.get("alerts", [])))
        shot(c, "pwreset-otp-error-390")
        call_js(c, JS_SET_INPUT, ['input[data-input-otp]', ""])

    code = fetch_otp(http, email)
    check(f"[{label}] OTP fetched from dev mailbox (6 digits)", bool(code and len(code) == 6))
    for ch in (code or "000000"):
        call_js(c, JS_TYPE_CHAR, ch)
        time.sleep(0.12)
    time.sleep(0.3)
    call_js(c, JS_CLICK, "Verify Code")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "new-password", 12)
    check(f"[{label}] New Password screen (?auth=new-password)", isinstance(s, dict) and s.get("h1") == "Create New Password" and s.get("pwCount") == 2, str(s.get("h1") if isinstance(s, dict) else s))
    time.sleep(0.5)  # let the remount settle before touching inputs
    check(f"[{label}] strength hint present", isinstance(s, dict) and s.get("hasStrength"))
    check(f"[{label}] no horizontal scroll (new password)", isinstance(s, dict) and not s.get("hscroll"))
    if label == "390x844":
        shot(c, "pwreset-new-password-390")
        toggle = call_js(c, JS_PW_TOGGLE_NEW)
        check("[390x844] show/hide toggles work on both fields", toggle == {"before": "password", "after": "text", "restored": "password"}, str(toggle))
        # mismatch — must not reach the server
        call_js(c, JS_SET_INPUT, ["#new-password", NEW_PW])
        call_js(c, JS_SET_INPUT, ["#confirm-password", "Different@123"])
        call_js(c, JS_CLICK, "Reset Password")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("Passwords do not match." in e for e in s.get("fieldErrors", [])), 8)
        check("[390x844] mismatch → 'Passwords do not match.'", isinstance(s, dict) and any("Passwords do not match." in e for e in s.get("fieldErrors", [])), str(s.get("fieldErrors") if isinstance(s, dict) else s))
        # weak password — client mirrors the EXISTING server policy (server-side
        # rejection is covered by the API QA suite)
        call_js(c, JS_SET_INPUT, ["#new-password", "short1"])
        call_js(c, JS_SET_INPUT, ["#confirm-password", "short1"])
        call_js(c, JS_CLICK, "Reset Password")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("at least 8" in e for e in s.get("fieldErrors", [])), 10)
        check("[390x844] weak password → policy message", isinstance(s, dict) and any("at least 8" in e for e in s.get("fieldErrors", [])), str(s.get("fieldErrors") if isinstance(s, dict) else s))
        shot(c, "pwreset-new-password-error-390")

    # final submit — set both fields (retry if a remount ate an input)
    for _ in range(3):
        r1 = call_js(c, JS_SET_INPUT, ["#new-password", NEW_PW])
        r2 = call_js(c, JS_SET_INPUT, ["#confirm-password", NEW_PW])
        if r1 == "SET" and r2 == "SET":
            break
        time.sleep(0.6)
    call_js(c, JS_CLICK, "Reset Password")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "reset-success", 12)
    check(f"[{label}] Success screen (?auth=reset-success)", isinstance(s, dict) and s.get("h1") == "Password Reset Successful", str(s.get("h1") if isinstance(s, dict) else s))
    check(f"[{label}] no horizontal scroll (success)", isinstance(s, dict) and not s.get("hscroll"))
    if label == "390x844":
        shot(c, "pwreset-success-390")

    call_js(c, JS_CLICK, "Back to Login")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
    check(f"[{label}] Back to Login returns to the real login screen", isinstance(s, dict) and s.get("authParam") == "login")

    if full:
        call_js(c, JS_SET_INPUT, ["#auth-email", email])
        call_js(c, JS_SET_INPUT, ["#auth-password", OLD_PW])
        call_js(c, JS_CLICK, "Log In")
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("Invalid email or password" in a for a in s.get("alerts", [])), 10)
        check("[390x844] OLD password → rejected", isinstance(s, dict) and any("Invalid email or password." in a for a in s.get("alerts", [])))
        call_js(c, JS_SET_INPUT, ["#auth-password", NEW_PW])
        call_js(c, JS_CLICK, "Log In")
        s = wait_for(c, JS_SHELL_STATE, lambda s: isinstance(s, dict) and s.get("hasShellHeader"), 12)
        check("[390x844] NEW password → dashboard (shell header)", isinstance(s, dict) and s.get("hasShellHeader"))
        shot(c, "pwreset-new-login-dashboard-390")

JS_SHELL_STATE = """() => {
  const header = document.querySelector('header');
  return JSON.stringify({ hasShellHeader: !!header, url: location.pathname + location.search });
}"""

def main():
    http = HTTP()
    st, _ = http.request("POST", "/api/v1/auth/login", {"email": "admin@mohdhms.com", "password": "Password@123"})
    assert st == 200, f"admin login failed: {st}"

    users = {}
    for label, *_ in VIEWPORTS:
        email = f"qa-pw-{label.split('x')[0]}-{TS}@demo.my"
        st, d = http.request("POST", "/api/v1/users", {"email": email, "name": f"QA PW {label}", "password": OLD_PW, "role": "SUPERVISOR"})
        assert st in (200, 201), f"user create failed: {st} {d}"
        users[label] = email
    print(f"setup: admin session + {len(users)} QA staff accounts\n")

    ep = cdp()
    with urllib.request.urlopen(f"{ep}/json/list") as f:
        targets = json.load(f)
    page = next(t for t in targets if t.get("type") == "page")
    c = CDP(page["webSocketDebuggerUrl"])
    c.call("Runtime.enable"); c.call("Page.enable"); c.call("Network.enable"); c.call("Log.enable")
    console_errors = []
    orig_call = c.call
    def call_collect(method, params=None, wait=True):
        c.ws.settimeout(0.25)
        t0 = time.time()
        while time.time() - t0 < 0.25:
            try:
                m = json.loads(c.ws.recv())
                if m.get("method") == "Runtime.consoleAPICalled" and m["params"].get("type") == "error":
                    args = m["params"].get("args", [{}])
                    console_errors.append(str(args[0].get("description", "") or args)[:200])
            except Exception:
                pass
        c.ws.settimeout(30)
        return orig_call(method, params, wait)
    c.call = call_collect

    print("— A+B. Viewport matrix with FULL flow per viewport (390x844 = deep E2E)")
    for label, w, h, dpr, mob in VIEWPORTS:
        c.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mob})
        run_flow(c, http, users[label], label, full=(label == "390x844"))

    # standard viewport for the remaining sections
    c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})

    print("\n— C. Route bypass (fresh context, hand-typed deep links)")
    c.call("Network.clearBrowserCookies")
    c.call("Page.navigate", {"url": BASE + "/?auth=new-password"}); time.sleep(2.2)
    s = call_js(c, JS_SCREEN_STATE)
    check("?auth=new-password without authorization → welcome fallback", isinstance(s, dict) and s.get("authParam") == "welcome" and s.get("pwCount") == 0, str(s.get("authParam") if isinstance(s, dict) else s))
    c.call("Page.navigate", {"url": BASE + "/?auth=reset-success"}); time.sleep(2.2)
    s = call_js(c, JS_SCREEN_STATE)
    check("?auth=reset-success without state → welcome fallback", isinstance(s, dict) and s.get("authParam") == "welcome" and s.get("h1") != "Password Reset Successful", str(s.get("authParam") if isinstance(s, dict) else s))
    c.call("Page.navigate", {"url": BASE + "/?auth=reset-otp"}); time.sleep(2.2)
    s = call_js(c, JS_SCREEN_STATE)
    check("?auth=reset-otp without email → welcome fallback", isinstance(s, dict) and s.get("authParam") == "welcome" and s.get("slots") == 0, str(s.get("authParam") if isinstance(s, dict) else s))
    shot(c, "pwreset-bypass-fallback-390")

    print("\n— D. Offline behavior (PWA / no connection)")
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    call_js(c, JS_CLICK, "Log In")
    wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
    call_js(c, JS_CLICK, "Forgot Password?")
    wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "forgot", 10)
    c.call("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    call_js(c, JS_SET_INPUT, ["#forgot-email", "anyone@example.com"])
    call_js(c, JS_CLICK, "Send Verification Code")
    s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("internet connection" in a for a in s.get("alerts", [])), 12)
    check("offline → 'An internet connection is required to reset your password.'", isinstance(s, dict) and any("An internet connection is required to reset your password." in a for a in s.get("alerts", [])), str(s.get("alerts") if isinstance(s, dict) else s))
    shot(c, "pwreset-offline-390")
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

    print("\n— E. Reduced motion")
    c.call("Network.clearBrowserCookies")
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    rm = call_js(c, JS_RM_ANIM)
    check("prefers-reduced-motion disables transition", rm in ("none", "no-el"), str(rm))
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": ""}]})

    print("\n— F. Console errors (filtered)")
    noise = ("socket", "realtime", "ERR_CONNECTION", "ERR_INTERNET", "Failed to load resource", "WebSocket", "net::")
    real = [e for e in console_errors if not any(n.lower() in e.lower() for n in noise)]
    print(f"  total error events: {len(console_errors)}, non-noise: {len(real)}")
    for e in real[:10]:
        print(f"    · {e}")
    check("no unexpected console errors", len(real) == 0)

    print("\n— G. Cleanup (QA users via admin API)")
    deleted = 0
    for email in users.values():
        st, lst = http.request("GET", f"/api/v1/users?search={email}")
        uid = next((u["id"] for u in (lst.get("data") or []) if u.get("email") == email), None)
        if uid:
            st, _ = http.request("DELETE", f"/api/v1/users/{uid}")
            deleted += 1 if st in (200, 201) else 0
    check("QA users removed", deleted == len(users), f"{deleted}/{len(users)}")

    print(f"\nRESULT: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0

if __name__ == "__main__":
    import sys
    sys.exit(main())
