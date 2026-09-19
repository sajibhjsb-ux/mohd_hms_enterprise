#!/usr/bin/env python3
"""Task 30 — Terms & Conditions system: browser QA via raw CDP.

Flow coverage (real UI, real backend):
  A. Public legal pages (no session): /terms + /privacy — content, version,
     effective-date-pending chip, sections, company details, cross links,
     print button, meta title, mobile 320px, no horizontal scroll
  B. Auth screens: welcome + login legal wording carries REAL links
  C. Public page → "Return to sign in" → welcome
  D. Admin session: footer links → in-app canonical pages (SPA nav, back
     history), Settings → Legal tab (overview, drafts, history, toggle)
  E. Customer consent gate (fresh QA customer): gate renders before acceptance,
     checkbox starts UNCHECKED, accept → dashboard, reload → no gate
  F. Mobile 320px consent gate
  G. Console error scan
"""
import base64, json, sqlite3, subprocess, time, urllib.request
from urllib.error import HTTPError
from websocket import create_connection

OUT = "/home/z/tmp-verify"
BASE = "http://localhost:3000"
TS = str(int(time.time()))
ADMIN_EMAIL, ADMIN_PASSWORD = "admin@mohdhms.com", "Password@123"
CUST_EMAIL = f"qa-legal2-{TS}@mohdhms.com"
CUST_EMAIL3 = f"qa-legal3-{TS}@mohdhms.com"
CUST_PASSWORD = "Password@123"

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

# ---------- plain-HTTP helper (setup + teardown) ----------
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
        try:
            return res.status, json.loads(res.read().decode() or "null")
        except Exception:
            return res.status, None

def dev_db():
    return sqlite3.connect("/home/z/my-project/db/custom.db")

def bump_expected(v):
    m = v.split(".")
    return f"{m[0]}.{int(m[1]) + 1}"

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

def wait_for(c, js, want, timeout=15, arg=None):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        last = call_js(c, js, arg)
        if want(last):
            return last
        time.sleep(0.4)
    return last

# ---------- page snippets ----------
JS_LEGAL_STATE = """() => {
  const h1 = document.querySelector('article h1, h1');
  const badges = [...document.querySelectorAll('article [data-slot="badge"], [data-slot="badge"]')].map(b => b.textContent.trim());
  const h2s = [...document.querySelectorAll('article section h2')].map(h => h.textContent.trim());
  const company = document.body.innerText.includes('Company details');
  const cross = document.body.innerText.includes('Privacy Policy') || document.body.innerText.includes('Terms & Conditions');
  const printBtn = !!document.querySelector('button[aria-label="Print this document"]');
  const toc = [...document.querySelectorAll('nav[aria-label="On this page"] a')].length;
  return JSON.stringify({
    h1: h1 ? h1.textContent.trim() : null,
    badges, sections: h2s.length, firstSection: h2s[0] || null,
    company, cross, printBtn, toc,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    title: document.title,
  });
}"""

JS_AUTH_LINKS = """() => {
  const links = [...document.querySelectorAll('a')].filter(a => a.getAttribute('href') === '/terms' || a.getAttribute('href') === '/privacy');
  return JSON.stringify({
    legalLinks: links.map(a => ({ href: a.getAttribute('href'), target: a.target || '_self' })),
    h1: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : null,
  });
}"""

JS_SHELL_STATE = """() => {
  const footer = document.querySelector('footer');
  const footerButtons = footer ? [...footer.querySelectorAll('button, a')].map(b => b.textContent.trim()) : [];
  return JSON.stringify({
    hasFooter: !!footer,
    footerButtons,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  });
}"""

JS_GUEST_LEGAL_BAR = """() => {
  const signin = [...document.querySelectorAll('a')].find(a => a.textContent.includes('Return to sign in'));
  const logo = document.querySelector('img[alt="MOHD.HMS Enterprise logo"]');
  return JSON.stringify({ hasSignIn: !!signin, hasLogo: !!logo,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth });
}"""

JS_GATE_STATE = """() => {
  const h1 = document.querySelector('h1');
  const cb = document.querySelector('#terms-consent');
  const buttons = [...document.querySelectorAll('button')].map(b => ({ t: b.textContent.trim(), disabled: b.disabled }));
  const accept = buttons.find(b => b.t.includes('Agree and continue'));
  const fullLink = [...document.querySelectorAll('a')].some(a => a.getAttribute('href') === '/terms' && a.target === '_blank');
  const badges = [...document.querySelectorAll('[data-slot="badge"]')].map(b => b.textContent.trim());
  return JSON.stringify({
    h1: h1 ? h1.textContent.trim() : null,
    hasCheckbox: !!cb, checked: cb ? cb.checked || cb.hasAttribute('checked') : null,
    acceptDisabled: accept ? accept.disabled : null,
    hasFullLink: fullLink, badges,
    hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  });
}"""

JS_SHELL_LOADED = """() => {
  const header = document.querySelector('header');
  const footer = document.querySelector('footer');
  return JSON.stringify({ loaded: !!header && !!footer });
}"""

JS_CLICK = """(label) => {
  const els = [...document.querySelectorAll('button, a')];
  const el = els.find(b => b.textContent.trim() === label);
  if (!el) return 'NOT_FOUND';
  el.click();
  return 'CLICKED:' + label;
}"""

JS_SET_CHECK = """() => {
  const cb = document.querySelector('#terms-consent');
  if (!cb) return 'NO_CHECKBOX';
  cb.click();
  return 'CLICKED';
}"""

JS_LEGAL_TAB = """() => {
  const cards = [...document.querySelectorAll('[data-slot="card-title"], [data-slot="card"]')].map(c => c.textContent.trim());
  const text = document.body.innerText;
  return JSON.stringify({
    hasTermsCard: text.includes('Terms & Conditions') && text.includes('Canonical version'),
    hasAcceptanceCard: text.includes('Customer acceptance'),
    hasHistory: text.includes('Version history'),
    hasToggle: !!document.querySelector('#terms-acceptance-required'),
    toggleOn: (() => { const el = document.querySelector('#terms-acceptance-required'); return el ? el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked' : null; })(),
    hasPendingChip: text.includes('Effective date pending approval'),
  });
}"""

def set_cookie(c, name, value):
    c.call("Network.setCookie", {"name": name, "value": value, "url": BASE, "path": "/", "httpOnly": True})

def provision_customer(http_admin, email, password):
    st, res = http_admin.request("POST", "/api/v1/customers", {
        "companyName": "", "contactPerson": "QA Legal Browser",
        "email": email, "phone": "+673 1234567",
        "address": "12 QA Road, Bandar Seri Begawan",
        "portalEmail": email, "portalPassword": password,
    })
    assert res and res.get("ok"), f"customer create failed: {res}"
    # login → otpRequired → dev mailbox code → verify → session cookie
    st, login = HTTP().request("POST", "/api/v1/auth/login", {"email": email, "password": password, "remember": False})
    assert login and login.get("data", {}).get("otpRequired"), f"expected OTP challenge: {login}"
    con = dev_db()
    uid = con.execute("SELECT id FROM User WHERE email=?", (email,)).fetchone()[0]
    otp = con.execute("SELECT value FROM Setting WHERE key=?", (f"dev_email_otp_{uid}",)).fetchone()[0]
    con.close()
    http_c = HTTP()
    st, ver = http_c.request("POST", "/api/v1/auth/verify-email", {"email": email, "code": otp, "remember": False})
    assert ver and ver.get("ok"), f"verify failed: {ver}"
    return http_c

def main():
    import os
    os.makedirs(OUT, exist_ok=True)
    http_admin = HTTP()
    st, _ = http_admin.request("POST", "/api/v1/auth/login", {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert st == 200, "admin login failed"
    admin_cookie = http_admin.cookies["hms_session"]

    # Fresh QA customers (browser flows)
    http_c2 = provision_customer(http_admin, CUST_EMAIL, CUST_PASSWORD)
    http_c3 = provision_customer(http_admin, CUST_EMAIL3, CUST_PASSWORD)

    subprocess.run(["agent-browser", "navigate", BASE + "/about:blank"], capture_output=True, timeout=30)
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

    # ================= A. public legal pages =================
    print("— A. Public legal pages (no session)")
    st, terms_api = HTTP().request("GET", "/api/v1/legal/terms")
    CUR_VERSION = terms_api["data"]["version"]
    print(f"  (current published Terms version from API: {CUR_VERSION})")
    c.call("Network.clearBrowserCookies")
    c.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
    c.call("Page.navigate", {"url": BASE + "/terms"}); time.sleep(2.2)
    s = wait_for(c, JS_LEGAL_STATE, lambda v: isinstance(v, dict) and v.get("sections", 0) >= 20, 12)
    check("/terms renders canonical document", isinstance(s, dict) and s.get("h1") == "Terms & Conditions" and s.get("sections") >= 20,
          f"sections={s.get('sections') if isinstance(s, dict) else s}")
    check(f"/terms shows Version {CUR_VERSION} badge", isinstance(s, dict) and any(f"Version {CUR_VERSION}" in b for b in s.get("badges", [])), str(s.get("badges") if isinstance(s, dict) else ""))
    check("/terms effective date pending chip (no invented date)", isinstance(s, dict) and any("pending" in b for b in s.get("badges", [])))
    check("/terms on-this-page nav matches sections", isinstance(s, dict) and s.get("toc") == s.get("sections"))
    check("/terms company details from settings", isinstance(s, dict) and s.get("company"))
    check("/terms cross link to privacy", isinstance(s, dict) and s.get("cross"))
    check("/terms print button", isinstance(s, dict) and s.get("printBtn"))
    check("/terms SEO title", isinstance(s, dict) and "Terms & Conditions" in (s.get("title") or ""), str(s.get("title") if isinstance(s, dict) else ""))
    check("/terms no horizontal scroll (desktop)", isinstance(s, dict) and not s.get("hscroll"))
    shot(c, "legal-terms-desktop")

    c.call("Page.navigate", {"url": BASE + "/privacy"}); time.sleep(2.2)
    s = wait_for(c, JS_LEGAL_STATE, lambda v: isinstance(v, dict) and v.get("sections", 0) >= 8, 12)
    check("/privacy renders canonical document", isinstance(s, dict) and s.get("h1") == "Privacy Policy" and s.get("sections") >= 8,
          f"sections={s.get('sections') if isinstance(s, dict) else s}")
    check("/privacy no horizontal scroll", isinstance(s, dict) and not s.get("hscroll"))
    shot(c, "legal-privacy-desktop")

    # Mobile 320
    c.call("Emulation.setDeviceMetricsOverride", {"width": 320, "height": 700, "deviceScaleFactor": 2, "mobile": True})
    c.call("Page.navigate", {"url": BASE + "/terms"}); time.sleep(2.2)
    s = wait_for(c, JS_LEGAL_STATE, lambda v: isinstance(v, dict) and v.get("sections", 0) >= 20, 12)
    check("/terms no horizontal scroll (320px)", isinstance(s, dict) and not s.get("hscroll"))
    shot(c, "legal-terms-mobile-320")

    # ================= B. auth screen legal wording =================
    print("— B. Auth screen legal wording")
    c.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.0)
    s = wait_for(c, JS_AUTH_LINKS, lambda v: isinstance(v, dict) and len(v.get("legalLinks", [])) >= 2, 10)
    check("welcome screen legal wording has real /terms + /privacy links", isinstance(s, dict) and len(s.get("legalLinks", [])) >= 2, str(s.get("legalLinks") if isinstance(s, dict) else s))
    check("auth legal links open in new tab (flow state preserved)", isinstance(s, dict) and all(l["target"] == "_blank" for l in s.get("legalLinks", [])))
    c.call("Page.navigate", {"url": BASE + "/?auth=login"}); time.sleep(2.0)
    s = wait_for(c, JS_AUTH_LINKS, lambda v: isinstance(v, dict) and len(v.get("legalLinks", [])) >= 2, 10)
    check("login screen legal wording has real links", isinstance(s, dict) and len(s.get("legalLinks", [])) >= 2)

    # ================= C. public page → sign in =================
    print("— C. Public page → Return to sign in")
    c.call("Page.navigate", {"url": BASE + "/terms"}); time.sleep(2.0)
    s = wait_for(c, JS_GUEST_LEGAL_BAR, lambda v: isinstance(v, dict) and v.get("hasSignIn"), 10)
    check("/terms guest bar shows Return to sign in + brand", isinstance(s, dict) and s.get("hasSignIn") and s.get("hasLogo"))
    call_js(c, """() => { const a = [...document.querySelectorAll('a')].find(x => x.textContent.includes('Return to sign in')); a.click(); return 'OK'; }""")
    s = wait_for(c, JS_AUTH_LINKS, lambda v: isinstance(v, dict) and v.get("h1") == "MOHD.HMS Enterprise", 10)
    check("Return to sign in → welcome screen", isinstance(s, dict) and s.get("h1") == "MOHD.HMS Enterprise", str(s.get("h1") if isinstance(s, dict) else s))

    # ================= D. admin: footer + in-app pages + settings Legal tab =================
    print("— D. Admin in-app legal")
    set_cookie(c, "hms_session", admin_cookie)
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.4)
    s = wait_for(c, JS_SHELL_STATE, lambda v: isinstance(v, dict) and v.get("hasFooter"), 12)
    check("admin dashboard loads (shell + footer)", isinstance(s, dict) and s.get("hasFooter"))
    check("footer carries Terms & Conditions + Privacy Policy links", isinstance(s, dict) and "Terms & Conditions" in s.get("footerButtons", []) and "Privacy Policy" in s.get("footerButtons", []), str(s.get("footerButtons") if isinstance(s, dict) else ""))
    shot(c, "legal-admin-dashboard")

    call_js(c, JS_CLICK, "Terms & Conditions")
    s = wait_for(c, JS_LEGAL_STATE, lambda v: isinstance(v, dict) and v.get("sections", 0) >= 20, 12)
    check("footer → /terms in-app (SPA nav, canonical doc)", isinstance(s, dict) and s.get("h1") == "Terms & Conditions" and s.get("sections") >= 20)
    check("in-app /terms keeps app footer", isinstance(s, dict) and isinstance(call_js(c, JS_SHELL_STATE), dict) and call_js(c, JS_SHELL_STATE).get("hasFooter"))
    shot(c, "legal-admin-terms-inapp")

    call_js(c, JS_CLICK, "Privacy Policy")
    s = wait_for(c, JS_LEGAL_STATE, lambda v: isinstance(v, dict) and v.get("h1") == "Privacy Policy", 12)
    check("cross link → /privacy in-app", isinstance(s, dict) and s.get("h1") == "Privacy Policy")
    c.call("Page.navigate", {"url": BASE + "/settings"}); time.sleep(2.4)
    wait_for(c, JS_SHELL_LOADED, lambda v: isinstance(v, dict) and v.get("loaded"), 10)
    # Radix TabsTrigger activates on mousedown (button 0, no ctrl) — a bare
    # .click() never fires it. Dispatch a real mousedown first.
    r = call_js(c, """() => {
      const t = [...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Legal');
      if (!t) return 'NO_TAB';
      t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      t.click();
      return 'CLICKED:Legal';
    }""")
    check("settings → Legal tab opens", r == "CLICKED:Legal", str(r))
    time.sleep(1.6)
    s = wait_for(c, JS_LEGAL_TAB, lambda v: isinstance(v, dict) and v.get("hasTermsCard"), 10)
    check("Legal tab: canonical cards + version history + acceptance toggle", isinstance(s, dict) and s.get("hasTermsCard") and s.get("hasAcceptanceCard") and s.get("hasHistory") and s.get("hasToggle"), str(s))
    check("Legal tab: effective-date pending chip visible", isinstance(s, dict) and s.get("hasPendingChip"))
    check("Legal tab: acceptance toggle is ON (backend state)", isinstance(s, dict) and s.get("toggleOn") is True, str(s.get("toggleOn")))
    shot(c, "legal-admin-settings-tab")

    # Draft editor opens with prefilled next version, then cancel (no save)
    call_js(c, """() => { const b = [...document.querySelectorAll('button')].filter(x => x.textContent.includes('New version draft'))[0]; b.click(); return 'OK'; }""")
    s = wait_for(c, """() => JSON.stringify({ v: !!document.querySelector('#legal-version'), val: (document.querySelector('#legal-version')||{}).value })""",
                 lambda v: isinstance(v, dict) and v.get("v"), 8)
    check("new-version draft editor opens (prefilled next version)", isinstance(s, dict) and s.get("val") == bump_expected(CUR_VERSION), str(s.get("val") if isinstance(s, dict) else s))
    call_js(c, JS_CLICK, "Cancel")

    # ================= E. customer consent gate =================
    print("— E. Customer consent gate (fresh customer)")
    set_cookie(c, "hms_session", http_c2.cookies["hms_session"])
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.4)
    s = wait_for(c, JS_GATE_STATE, lambda v: isinstance(v, dict) and v.get("h1"), 12)
    check("consent gate replaces portal before acceptance", isinstance(s, dict) and s.get("h1") == "Terms & Conditions", str(s.get("h1") if isinstance(s, dict) else s))
    check("gate shows current version badge", isinstance(s, dict) and any(f"Version {CUR_VERSION}" in b for b in s.get("badges", [])), str(s.get("badges") if isinstance(s, dict) else ""))
    check("checkbox starts UNCHECKED", isinstance(s, dict) and s.get("hasCheckbox") and s.get("checked") is not True, str(s.get("checked")))
    check("Agree disabled until checked", isinstance(s, dict) and s.get("acceptDisabled") is True)
    check("full terms opens in new tab", isinstance(s, dict) and s.get("hasFullLink"))
    check("gate no horizontal scroll (desktop)", isinstance(s, dict) and not s.get("hscroll"))
    shot(c, "legal-consent-gate-desktop")

    call_js(c, JS_SET_CHECK)
    time.sleep(0.4)
    s = wait_for(c, JS_GATE_STATE, lambda v: isinstance(v, dict) and v.get("acceptDisabled") is False, 8)
    check("checking the box enables Agree", isinstance(s, dict) and s.get("acceptDisabled") is False, str(s.get("acceptDisabled")))
    call_js(c, JS_CLICK, "Agree and continue")
    s = wait_for(c, JS_SHELL_STATE, lambda v: isinstance(v, dict) and v.get("hasFooter"), 15)
    check("acceptance recorded → portal opens", isinstance(s, dict) and s.get("hasFooter"))
    st, sess = http_c2.request("GET", "/api/v1/auth/session")
    t = sess["data"]["user"]["terms"]
    check(f"backend: acceptedVersion={CUR_VERSION}, requiresAcceptance=false", t["acceptedVersion"] == CUR_VERSION and t["requiresAcceptance"] is False, json.dumps(t))
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.4)
    s = wait_for(c, JS_SHELL_STATE, lambda v: isinstance(v, dict) and v.get("hasFooter"), 12)
    check("reload → no gate after acceptance", isinstance(s, dict) and s.get("hasFooter"))
    shot(c, "legal-customer-dashboard-after-accept")

    # ================= F. mobile 320 consent gate =================
    print("— F. Mobile 320px consent gate")
    c.call("Network.clearBrowserCookies")
    c.call("Emulation.setDeviceMetricsOverride", {"width": 320, "height": 700, "deviceScaleFactor": 2, "mobile": True})
    set_cookie(c, "hms_session", http_c3.cookies["hms_session"])
    c.call("Page.navigate", {"url": BASE + "/"}); time.sleep(2.4)
    s = wait_for(c, JS_GATE_STATE, lambda v: isinstance(v, dict) and v.get("h1"), 12)
    check("320px consent gate renders", isinstance(s, dict) and s.get("h1") == "Terms & Conditions")
    check("320px gate no horizontal scroll / checkbox reachable", isinstance(s, dict) and not s.get("hscroll") and s.get("hasCheckbox"))
    shot(c, "legal-consent-gate-mobile-320")

    # ================= G. console errors =================
    print("\n— Console errors (filtered)")
    noise = ("socket", "realtime", "ERR_CONNECTION", "Failed to load resource", "WebSocket", "favicon")
    real = [e for e in console_errors if not any(n.lower() in e.lower() for n in noise)]
    print(f"  total error events: {len(console_errors)}, non-noise: {len(real)}")
    for e in real[:10]:
        print(f"  • {e}")
    check("no non-noise console errors", len(real) == 0)

    print(f"\nRESULT: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1

if __name__ == "__main__":
    raise SystemExit(main())
