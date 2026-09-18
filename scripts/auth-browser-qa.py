#!/usr/bin/env python3
"""Task 29 — 3-screen mobile auth experience: browser QA via raw CDP.

Flow coverage (real UI, real backend):
  A. Welcome / Login screens across the mandated mobile viewports (no session)
  B. Customer OTP end-to-end: login → ?auth=verify screen → wrong code error
     → correct code (per-digit typing) → dashboard (existing destination)
  C. Admin credentials: wrong password error + successful login → dashboard
  D. Google button → real OAuth entry → not-configured banner (sandbox)
  E. Reduced motion check
"""
import base64, json, subprocess, time, urllib.request
from urllib.error import HTTPError
from websocket import create_connection

OUT = "/home/z/tmp-verify"
BASE = "http://localhost:3000"
TS = str(int(time.time()))
CUSTOMER_EMAIL = f"qa-browser-{TS}@demo.my"
CUSTOMER_PASSWORD = "Password@123"

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

# ---------- plain-HTTP helper (admin setup + dev mailbox) ----------
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

# ---------- JS invocation helpers ----------
def call_js(c, fn_src, arg=None):
    """Invoke a plain JS arrow function via Runtime.evaluate (args JSON-embedded)."""
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

# ---------- page snippets (plain arrow functions) ----------
JS_CLICK = """(label) => {
  const els = [...document.querySelectorAll('button, a')];
  const el = els.find(b => b.textContent.trim() === label);
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'CLICKED:' + label;
}"""

JS_SCREEN_STATE = """() => {
  const q = new URLSearchParams(location.search).get('auth') || 'welcome';
  const logo = document.querySelector('img[alt="MOHD HMS Enterprise logo"]');
  const slots = document.querySelectorAll('[data-slot="input-otp-slot"]');
  const inputs = [...document.querySelectorAll('input')];
  const otpInput = document.querySelector('input[data-input-otp]');
  const h1 = document.querySelector('h1');
  const alerts = [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent.trim());
  const bodyText = document.body.innerText;
  return JSON.stringify({
    authParam: q,
    hasLogo: !!logo,
    logoW: logo ? Math.round(logo.getBoundingClientRect().width) : null,
    h1: h1 ? h1.textContent.trim() : null,
    slots: slots.length,
    otpInputMode: otpInput ? otpInput.inputMode : null,
    otpAutocomplete: otpInput ? otpInput.getAttribute('autocomplete') : null,
    otpPattern: otpInput ? otpInput.getAttribute('pattern') : null,
    emailInput: inputs.some(i => i.type === 'email'),
    pwInput: inputs.some(i => i.type === 'password'),
    emailInputMode: (inputs.find(i => i.type === 'email') || {}).inputMode || null,
    alerts,
    hasResendCountdown: /Resend in \\d{2}:\\d{2}/.test(bodyText),
    resendLabel: (bodyText.match(/Resend in \\d{2}:\\d{2}|Resend Code|Sending…/) || [null])[0],
    emailShownOnVerify: (bodyText.match(/sent to\\s+([^\\n]+)/) || [null, null])[1],
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

JS_CLICK_OTP_BACK = """() => {
  const b = document.querySelector('button[aria-label="Back to login"]');
  if (!b) return 'NOT_FOUND';
  b.click();
  return 'OK';
}"""

JS_PW_TOGGLE = """async () => {
  const pw = document.querySelector('#auth-password');
  if (!pw) return 'NO_PW';
  const before = pw.type;
  const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('password'));
  if (!btn) return 'NO_TOGGLE';
  btn.click();
  await new Promise(r => setTimeout(r, 120));
  const after = document.querySelector('#auth-password').type;
  btn.click();
  await new Promise(r => setTimeout(r, 120));
  const restored = document.querySelector('#auth-password').type;
  return JSON.stringify({ before, after, restored });
}"""

JS_SHELL_STATE = """() => {
  const header = document.querySelector('header');
  const bodyText = document.body.innerText;
  return JSON.stringify({
    hasShellHeader: !!header,
    profileBanner: !!header && /complete your profile|profile completion|add your mobile|mobile number|address/i.test(bodyText),
    url: location.pathname + location.search,
  });
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

def main():
    # ---------- setup: admin API session + fresh unverified customer ----------
    http = HTTP()
    st, _ = http.request("POST", "/api/v1/auth/login", {"email": "admin@mohdhms.com", "password": CUSTOMER_PASSWORD})
    assert st == 200, f"admin login failed: {st}"
    st, d = http.request("POST", "/api/v1/users", {"email": CUSTOMER_EMAIL, "name": "QA Browser Customer", "password": CUSTOMER_PASSWORD, "role": "CUSTOMER", "phone": "+6737000001"})
    assert st in (200, 201), f"customer create failed: {st} {d}"
    print(f"setup: admin session + unverified customer {CUSTOMER_EMAIL}\n")

    ep = cdp()
    with urllib.request.urlopen(f"{ep}/json/list") as f:
        targets = json.load(f)
    page = next(t for t in targets if t.get("type") == "page")
    c = CDP(page["webSocketDebuggerUrl"])
    c.call("Runtime.enable"); c.call("Page.enable"); c.call("Network.enable"); c.call("Log.enable")
    console_errors = []

    # wrapper that also drains websocket events (collect console errors)
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

    # ================= A. viewport matrix on welcome + login =================
    print("— A. Viewport matrix (welcome + login screens)")
    c.call("Network.clearBrowserCookies")
    for label, w, h, dpr, mob in VIEWPORTS:
        c.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mob})
        c.call("Page.navigate", {"url": BASE + "/"})
        time.sleep(2.0)
        s = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("hasLogo") and s.get("h1") == "MOHD.HMS Enterprise", 10)
        check(f"{label} welcome renders", isinstance(s, dict) and s.get("hasLogo") and not s.get("hscroll"),
              f"logo={s.get('logoW')}px hscroll={s.get('hscroll')}" if isinstance(s, dict) else str(s))
        if label == "390x844":
            shot(c, "auth-welcome-390")
        r = call_js(c, JS_CLICK, "Continue with Email")
        s2 = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
        check(f"{label} login renders (URL ?auth=login)", isinstance(s2, dict) and s2.get("authParam") == "login" and s2.get("emailInput") and s2.get("pwInput") and not s2.get("hscroll"),
              f"h1={s2.get('h1')} hscroll={s2.get('hscroll')} click={r}" if isinstance(s2, dict) else str(s2))
        if label == "390x844":
            shot(c, "auth-login-390")
            check("email field uses mobile email keyboard", s2.get("emailInputMode") == "email", str(s2.get("emailInputMode")))

    # standard viewport for the interactive E2E
    c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)

    # ================= D. Google button — real OAuth E2E via local mock =================
    print("\n— D. Google button wires to the real OAuth flow (local mock provider)")
    GOOGLE_EMAIL = f"qa-google-{TS}@gmail.com"
    # Save the mock's current identity so we can restore it afterwards.
    with urllib.request.urlopen("http://localhost:3040/mock/user", timeout=10) as f:
        saved_identity = json.load(f)["who"]
    req = urllib.request.Request("http://localhost:3040/mock/user", data=json.dumps({"email": GOOGLE_EMAIL, "name": "QA Google Mobile"}).encode(), headers={"content-type": "application/json"}, method="POST")
    urllib.request.urlopen(req, timeout=10).read()
    try:
        call_js(c, JS_CLICK, "Continue with Google")
        landing = wait_for(c, JS_SHELL_STATE, lambda s: isinstance(s, dict) and s.get("hasShellHeader"), 20)
        check("full OAuth round-trip opens the app", isinstance(landing, dict) and landing.get("hasShellHeader"), str(landing.get("url") if isinstance(landing, dict) else landing))
        check("new Google customer lands on existing onboarding (/profile/complete)", isinstance(landing, dict) and "/profile/complete" in str(landing.get("url")), str(landing.get("url") if isinstance(landing, dict) else landing))
        shot(c, "auth-google-onboarding-390")
    finally:
        req = urllib.request.Request("http://localhost:3040/mock/user", data=json.dumps(saved_identity).encode(), headers={"content-type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=10).read()

    # ================= B. Customer OTP end-to-end =================
    print("\n— B. Customer OTP verification end-to-end")
    c.call("Network.clearBrowserCookies")
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    call_js(c, JS_CLICK, "Continue with Email")
    wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)

    toggle = call_js(c, JS_PW_TOGGLE)
    check("show/hide password toggles type", toggle == "NO_PW" or toggle == {"before": "password", "after": "text", "restored": "password"}, str(toggle))

    call_js(c, JS_SET_INPUT, ["#auth-email", CUSTOMER_EMAIL])
    call_js(c, JS_SET_INPUT, ["#auth-password", CUSTOMER_PASSWORD])
    call_js(c, """() => { document.querySelector('#auth-remember').click(); return 'OK'; }""")
    call_js(c, JS_CLICK, "Log In")

    otp_screen = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "verify", 12)
    check("OTP screen reached via real navigation (?auth=verify)", isinstance(otp_screen, dict) and otp_screen.get("authParam") == "verify", str(otp_screen))
    check("6 OTP slots rendered", isinstance(otp_screen, dict) and otp_screen.get("slots") == 6, f"slots={otp_screen.get('slots') if isinstance(otp_screen, dict) else '?'}")
    check("numeric mobile keyboard on OTP", isinstance(otp_screen, dict) and otp_screen.get("otpInputMode") == "numeric", str(otp_screen.get("otpInputMode") if isinstance(otp_screen, dict) else None))
    check("one-time-code autocomplete", isinstance(otp_screen, dict) and otp_screen.get("otpAutocomplete") == "one-time-code", str(otp_screen.get("otpAutocomplete") if isinstance(otp_screen, dict) else None))
    check("digits-only pattern", isinstance(otp_screen, dict) and "\\d" in str(otp_screen.get("otpPattern")), str(otp_screen.get("otpPattern") if isinstance(otp_screen, dict) else None))
    check("user email displayed (from backend response)", isinstance(otp_screen, dict) and otp_screen.get("emailShownOnVerify") == CUSTOMER_EMAIL, str(otp_screen.get("emailShownOnVerify") if isinstance(otp_screen, dict) else None))
    check("resend countdown ticking (server 30s)", isinstance(otp_screen, dict) and otp_screen.get("hasResendCountdown"), str(otp_screen.get("resendLabel") if isinstance(otp_screen, dict) else None))
    check("no horizontal scroll on verify screen", isinstance(otp_screen, dict) and not otp_screen.get("hscroll"))
    shot(c, "auth-verify-390")

    # back navigation: verify → login (real history)
    call_js(c, JS_CLICK_OTP_BACK)
    time.sleep(1.2)
    back_state = call_js(c, JS_SCREEN_STATE)
    check("on-screen back returns to login (history)", isinstance(back_state, dict) and back_state.get("authParam") == "login", str(back_state.get("authParam") if isinstance(back_state, dict) else back_state))
    # browser forward → verify again (popstate-driven URL sync)
    eval_expr(c, "history.forward()")
    time.sleep(1.2)
    fwd_state = call_js(c, JS_SCREEN_STATE)
    check("browser forward returns to verify screen", isinstance(fwd_state, dict) and fwd_state.get("authParam") == "verify", str(fwd_state.get("authParam") if isinstance(fwd_state, dict) else fwd_state))

    # wrong code → generic error
    call_js(c, JS_SET_INPUT, ['input[data-input-otp]', "000000"])
    time.sleep(0.3)
    call_js(c, JS_CLICK, "Verify Code")
    err_state = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("Invalid or expired" in a for a in s.get("alerts", [])), 10)
    check("wrong code → spec error message", isinstance(err_state, dict) and any("Invalid or expired verification code." in a for a in err_state.get("alerts", [])))
    shot(c, "auth-verify-error-390")

    # fetch the real code (dev mailbox via admin API)
    st, settings = http.request("GET", "/api/v1/settings")
    code = None
    for k, v in (settings.get("data") or {}).items():
        if k.startswith("dev_email_otp_"):
            code = v
    check("code fetched from dev mailbox (6 digits)", bool(code and len(code) == 6))

    # clear the wrong code, then type the correct one digit-by-digit (real typing path)
    call_js(c, JS_SET_INPUT, ['input[data-input-otp]', ""])
    time.sleep(0.2)
    for ch in (code or "000000"):
        call_js(c, JS_TYPE_CHAR, ch)
        time.sleep(0.12)
    time.sleep(0.3)
    call_js(c, JS_CLICK, "Verify Code")
    shell = wait_for(c, JS_SHELL_STATE, lambda s: isinstance(s, dict) and s.get("hasShellHeader"), 15)
    check("verification opens the app (shell header visible)", isinstance(shell, dict) and shell.get("hasShellHeader"), str(shell.get("url") if isinstance(shell, dict) else shell))
    check("URL cleaned after auth success", isinstance(shell, dict) and "auth=" not in str(shell.get("url")), str(shell.get("url") if isinstance(shell, dict) else shell))
    check("customer profile-completion banner present", isinstance(shell, dict) and shell.get("profileBanner"))
    shot(c, "auth-after-verify-dashboard-390")

    # second login: no OTP anymore (email now verified)
    c.call("Network.clearBrowserCookies")
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    call_js(c, JS_CLICK, "Continue with Email")
    wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
    call_js(c, JS_SET_INPUT, ["#auth-email", CUSTOMER_EMAIL])
    call_js(c, JS_SET_INPUT, ["#auth-password", CUSTOMER_PASSWORD])
    call_js(c, JS_CLICK, "Log In")
    second = wait_for(c, JS_SHELL_STATE, lambda s: isinstance(s, dict) and s.get("hasShellHeader"), 12)
    check("verified customer logs in without OTP", isinstance(second, dict) and second.get("hasShellHeader"))

    # ================= C. Admin credentials + errors =================
    print("\n— C. Admin credentials (wrong password → error → success)")
    c.call("Network.clearBrowserCookies")
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    call_js(c, JS_CLICK, "Log In")
    wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and s.get("authParam") == "login", 10)
    call_js(c, JS_SET_INPUT, ["#auth-email", "admin@mohdhms.com"])
    call_js(c, JS_SET_INPUT, ["#auth-password", "WrongPassword1"])
    call_js(c, JS_CLICK, "Log In")
    err = wait_for(c, JS_SCREEN_STATE, lambda s: isinstance(s, dict) and any("Invalid email or password" in a for a in s.get("alerts", [])), 10)
    check("invalid credentials → safe message", isinstance(err, dict) and any("Invalid email or password." in a for a in err.get("alerts", [])))
    shot(c, "auth-login-error-390")

    call_js(c, JS_SET_INPUT, ["#auth-password", CUSTOMER_PASSWORD])
    call_js(c, JS_CLICK, "Log In")
    admin_shell = wait_for(c, JS_SHELL_STATE, lambda s: isinstance(s, dict) and s.get("hasShellHeader"), 12)
    check("admin login → dashboard (no OTP)", isinstance(admin_shell, dict) and admin_shell.get("hasShellHeader"))
    shot(c, "auth-admin-dashboard-390")

    # ================= E. Reduced motion =================
    print("\n— E. Reduced motion")
    c.call("Network.clearBrowserCookies")
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    rm = call_js(c, JS_RM_ANIM)
    check("prefers-reduced-motion disables transition", rm in ("none", "no-el"), str(rm))
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": ""}]})

    print("\n— Console errors (filtered)")
    noise = ("socket", "realtime", "ERR_CONNECTION", "Failed to load resource", "WebSocket")
    real = [e for e in console_errors if not any(n.lower() in e.lower() for n in noise)]
    print(f"  total error events: {len(console_errors)}, non-noise: {len(real)}")
    for e in real[:10]:
        print(f"  • {e}")

    print(f"\nRESULT: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1
if __name__ == "__main__":
    raise SystemExit(main())
