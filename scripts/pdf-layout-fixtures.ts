// MOHD.HMS ENTERPRISE — PDF layout QA fixtures + generator (temporary dev tool).
//
// Creates clearly-marked TEMP inspection reports (INS-TMP-*) in the sandbox DB
// with controlled photo counts / text lengths, uploads photo objects to the
// existing MinIO storage, then downloads PDFs through the LIVE central
// /api/v1/pdf/inspection-report/{id} endpoint (the real production path).
// Product code contains no hardcoded data — this is test tooling only.
//
// Usage: bun run scripts/pdf-layout-fixtures.ts [generate|cleanup] [before|after]

import { db } from "../src/lib/db";
import { Client as MinioClient } from "minio";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "fs";

// Direct MinIO client for FIXTURE uploads only (the QA script cannot import the
// app's storage service because of its server-only guard). Same authoritative
// object store, same key convention `irms/{reportId}/{photoId}-display.jpg`.
const mc = new MinioClient({
  endPoint: process.env.S3_ENDPOINT ?? "127.0.0.1",
  port: Number(process.env.S3_PORT ?? 3090),
  useSSL: (process.env.S3_USE_SSL ?? "false") === "true",
  accessKey: process.env.S3_ACCESS_KEY ?? "S3RVER",
  secretKey: process.env.S3_SECRET_KEY ?? "S3RVER",
});
const BUCKET = process.env.S3_BUCKET ?? "hms-files";
async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const exists = await mc.bucketExists(BUCKET).catch(() => false);
  if (!exists) await mc.makeBucket(BUCKET);
  await mc.putObject(BUCKET, key, body, body.length, { "Content-Type": contentType });
}
async function removeObject(key: string): Promise<void> {
  await mc.removeObject(BUCKET, key).catch(() => undefined);
}

const OUT = "/tmp/pdflayout";
mkdirSync(OUT, { recursive: true });

const MODE = process.argv[2] ?? "generate"; // generate | cleanup
const TAG = process.argv[3] ?? "before"; // pdf filename tag: before | after
const BASE = "http://localhost:3000";

type Scenario = {
  key: string;
  short: string;
  text: "short" | "medium" | "long";
  photos: { category: string; n: number }[];
  findings: number;
  recommendations: boolean;
};

const SCENARIOS: Scenario[] = [
  { key: "s0", short: "0 photos short text", text: "short", photos: [], findings: 0, recommendations: false },
  { key: "s1", short: "1 photo short text", text: "short", photos: [{ category: "BEFORE", n: 1 }], findings: 0, recommendations: false },
  { key: "s3", short: "3 photos medium text", text: "medium", photos: [{ category: "BEFORE", n: 3 }], findings: 2, recommendations: true },
  { key: "s6", short: "6 photos medium text", text: "medium", photos: [{ category: "BEFORE", n: 6 }], findings: 3, recommendations: true },
  { key: "s12", short: "12 photos long text", text: "long", photos: [{ category: "BEFORE", n: 6 }, { category: "DURING", n: 6 }], findings: 4, recommendations: true },
  { key: "s20", short: "21 photos long text", text: "long", photos: [{ category: "BEFORE", n: 8 }, { category: "DURING", n: 7 }, { category: "AFTER", n: 6 }], findings: 5, recommendations: true },
];

const TEXTS = {
  short: {
    taskDescription: "Door closing interval seems shorter than usual.",
    summary: "Unit operating within acceptable parameters.",
    recommendations: "",
    scope: "Quarterly inspection of the door system.",
    findings: ["Door closer tension slightly low", ""],
  },
  medium: {
    taskDescription:
      "The split AC in the master bedroom runs but the air is not cold. Started two days ago. There is also a slight water dripping sound from the indoor unit. Tenant reports the issue is worse during the afternoon.",
    summary:
      "This inspection documents the quarterly facility audit for the site. The overall condition of the inspected equipment was assessed as GOOD. No immediate operational concerns were identified that would require corrective action at this time. The facility continues to meet standard operational parameters.",
    recommendations: "Schedule coil cleaning within the next quarter. Monitor refrigerant pressure monthly.",
    scope: "Full inspection of the HVAC system including indoor and outdoor units, refrigerant lines and drainage.",
    findings: ["Refrigerant pressure slightly below spec", "Condensate drain partially clogged", "Air filter at 70% saturation"],
  },
  long: {
    taskDescription:
      "Comprehensive preventive maintenance inspection of the central chiller plant and associated AHUs serving levels 3 to 9. The building engineering team reported fluctuating supply air temperatures on several floors during peak occupancy hours over the past three weeks. Initial checks by the site technician indicated possible fouling of the condenser tubes and an unbalanced airflow distribution across the VAV network. This inspection covers the full mechanical, electrical and controls scope, including vibration analysis of rotating equipment, thermographic scan of MCC terminations, verification of BMS sensor calibration against reference instruments, and a complete operational walkthrough of the plant room, roof-mounted cooling towers and associated pumps.",
    summary:
      "The inspection identified moderate fouling on condenser tubes of chiller #2 consistent with the observed efficiency degradation. Supply air temperature fluctuation was traced to a miscalibrated discharge air sensor on AHU-5 and a partially blocked pre-filter bank on AHU-7. Water treatment levels in the cooling tower loop were within acceptable range but biocide dosing has drifted below the recommended residual. Vibration readings on all pumps were within ISO 10816 zone B. Thermographic scan identified one hot termination on MCC-3 feeder requiring re-torque. Overall the plant remains operational; corrective actions are recommended within the next planned shutdown window to restore full design efficiency and prevent progressive degradation of the affected components.",
    recommendations:
      "1. Chemical cleaning of chiller #2 condenser tubes during the next planned shutdown.\n2. Recalibrate the AHU-5 discharge air sensor and verify control loop response.\n3. Replace the pre-filter bank on AHU-7 and inspect the bag filters for premature loading.\n4. Re-torque the MCC-3 feeder termination and re-scan after 30 days.\n5. Restore biocide dosing to the contract residual and re-test loop water within two weeks.",
    scope: "Chillers, AHUs, pumps, cooling towers, MCCs, BMS sensors and ductwork distribution network across levels 3-9.",
    findings: [
      "Condenser approach temperature elevated by 2.8K on chiller #2 indicating tube fouling",
      "AHU-5 discharge air sensor reading 1.9C below reference instrument",
      "AHU-7 pre-filter bank heavily loaded, static pressure trending upward",
      "MCC-3 feeder L2 termination measured at 78C under load (limit 70C)",
      "Cooling tower biocide residual below contract minimum of 0.5 ppm",
    ],
  },
};

const CAPTION_WORDS = ["Corridor", "Plant room", "Roof deck", "Level 5 lobby", "AHU-5 closet", "Chiller bay 2", "Pump room", "Electrical riser", "Level 7 washroom", "Stairwell B", "Loading bay", "Tank top"];

async function makePhotoJpeg(seed: number, portrait: boolean): Promise<Buffer> {
  // Synthetic but realistic-looking facility photos (colour blocks), mixed
  // orientations to exercise aspect-ratio preservation.
  const w = portrait ? 900 : 1400;
  const h = portrait ? 1400 : 900;
  const base = ["#6b7d6a", "#7a6a5d", "#5d6a7a", "#6a7a5d", "#7a5d6a"][seed % 5];
  const svg = `<svg width="${w}" height="${h}"><rect width="100%" height="100%" fill="${base}"/>
    <rect x="${w * 0.1}" y="${h * 0.15}" width="${w * 0.35}" height="${h * 0.5}" fill="#cfd8cf"/>
    <rect x="${w * 0.55}" y="${h * 0.4}" width="${w * 0.3}" height="${h * 0.35}" fill="#2f3b2f"/>
    <circle cx="${w * 0.75}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.12}" fill="#e8e4d8"/>
    <text x="${w * 0.5}" y="${h * 0.92}" font-size="${Math.round(Math.min(w, h) * 0.08)}" fill="#ffffff" text-anchor="middle" font-family="sans-serif">PHOTO ${seed + 1}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

async function cleanup(): Promise<void> {
  const reports = await db.inspectionReport.findMany({ where: { code: { startsWith: "INS-TMP-" } }, select: { id: true } });
  for (const r of reports) {
    // Remove every object under the report's prefix (photo keys are synthetic
    // in fixtures, so prefix listing is the only reliable sweep).
    const objects: string[] = [];
    for await (const obj of mc.listObjects(BUCKET, `irms/${r.id}/`, true)) objects.push(obj.name);
    for (const key of objects) await removeObject(key);
    await db.inspectionPhoto.deleteMany({ where: { reportId: r.id } });
    await db.inspectionFinding.deleteMany({ where: { reportId: r.id } });
    await db.inspectionReport.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  console.log(`cleanup: removed ${reports.length} temp reports`);
  await db.$disconnect();
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@mohdhms.com", password: "Password@123" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

async function main(): Promise<void> {
  if (MODE === "cleanup") return cleanup();

  const project = await db.irmsProject.findFirst({ select: { id: true } });
  if (!project) throw new Error("No IRMS project in sandbox DB");

  const run = Date.now().toString(36).slice(-5);
  const created: { key: string; id: string }[] = [];

  for (const sc of SCENARIOS) {
    const t = TEXTS[sc.text];
    const rep = await db.inspectionReport.create({
      data: {
        code: `INS-TMP-${run}-${sc.key}`,
        projectId: project.id,
        title: `Layout QA — ${sc.short}`,
        type: "ROUTINE",
        inspectionDate: new Date(),
        status: "APPROVED",
        customerVisible: true,
        summary: t.summary,
        taskDescription: t.taskDescription,
        scope: t.scope,
        recommendations: sc.recommendations ? t.recommendations : "",
        correctiveActions: sc.text === "long" ? "Cleaned strainers, re-torqued the identified termination and restored dosing setpoints." : "",
        notes: sc.text === "long" ? "Follow-up verification scheduled after the shutdown window." : "",
        labourHours: 6.5,
        completionPercent: 100,
        findings: {
          create: t.findings.slice(0, sc.findings).map((f, i) => ({ finding: f, severity: ["LOW", "MEDIUM", "HIGH"][i % 3], recommendation: sc.text === "short" ? "Monitor" : `Corrective action ${i + 1}: schedule and verify.` })),
        },
      },
    });
    created.push({ key: sc.key, id: rep.id });

    let seq = 0;
    for (const grp of sc.photos) {
      for (let i = 0; i < grp.n; i++) {
        const portrait = seq % 2 === 1; // mixed orientations
        const jpg = await makePhotoJpeg(seq, portrait);
        const prefix = { BEFORE: "B", DURING: "D", AFTER: "A" }[grp.category] ?? "P";
        const photoId = `ph${run}${sc.key}${String(seq).padStart(3, "0")}`; // stable key component
        const photo = await db.inspectionPhoto.create({
          data: {
            reportId: rep.id,
            category: grp.category,
            photoNo: `${prefix}${String(i + 1).padStart(3, "0")}`,
            sortOrder: i,
            caption: `${CAPTION_WORDS[seq % CAPTION_WORDS.length]} — unit ${seq + 1} general view`,
            room: `Rm ${100 + (seq % 12)}`,
            building: "Block A",
            storagePath: `irms/${rep.id}/${photoId}-original.jpg`,
            displayPath: `irms/${rep.id}/${photoId}-display.jpg`,
            width: portrait ? 900 : 1400,
            height: portrait ? 1400 : 900,
            mimeType: "image/jpeg",
          },
        });
        await putObject(`irms/${rep.id}/${photoId}-display.jpg`, jpg, "image/jpeg");
        seq++;
      }
    }
  }

  // Download PDFs through the LIVE central pipeline (real auth, branding, QR).
  const cookie = await login();
  for (const { key, id } of created) {
    const res = await fetch(`${BASE}/api/v1/pdf/inspection-report/${id}`, { headers: { cookie }, redirect: "manual" });
    if (!res.ok) {
      console.error(`${key}: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(`${OUT}/${TAG}-${key}.pdf`, buf);
    console.log(`${key}: ${(res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1]} pages+bytes=${buf.length}`);
  }

  console.log("created:", created.map((c) => `${c.key}=${c.id}`).join(" "));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
