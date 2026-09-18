#!/usr/bin/env python3
"""Splash logo QA: measure the gate.tsx splash logo across the full viewport matrix."""
import base64, json, subprocess, time, urllib.request
from websocket import create_connection

OUT = "/home/z/tmp-verify"
VIEWPORTS = [
    # label, w, h, dpr, mobile
    ("320x568 mob-p",    320, 568, 2, True),
    ("360x640 mob-p",    360, 640, 3, True),
    ("375x667 mob-p",    375, 667, 2, True),
    ("390x844 mob-p",    390, 844, 3, True),
    ("412x915 mob-p",    412, 915, 3, True),
    ("430x932 mob-p",    430, 932, 3, True),
    ("568x320 mob-L",    568, 320, 2, True),
    ("667x375 mob-L",    667, 375, 2, True),
    ("844x390 mob-L",    844, 390, 3, True),
    ("932x430 mob-L",    932, 430, 3, True),
    ("768x1024 tab-p",   768, 1024, 2, True),
    ("820x1180 tab-p",   820, 1180, 2, True),
    ("1024x768 tab-L",   1024, 768, 2, True),
    ("1280x720 dt-1x",   1280, 720, 1, False),
    ("1366x768 dt-2x",   1366, 768, 2, False),
    ("1440x900 dt-2x",   1440, 900, 2, False),
    ("1920x1080 dt-1x",  1920, 1080, 1, False),
    ("2560x1440 dt-1x",  2560, 1440, 1, False),
    ("3840x2160 4k-1x",  3840, 2160, 1, False),
]
SHOTS = {"320x568 mob-p", "390x844 mob-p", "844x390 mob-L", "768x1024 tab-p",
         "1366x768 dt-2x", "1920x1080 dt-1x", "3840x2160 4k-1x"}

MEASURE = """(() => {
  const cont = document.querySelector('.splash-viewport');
  const img = cont ? cont.querySelector('img[alt="MOHD HMS Enterprise logo"]') : null;
  const r = img ? img.getBoundingClientRect() : null;
  const cs = img ? getComputedStyle(img) : null;
  const ccs = cont ? getComputedStyle(cont) : null;
  const txt = cont ? cont.querySelector('p') : null;
  return JSON.stringify({
    present: !!img,
    src: img ? img.currentSrc.split('/').slice(-2).join('/') : null,
    natural: img ? [img.naturalWidth, img.naturalHeight] : null,
    rect: r ? [r.width, r.height] : null,
    cx: r ? (r.left + r.width/2) : null,
    cy: r ? (r.top + r.height/2) : null,
    aspect: r ? (r.width / r.height) : null,
    csWidth: cs ? cs.width : null,
    objFit: cs ? cs.objectFit : null,
    anim: cs ? cs.animationName + '/' + cs.animationDuration : null,
    minH: ccs ? ccs.minHeight : null,
    padL: ccs ? ccs.paddingLeft : null,
    padT: ccs ? ccs.paddingTop : null,
    txtBelow: txt && r ? (txt.getBoundingClientRect().top >= r.bottom) : null,
    gap: txt && r ? (txt.getBoundingClientRect().top - r.bottom) : null,
    vw: innerWidth, vh: innerHeight,
    hscroll: document.documentElement.scrollWidth > innerWidth,
    topGap: r ? r.top : null,
  });
})()"""

def cdp():
    out = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20).stdout
    url = out.strip().splitlines()[-1]
    if url.startswith("ws://"): url = "http://" + url[5:]
    elif url.startswith("wss://"): url = "https://" + url[6:]
    # keep scheme://host:port only (drop /devtools/... path)
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
    def drain(self, seconds):
        self.ws.settimeout(0.5); t0 = time.time()
        while time.time() - t0 < seconds:
            try: self.ws.recv()
            except Exception: pass
        self.ws.settimeout(30)

def main():
    ep = cdp()
    with urllib.request.urlopen(f"{ep}/json/list") as f: targets = json.load(f)
    page = next(t for t in targets if t.get("type") == "page")
    c = CDP(page["webSocketDebuggerUrl"])
    c.call("Runtime.enable"); c.call("Page.enable"); c.call("Network.enable"); c.call("Log.enable")
    errors = []
    # hold splash visible: long latency on every request keeps the session API pending
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 15000, "downloadThroughput": -1, "uploadThroughput": -1})
    c.call("Page.navigate", {"url": "http://localhost:3000/"})
    time.sleep(5)  # allow load; splash held by delayed session API
    splash = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    if not splash["present"]:
        print("SPLASH NOT VISIBLE — session API too fast. Aborting."); return
    print(f"splash visible: src={splash['src']} natural={splash['natural']} anim={splash['anim']} minH={splash['minH']}")

    print(f"\n{'viewport':<16}{'logo px':<14}{'%limit':<8}{'aspect':<8}{'center-dev':<12}{'src':<14}{'hscroll':<8}{'gap':<6}")
    rows = []
    for label, w, h, dpr, mob in VIEWPORTS:
        c.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mob})
        time.sleep(0.45)
        m = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
        if not m["present"]:
            print(f"{label:<16} SPLASH GONE"); continue
        lw, lh = m["rect"]
        pct = lw / min(m["vw"], m["vh"]) * 100
        dev = (m["cx"] - m["vw"]/2, m["cy"] - m["vh"]/2)
        flag = "" if abs(lw-lh) < 1 and not m["hscroll"] and abs(dev[0]) < 1 else "  <-- CHECK"
        rows.append((label, lw, lh, pct, m, dev, dpr))
        print(f"{label:<16}{lw:>6.1f}x{lh:<6.1f}{pct:>6.1f}%  {m['aspect']:<8.3f}({dev[0]:+.0f},{dev[1]:+.0f})   {m['src']:<14}{str(m['hscroll']):<8}{m['gap']:<6.1f}{flag}")
        if label in SHOTS:
            shot = c.call("Page.captureScreenshot", {"format": "png"})
            open(f"{OUT}/splash-{label.replace(' ', '-')}.png", "wb").write(base64.b64decode(shot["data"]))

    print("\nsharpness (device px needed vs 512 source):")
    for label, lw, lh, pct, m, dev, dpr in rows:
        need = lw * dpr
        print(f"  {label:<16} {lw:.0f}css x{dpr} = {need:.0f}px  {'OK' if need <= 512 else 'OVER'}")

    # reduced motion
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 15000, "downloadThroughput": -1, "uploadThroughput": -1})
    c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": "reduce"}]})
    c.call("Page.navigate", {"url": "http://localhost:3000/"}); time.sleep(4)
    rm = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    print(f"\nreduced-motion: anim={rm['anim']} (want none) present={rm['present']}")
    c.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-reduced-motion", "value": ""}]})

    # orientation live-rotate while splash visible: 390x844 -> 844x390 -> 390x844
    c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
    a = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    c.call("Emulation.setDeviceMetricsOverride", {"width": 844, "height": 390, "deviceScaleFactor": 3, "mobile": True})
    b = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    c.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True})
    d = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    print(f"rotate: P={a['rect'][0]:.0f}px L={b['rect'][0]:.0f}px P={d['rect'][0]:.0f}px (no reload; all present={a['present'] and b['present'] and d['present']})")

    # offline boot: SW precache must render the splash logo
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    c.call("Page.navigate", {"url": "http://localhost:3000/"}); time.sleep(4)
    sw = c.call("Runtime.evaluate", {"expression": "navigator.serviceWorker.getRegistrations().then(r=>r.length)", "awaitPromise": True})["result"]["value"]
    print(f"SW registrations: {sw}")
    c.call("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    c.call("Page.navigate", {"url": "http://localhost:3000/"}); time.sleep(4)
    off = json.loads(c.call("Runtime.evaluate", {"expression": MEASURE, "returnByValue": True})["result"]["value"])
    body = c.call("Runtime.evaluate", {"expression": "document.body.innerText.slice(0,120)"})["result"]["value"]
    shot = c.call("Page.captureScreenshot", {"format": "png"})
    open(f"{OUT}/splash-offline-boot.png", "wb").write(base64.b64decode(shot["data"]))
    print(f"offline boot: splashLogo={off['present']} natural={off['natural']} | page text: {body!r}")
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

if __name__ == "__main__":
    main()
