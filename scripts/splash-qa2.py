#!/usr/bin/env python3
"""Focused checks: (1) splash visible during OFFLINE boot with logo from SW precache; (2) full computed styles."""
import json, subprocess, time, urllib.request
from urllib.parse import urlsplit
from websocket import create_connection

def cdp():
    out = subprocess.run(["agent-browser", "get", "cdp-url"], capture_output=True, text=True, timeout=20).stdout
    url = out.strip().splitlines()[-1]
    if url.startswith("ws://"): url = "http://" + url[5:]
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"

class CDP:
    def __init__(self, ws_url):
        self.ws = create_connection(ws_url, timeout=30, suppress_origin=True); self.i = 0
    def call(self, method, params=None):
        self.i += 1; self.ws.send(json.dumps({"id": self.i, "method": method, "params": params or {}}))
        t0 = time.time()
        while time.time() - t0 < 30:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.i: return msg.get("result", {})
        raise TimeoutError(method)

PROBE = """(() => {
  const cont = document.querySelector('.splash-viewport');
  if (!cont) return JSON.stringify({splash: false, text: document.body.innerText.slice(0,60)});
  const img = cont.querySelector('img');
  const cs = getComputedStyle(img); const ccs = getComputedStyle(cont);
  return JSON.stringify({splash: true, natural: img.naturalWidth, src: img.currentSrc, rect: [img.getBoundingClientRect().width, img.getBoundingClientRect().height],
    csWidth: cs.width, objFit: cs.objectFit, aspect: cs.aspectRatio, minH: ccs.minHeight, padL: ccs.paddingLeft, padT: ccs.paddingTop, alt: img.alt, role: cont.querySelector('p').getAttribute('role')});
})()"""

def main():
    ep = cdp()
    with urllib.request.urlopen(f"{ep}/json/list") as f: page = next(t for t in json.load(f) if t.get("type") == "page")
    c = CDP(page["webSocketDebuggerUrl"])
    c.call("Runtime.enable"); c.call("Page.enable"); c.call("Network.enable")

    # 1) OFFLINE boot: poll for the splash during boot
    c.call("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    c.call("Page.navigate", {"url": "http://localhost:3000/"})
    seen = None
    for _ in range(40):
        time.sleep(0.25)
        r = json.loads(c.call("Runtime.evaluate", {"expression": PROBE, "returnByValue": True})["result"]["value"])
        if r.get("splash"):
            seen = r; break
    print("OFFLINE splash:", json.dumps(seen, indent=1) if seen else "NOT OBSERVED (boot too fast)")
    c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    time.sleep(1)

    # 2) ONLINE full computed styles at phone/tablet/desktop
    for w, h, dpr, mob in [(390, 844, 3, True), (820, 1180, 2, True), (1920, 1080, 1, False)]:
        c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 8000, "downloadThroughput": -1, "uploadThroughput": -1})
        c.call("Emulation.setDeviceMetricsOverride", {"width": w, "height": h, "deviceScaleFactor": dpr, "mobile": mob})
        c.call("Page.navigate", {"url": "http://localhost:3000/"})
        for _ in range(30):
            time.sleep(0.3)
            r = json.loads(c.call("Runtime.evaluate", {"expression": PROBE, "returnByValue": True})["result"]["value"])
            if r.get("splash"): break
        print(f"ONLINE {w}x{h}:", json.dumps(r, indent=1))
        c.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

if __name__ == "__main__":
    main()
