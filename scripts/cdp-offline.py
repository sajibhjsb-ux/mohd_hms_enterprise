#!/usr/bin/env python3
"""Toggle Chrome network emulation (offline/online) via the CDP endpoint."""
import json, sys, urllib.request

def cdp_url():
    out = subprocess_run(["agent-browser", "get", "cdp-url"])
    url = out.strip().splitlines()[-1]
    if url.startswith("ws://"):
        url = "http://" + url[5:]
    elif url.startswith("wss://"):
        url = "https://" + url[6:]
    return url.rstrip("/")

def subprocess_run(args):
    import subprocess
    r = subprocess.run(args, capture_output=True, text=True, timeout=20)
    return r.stdout

def ws_call():
    import websocket  # websocket-client
    raise SystemExit("unused")

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "status"
    endpoint = cdp_url()  # e.g. http://127.0.0.1:PORT
    # Discover the page target
    with urllib.request.urlopen(f"{endpoint}/json/list") as f:
        targets = json.load(f)
    page = next((t for t in targets if t.get("type") == "page"), None)
    if not page:
        print("no page target"); sys.exit(1)
    ws_url = page["webSocketDebuggerUrl"]

    import json as j
    from websocket import create_connection
    ws = create_connection(ws_url, timeout=15)
    offline = mode == "offline"
    ws.send(j.dumps({
        "id": 1, "method": "Network.emulateNetworkConditions",
        "params": {"offline": offline, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1},
    }))
    result = {}
    for _ in range(10):
        msg = j.loads(ws.recv())
        if msg.get("id") == 1:
            result = msg
            break
    print(f"network {'OFFLINE' if offline else 'ONLINE'} -> {result.get('result', result)}")
    ws.close()

if __name__ == "__main__":
    main()
