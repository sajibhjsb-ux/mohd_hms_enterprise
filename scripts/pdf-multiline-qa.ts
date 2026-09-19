/**
 * PDF multiline-address regression QA (Task 27).
 *
 * 1. saves ONE/TWO/THREE/LONG-line addresses through the real settings API
 * 2. verifies the exact value round-trips (newlines preserved, no silent strip)
 * 3. generates ALL 9 registered document types through the real PDF endpoint
 * 4. asserts HTTP 200 + application/pdf + %PDF magic + parseable via pdftotext
 * 5. asserts BOTH address lines appear in the extracted PDF text
 * 6. restores the original address and verifies restoration
 *
 * Run: bun scripts/pdf-multiline-qa.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const OUT = "/home/z/tmp-verify/pdfqa";
const EMAIL = "admin@mohdhms.com";
const PASSWORD = "Password@123";

const DOC_TYPES: { type: string; model: keyof typeof db }[] = [
  { type: "work-order", model: "workOrder" },
  { type: "complaint", model: "complaint" },
  { type: "inspection-report", model: "inspectionReport" },
  { type: "quotation", model: "quotation" },
  { type: "invoice", model: "invoice" },
  { type: "purchase-order", model: "purchaseOrder" },
  { type: "equipment-report", model: "equipment" },
  { type: "pm-task", model: "pmTask" },
  { type: "payment-receipt", model: "payment" },
];

const ADDRESSES: Record<string, string> = {
  "T1-one-line": "No. 1, Simpang 124-122-60, Kampung Selayun Tagap B",
  "T2-two-line": "No. 1, Simpang 124-122-60, Kampung Selayun Tagap B,\nBandar Seri Begawan, Negara Brunei Darussalam.",
  "T3-three-line": "No. 1, Simpang 124-122-60, Kampung Selayun Tagap B,\nBandar Seri Begawan,\nNegara Brunei Darussalam.",
  "T4-long-four-line": "Unit No. 7, Ground Floor, Bangunan Hj. Md. Salleh Bin Hj. Metussin,\nNo. 1, Simpang 124-122-60, Kampung Selayun Tagap B, Mukim Gadong 'A',\nBandar Seri Begawan BA2311, Negara Brunei Darussalam,\nAttn: Property Management Office (24-hour security desk).",
};

let cookie = "";
let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* binary */
  }
  return { res, json, text };
}

async function pdfText(buf: Buffer): Promise<string> {
  // piping binary stdin is unreliable here — go via a temp file
  const tmp = `${OUT}/_extract.pdf`;
  writeFileSync(tmp, buf);
  const proc = spawnSync("pdftotext", [tmp, "-"], { encoding: "utf8" });
  return proc.stdout ?? "";
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ── login ────────────────────────────────────────────────────────────
  const login = await api("POST", "/api/v1/auth/login", { email: EMAIL, password: PASSWORD });
  check("login", login.res.status === 200 && cookie.includes("hms_session"), `status ${login.res.status}`);
  if (login.res.status !== 200) process.exit(1);

  // ── remember original address ────────────────────────────────────────
  const s0 = await api("GET", "/api/v1/settings");
  const original: string = s0.json?.data?.company_address ?? "";
  console.log(`original address: ${JSON.stringify(original).slice(0, 80)}\n`);

  // ── ids for every document type ──────────────────────────────────────
  const ids: Record<string, string | null> = {};
  for (const { type, model } of DOC_TYPES) {
    try {
      const row = await (db[model] as any).findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
      ids[type] = row?.id ?? null;
    } catch {
      ids[type] = null;
    }
  }
  console.log("record ids:", Object.entries(ids).map(([t, id]) => `${t}=${id ? id.slice(0, 8) : "NONE"}`).join(" "), "\n");

  // ── per-address full pipeline ────────────────────────────────────────
  for (const [label, addr] of Object.entries(ADDRESSES)) {
    console.log(`── ${label} (${addr.split("\n").length} line(s)) ──`);

    const put = await api("PUT", "/api/v1/settings", { values: { company_address: addr } });
    check("settings PUT 200", put.res.status === 200, `status ${put.res.status}`);

    const get = await api("GET", "/api/v1/settings");
    const stored: string = get.json?.data?.company_address ?? "";
    check("address round-trips exactly (newlines preserved)", stored === addr, JSON.stringify(stored.slice(0, 60)));

    for (const { type } of DOC_TYPES) {
      const id = ids[type];
      if (!id) {
        console.log(`    · ${type}: no record in DB — skipped`);
        continue;
      }
      const r = await fetch(`${BASE}/api/v1/pdf/${type}/${id}`, { headers: { cookie } });
      const buf = Buffer.from(await r.arrayBuffer());
      const okStatus = r.status === 200;
      const okType = (r.headers.get("content-type") || "").includes("application/pdf");
      const okMagic = buf.subarray(0, 5).toString() === "%PDF-";
      const okSize = buf.length > 1500;
      check(`pdf ${type}`, okStatus && okType && okMagic && okSize, `${r.status} ${(r.headers.get("content-type") || "?")} ${buf.length}B`);
      if (okMagic) {
        writeFileSync(`${OUT}/${label}-${type}.pdf`, buf);
        if (type === "quotation" || type === "invoice" || type === "work-order") {
          const txt = await pdfText(buf);
          const lines = addr.split("\n").map((l) => l.trim()).filter(Boolean);
          const all = lines.every((l) => txt.includes(l.slice(0, Math.min(l.length, 40))));
          check(`  extracted text contains every address line (${lines.length})`, all);
        }
      }
    }
    console.log("");
  }

  // ── special characters sanity (same pipeline, quotation only) ────────
  console.log("── special characters (quotation) ──");
  const special = "No. 1, Simpang 124-122-60 (Kampung Selayun), 'Sedap Corner' Café & Grille — Block B;\nBandar Seri Begawan.";
  await api("PUT", "/api/v1/settings", { values: { company_address: special } });
  const qid = ids["quotation"];
  if (qid) {
    const r = await fetch(`${BASE}/api/v1/pdf/quotation/${qid}`, { headers: { cookie } });
    const buf = Buffer.from(await r.arrayBuffer());
    check("pdf quotation with , . - / ' ( ) & — é", r.status === 200 && buf.subarray(0, 5).toString() === "%PDF-", `${r.status} ${buf.length}B`);
    writeFileSync(`${OUT}/T5-special-chars-quotation.pdf`, buf);
  }

  // ── restore original address ─────────────────────────────────────────
  const put2 = await api("PUT", "/api/v1/settings", { values: { company_address: original } });
  const get2 = await api("GET", "/api/v1/settings");
  check("original address restored", put2.res.status === 200 && get2.json?.data?.company_address === original);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("QA SCRIPT ERROR:", e?.message ?? e);
  process.exit(1);
});
