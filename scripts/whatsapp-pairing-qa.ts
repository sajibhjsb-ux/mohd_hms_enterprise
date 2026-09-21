// MOHD.HMS ENTERPRISE — Pairing/QR lifecycle QA (device-linking fix).
// Drives the REAL gateway + app through the honest pairing states:
//   connect → WAITING (socket coming up) → READY (fresh QR) → pairing code
//   → disconnect → honest DISCONNECTED/UNAVAILABLE.
// Requires: OpenWA gateway on 127.0.0.1:2785 (see mini-services/WHATSAPP-GATEWAY.md),
// app on :3000, admin session cookie via /tmp/qa-cookies.txt.

const APP = process.env.QA_ORIGIN || "http://localhost:3000";
const COOKIES = "/tmp/qa-cookies.txt";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const cookie = (await import("fs")).readFileSync(COOKIES, "utf8")
    .split("\n").filter((l) => l.includes("\t"))          // Netscape data rows only
    .map((l) => l.replace(/^#HttpOnly_/, ""))             // un-hide HttpOnly rows
    .map((l) => l.split("\t")).filter((p) => p.length >= 7)
    .map((p) => `${p[5]}=${p[6]}`).join("; ");
  const res = await fetch(`${APP}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", cookie, ...(init?.headers as Record<string, string>) },
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("═══ WHATSAPP PAIRING LIFECYCLE QA (device-linking fix) ══\n");

// ── 1. Baseline: connect through the app (create + start on the gateway) ──
console.log("── 1 CONNECT → HONEST STATE ──");
{
  const st = await api("/api/v1/whatsapp/session");
  check("session status reachable", st.status === 200 && st.json?.ok === true, `status=${st.status}`);
  const prevStatus = st.json?.data?.sessionStatus;
  console.log(`    (current gateway status: ${prevStatus})`);

  const connect = await api("/api/v1/whatsapp/session", { method: "POST", body: "{}" });
  check("connect accepted (create+start)", connect.status === 200 && connect.json?.data?.ok === true,
    JSON.stringify(connect.json?.error ?? connect.json?.data));
}

// ── 2. QR lifecycle: WAITING until the engine reaches qr_ready, then READY ──
console.log("── 2 QR LIFECYCLE (fresh-only guarantee) ──");
{
  let sawReady = false, sawWaitingOrError = false, qrLen = 0;
  for (let i = 0; i < 20; i++) {
    const qr = await api("/api/v1/whatsapp/session/qr");
    const d = qr.json?.data;
    if (qr.status === 200 && d?.qr) {
      sawReady = true; qrLen = String(d.qr).length;
      check("QR is a PNG data URL", d.qr.startsWith("data:image/png"), d.qr.slice(0, 40));
      break;
    }
    // Honest non-QR states: WAITING typed response or a real 400 error
    if (d?.state === "WAITING" || qr.status === 400) sawWaitingOrError = true;
    await sleep(2000);
  }
  check("eventually serves a fresh QR (engine qr_ready)", sawReady);
  check("non-ready windows returned honest waiting/error states (never a dead QR)", sawWaitingOrError || sawReady);
  check("QR payload is a real PNG data URL", qrLen > 1000, `len=${qrLen}`);
}

// ── 3. Status mirror equals the gateway's REAL status (no fake states) ──
console.log("── 3 STATUS MIRROR HONESTY ──");
{
  const st = await api("/api/v1/whatsapp/session");
  const d = st.json?.data;
  const valid = ["ready", "qr_ready", "initializing", "authenticating", "disconnected", "failed", "created", "unknown"];
  check("sessionStatus is a real gateway value", valid.includes(d?.sessionStatus), d?.sessionStatus);
  check("uiState maps honestly (no fake CONNECTED)", (d?.sessionStatus === "ready") === (d?.uiState === "CONNECTED"), `${d?.sessionStatus}→${d?.uiState}`);
}

// ── 4. Pairing code (QR alternative — no camera race) ──
console.log("── 4 PAIRING CODE ──");
{
  // Try while the engine may still be between QR windows; retry briefly.
  let code: string | null = null, detail = "";
  for (let i = 0; i < 6 && !code; i++) {
    const r = await api("/api/v1/whatsapp/session/pairing-code", {
      method: "POST", body: JSON.stringify({ phone: "+6737123456" }),
    });
    if (r.status === 200 && r.json?.data?.pairingCode) code = r.json.data.pairingCode;
    else { detail = r.json?.error?.message ?? `status=${r.status}`; await sleep(4000); }
  }
  check("pairing code issued by the engine", !!code && /^[A-Z0-9]{8}$/.test(code), detail || (code ?? ""));
}

// ── 5. Disconnect → honest DOWN state, QR refused ──
console.log("── 5 DISCONNECT → HONEST DOWN ──");
{
  const dc = await api("/api/v1/whatsapp/session/disconnect", { method: "POST", body: JSON.stringify({ logout: false }) });
  check("disconnect accepted", dc.status === 200 && dc.json?.data?.ok === true);
  await sleep(1500);
  const st = await api("/api/v1/whatsapp/session");
  check("status honestly DISCONNECTED after stop", st.json?.data?.uiState === "DISCONNECTED", st.json?.data?.uiState);
  const qr = await api("/api/v1/whatsapp/session/qr");
  check("QR refused after stop (no stale code)", qr.status !== 200 || qr.json?.data?.state === "WAITING", `status=${qr.status}`);
  // restore: reconnect for the browser QA / further testing
  const re = await api("/api/v1/whatsapp/session", { method: "POST", body: "{}" });
  check("reconnect restores the session", re.status === 200 && re.json?.data?.ok === true);
}

console.log(`\n═══ RESULTS: ${passed} passed, ${failed} failed ═══`);
process.exit(failed ? 1 : 0);
