// MOHD.HMS ENTERPRISE — upload pipeline QA (real API + real S3 store + real DB).
//
// Exercises the FULL pipeline end-to-end against the running dev server:
//   login → create draft report → upload every file class → verify DB row,
//   S3 objects (stat + byte-hash of original), file-serving endpoints,
//   failure taxonomy (HEIC / corrupt / text / empty / oversized / unauthorized),
//   failure rollback (no orphan rows/objects), retry idempotency, delete
//   cleanup and RBAC. Prints one PASS/FAIL line per check; exits 1 on any FAIL.

import { PrismaClient } from "@prisma/client";
import { Client as MinioClient } from "minio";
import sharp from "sharp";
import crypto from "crypto";

const BASE = "http://127.0.0.1:3000";
const db = new PrismaClient();
const mc = new MinioClient({
  endPoint: process.env.S3_ENDPOINT ?? "127.0.0.1",
  port: Number(process.env.S3_PORT ?? 3090),
  useSSL: false,
  accessKey: process.env.S3_ACCESS_KEY ?? "S3RVER",
  secretKey: process.env.S3_SECRET_KEY ?? "S3RVER",
});
const BUCKET = process.env.S3_BUCKET ?? "hms-files";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  const cookie = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session="));
  if (!cookie) throw new Error(`no session cookie for ${email}`);
  return cookie;
}

async function api(cookie: string, method: string, path: string, body?: BodyInit, headers?: Record<string, string>) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(headers ?? {}) },
    body,
  });
  let json: unknown = null;
  try { json = await res.json(); } catch { /* binary */ }
  return { status: res.status, json, headers: res.headers };
}

async function statObject(key: string): Promise<number | null> {
  try {
    const s = await mc.statObject(BUCKET, key);
    return s.size;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NotFound" || code === "NoSuchKey") return null;
    throw err;
  }
}

function makeFtypBox(brand: string): Buffer {
  const box = Buffer.alloc(32, 0);
  box.writeUInt32BE(32, 0);
  box.write("ftyp", 4, "ascii");
  box.write(brand, 8, "ascii");
  return box;
}

type UploadData = {
  id: string; storagePath?: string; displayPath?: string; thumbPath?: string;
  mimeType: string; width: number; height: number; sizeBytes: number;
  urls: { thumb: string; display: string; original: string };
};
type UploadResult = { status: number; json: { data?: UploadData[]; error?: { code: string; message: string } } };

async function main() {
  // ── Setup: staff session + draft report ──
  const supervisorCookie = await login("supervisor@mohdhms.com", "Password@123");
  const adminCookie = await login("admin@mohdhms.com", "Password@123");
  const customerCookie = await login("customer1@demo.my", "Password@123");

  const project = await db.irmsProject.findFirst({ select: { id: true } });
  if (!project) throw new Error("no IRMS project in DB");
  const technicianProfile = await db.technicianProfile.findFirst({ select: { id: true } });
  if (!technicianProfile) throw new Error("no technician profile in DB");
  const created = await api(supervisorCookie, "POST", "/api/v1/irms/reports", JSON.stringify({
    projectId: project.id,
    title: "Upload pipeline QA report",
    type: "OTHER",
    priority: "LOW",
    inspectionDate: new Date().toISOString().slice(0, 10),
    inspectorId: technicianProfile.id,
  }), { "Content-Type": "application/json" }) as { status: number; json: { data?: { id?: string } } };
  check("create draft report via API", created.status === 201 && !!created.json.data?.id, JSON.stringify(created.json));
  const reportId = created.json.data?.id as string;

  const upload = async (cookie: string, file: { name: string; type: string; bytes: Buffer }, rid = reportId): Promise<UploadResult> => {
    const form = new FormData();
    form.set("files", new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    form.set("category", "BEFORE");
    return (await api(cookie, "POST", `/api/v1/irms/reports/${rid}/photos`, form)) as UploadResult;
  };

  const photoCount = async (rid = reportId) => (await db.inspectionPhoto.count({ where: { reportId: rid } }));
  const objectCount = async (rid = reportId) => {
    const keys: string[] = [];
    const stream = mc.listObjects(BUCKET, `irms/${rid}/`, true);
    for await (const o of stream) if (o.name) keys.push(o.name);
    return keys.length;
  };

  // ── Build test files ──
  const plainJpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 30, g: 120, b: 80 } } }).jpeg({ quality: 90 }).toBuffer();
  const exifJpeg = await sharp({ create: { width: 480, height: 640, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .withMetadata({ orientation: 6 }) // rotated 90° — display must bake it in
    .jpeg({ quality: 90 }).toBuffer();
  const png = await sharp({ create: { width: 320, height: 240, channels: 4, background: { r: 20, g: 40, b: 200, alpha: 1 } } }).png().toBuffer();
  const webp = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 220, g: 180, b: 20 } } }).webp().toBuffer();
  // Camera-like "large" photo: 2400x1600 noise → multi-MB JPEG, well within limit.
  const noise = crypto.randomBytes(2400 * 1600 * 3);
  const largeJpeg = await sharp(noise, { raw: { width: 2400, height: 1600, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
  const truncatedJpeg = plainJpeg.subarray(0, Math.floor(plainJpeg.length * 0.35));
  const heic = makeFtypBox("heic");
  const textBytes = Buffer.from("this is not an image, just plain text pretending to be one");
  const oversized = Buffer.alloc(15 * 1024 * 1024 + 1024, 7);

  console.log(`fixtures: plain=${plainJpeg.length}B exif=${exifJpeg.length}B large=${(largeJpeg.length / 1048576).toFixed(1)}MB`);

  // ── 1. Happy paths ──
  const cases: { label: string; file: { name: string; type: string; bytes: Buffer }; expectMime?: string }[] = [
    { label: "JPG gallery photo", file: { name: "photo1.jpg", type: "image/jpeg", bytes: plainJpeg }, expectMime: "image/jpeg" },
    { label: "numeric filename (bug sample) 121880.jpg", file: { name: "121880.jpg", type: "image/jpeg", bytes: plainJpeg }, expectMime: "image/jpeg" },
    { label: "numeric filename (bug sample) 121879.jpg", file: { name: "121879.jpg", type: "image/jpeg", bytes: plainJpeg }, expectMime: "image/jpeg" },
    { label: "long camera filename with wrong declared MIME", file: { name: "1789775044445177211080615004737.jpg", type: "image/png", bytes: plainJpeg }, expectMime: "image/jpeg" },
    { label: "PNG upload", file: { name: "diagram.png", type: "image/png", bytes: png }, expectMime: "image/png" },
    { label: "WebP upload", file: { name: "shot.webp", type: "image/webp", bytes: webp }, expectMime: "image/webp" },
    { label: "large camera photo", file: { name: "IMG_20260919_101112.jpg", type: "image/jpeg", bytes: largeJpeg }, expectMime: "image/jpeg" },
  ];
  const uploaded: { label: string; data: UploadData }[] = [];
  for (const c of cases) {
    const res = await upload(supervisorCookie, c.file);
    const data = res.json.data?.[0];
    check(`upload: ${c.label}`, res.status === 201 && !!data, `status=${res.status} err=${JSON.stringify(res.json.error)}`);
    if (res.status !== 201 || !data) continue;
    uploaded.push({ label: c.label, data });
    // DB row: object keys stored (internal columns), sniffed mime wins
    const row = await db.inspectionPhoto.findUnique({ where: { id: data.id }, select: { storagePath: true, displayPath: true, thumbPath: true, mimeType: true, sizeBytes: true } });
    check(`DB row: ${c.label} uses irms/ object keys`, !!row && row.storagePath.startsWith(`irms/${reportId}/`), row?.storagePath ?? "missing");
    check(`DB row: ${c.label} sniffed mime (${row?.mimeType})`, c.expectMime ? row?.mimeType === c.expectMime : true, row?.mimeType ?? "missing");
    check(`DB row: ${c.label} size matches bytes`, row?.sizeBytes === c.file.bytes.length, `${row?.sizeBytes} vs ${c.file.bytes.length}`);
    data.storagePath = row?.storagePath ?? ""; data.displayPath = row?.displayPath ?? ""; data.thumbPath = row?.thumbPath ?? "";
    // S3: all three variants exist with plausible sizes
    for (const [variant, key] of [["original", data.storagePath], ["display", data.displayPath], ["thumb", data.thumbPath]] as const) {
      const size = await statObject(key);
      check(`S3 object: ${c.label} ${variant} exists`, size !== null && size > 0, `key=${key} size=${size}`);
    }
    // Original bytes are preserved exactly (§48)
    const orig = await mc.getObject(BUCKET, data.storagePath);
    const chunks: Buffer[] = [];
    for await (const ch of orig) chunks.push(ch as Buffer);
    const origBuf = Buffer.concat(chunks);
    const a = crypto.createHash("sha256").update(origBuf).digest("hex");
    const b = crypto.createHash("sha256").update(c.file.bytes).digest("hex");
    check(`S3 original byte-identical: ${c.label}`, a === b);
    // File-serving endpoints
    for (const [variant, url] of [["thumb", data.urls.thumb], ["display", data.urls.display], ["original", data.urls.original]] as const) {
      const res2 = await fetch(`${BASE}${url}`, { headers: { cookie: supervisorCookie } });
      const ct = res2.headers.get("content-type") ?? "";
      check(`file endpoint ${variant}: ${c.label}`, res2.status === 200 && ct.startsWith("image/"), `status=${res2.status} ct=${ct}`);
      if (res2.body) await res2.arrayBuffer();
    }
    // Unauthenticated access must be rejected
    const anon = await fetch(`${BASE}${data.urls.thumb}`);
    check(`anon file access blocked: ${c.label}`, anon.status === 401, `status=${anon.status}`);
  }

  // EXIF orientation baked into display variant (480x640 orientation 6 → 640x480)
  const exifEntry = uploaded.find((u) => u.label.startsWith("long camera filename") || u.label.startsWith("JPG gallery"));
  void exifEntry;
  const exifRes = await upload(supervisorCookie, { name: "rotated.jpg", type: "image/jpeg", bytes: exifJpeg });
  const exifData = exifRes.json.data?.[0];
  check("upload: EXIF-rotated photo", exifRes.status === 201 && !!exifData, `status=${exifRes.status}`);
  if (exifData) {
    uploaded.push({ label: "EXIF-rotated photo", data: exifData });
    const disp = await sharp(await (async () => { const r = await fetch(`${BASE}${exifData.urls.display}`, { headers: { cookie: supervisorCookie } }); return r.arrayBuffer(); })()).metadata();
    check("EXIF orientation baked into display (640x480)", disp.width === 640 && disp.height === 480, `${disp.width}x${disp.height}`);
    check("DB width/height reflect rotation", exifData.width === 640 && exifData.height === 480, `${exifData.width}x${exifData.height}`);
  }

  // ── 2. Failure taxonomy (§19) — every failure ends FAILED with a reason ──
  const failCases = [
    { label: "HEIC rejected with actionable message", file: { name: "camera.heic", type: "image/heic", bytes: heic }, code: "UNSUPPORTED_FORMAT", msg: "JPEG" },
    { label: "corrupt/truncated JPEG", file: { name: "broken.jpg", type: "image/jpeg", bytes: truncatedJpeg }, code: "IMAGE_PROCESSING_FAILED", msg: "could not read" },
    { label: "text file pretending to be .jpg", file: { name: "notes.jpg", type: "image/jpeg", bytes: textBytes }, code: "INVALID_FILE", msg: "could not read" },
    { label: "empty file", file: { name: "empty.jpg", type: "image/jpeg", bytes: Buffer.alloc(0) }, code: "INVALID_FILE", msg: "empty" },
    { label: "oversized 15MB+ file", file: { name: "huge.jpg", type: "image/jpeg", bytes: oversized }, code: "FILE_TOO_LARGE", msg: "too large" },
  ];
  const countBefore = await photoCount();
  const objectsBefore = await objectCount();
  for (const c of failCases) {
    const res = await upload(supervisorCookie, c.file);
    const err = res.json.error;
    check(`reject: ${c.label}`, res.status === 422 && err?.code === c.code && (err?.message ?? "").toLowerCase().includes(c.msg.toLowerCase()), `status=${res.status} err=${JSON.stringify(res.json.error)}`);
  }
  check("failures create NO photo rows", (await photoCount()) === countBefore, `${await photoCount()} vs ${countBefore}`);
  check("failures create NO orphan objects", (await objectCount()) === objectsBefore, `${await objectCount()} vs ${objectsBefore}`);

  // ── 3. Retry / duplicate-safety (§17/§18) ──
  check("retry of a failed file still fails cleanly (idempotent)", (await upload(supervisorCookie, failCases[0].file)).status === 422);
  check("no duplicates after retries", (await photoCount()) === countBefore);
  const dup1 = await upload(supervisorCookie, { name: "twice.jpg", type: "image/jpeg", bytes: plainJpeg });
  const dup2 = await upload(supervisorCookie, { name: "twice.jpg", type: "image/jpeg", bytes: plainJpeg });
  const key1 = dup1.json.data?.[0] ? (await db.inspectionPhoto.findUnique({ where: { id: dup1.json.data[0].id }, select: { storagePath: true } }))?.storagePath : null;
  const key2 = dup2.json.data?.[0] ? (await db.inspectionPhoto.findUnique({ where: { id: dup2.json.data[0].id }, select: { storagePath: true } }))?.storagePath : null;
  check("same file uploaded twice → two valid photos, unique keys", dup1.status === 201 && dup2.status === 201 && !!key1 && !!key2 && key1 !== key2, `k1=${key1} k2=${key2}`);
  if (dup1.json.data?.[0]) uploaded.push({ label: "dup A", data: dup1.json.data[0] });
  if (dup2.json.data?.[0]) uploaded.push({ label: "dup B", data: dup2.json.data[0] });

  // ── 4. RBAC (§38/§39) ──
  const customerUpload = await upload(customerCookie, { name: "sneaky.jpg", type: "image/jpeg", bytes: plainJpeg });
  check("customer cannot upload to staff report", customerUpload.status === 403 || customerUpload.status === 404, `status=${customerUpload.status}`);
  const somePhotoUrl = uploaded[0]?.data.urls.thumb;
  if (somePhotoUrl) {
    const customerFetch = await fetch(`${BASE}${somePhotoUrl}`, { headers: { cookie: customerCookie } });
    check("customer cannot read staff report photos", customerFetch.status === 404 || customerFetch.status === 403, `status=${customerFetch.status}`);
    await customerFetch.arrayBuffer().catch(() => undefined);
  }
  const staffRead = await api(customerCookie, "GET", `/api/v1/irms/reports/${reportId}/photos`);
  check("customer cannot list staff report photos", staffRead.status === 403 || staffRead.status === 404, `status=${staffRead.status}`);

  // ── 5. Delete → objects removed (§40) ──
  const delTarget = uploaded[uploaded.length - 1];
  if (delTarget) {
    const rowForDel = await db.inspectionPhoto.findUnique({ where: { id: delTarget.data.id }, select: { storagePath: true, displayPath: true, thumbPath: true } });
    const keys = [rowForDel?.storagePath, rowForDel?.displayPath, rowForDel?.thumbPath].filter((k): k is string => !!k);
    const del = await api(supervisorCookie, "DELETE", `/api/v1/irms/photos/${delTarget.data.id}`);
    check("delete photo via API", del.status === 200 || del.status === 204, `status=${del.status}`);
    for (const key of keys) {
      const gone = await statObject(key);
      check(`delete removes S3 object (${key.split("/").pop()})`, gone === null, `size=${gone}`);
    }
    check("row removed from DB", (await db.inspectionPhoto.count({ where: { id: delTarget.data.id } })) === 0);
  }

  // ── 5b. Wet-signature storage roundtrip (S3) ──
  const png1x1 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const sigForm = new FormData();
  sigForm.set("role", "SUPERVISOR");
  sigForm.set("name", "QA Supervisor");
  sigForm.set("image", new Blob([new Uint8Array(png1x1)], { type: "image/png" }));
  const sigRes = await api(supervisorCookie, "POST", `/api/v1/irms/reports/${reportId}/signatures`, sigForm) as { status: number; json: { data?: { id: string; url: string }, error?: { message: string } } };
  check("save signature via API", sigRes.status === 201 && !!sigRes.json.data?.id, `status=${sigRes.status} ${JSON.stringify(sigRes.json.error)}`);
  if (sigRes.json.data) {
    const sigRow = await db.inspectionSignature.findUnique({ where: { id: sigRes.json.data.id }, select: { storagePath: true } });
    check("signature stored under irms/ key in S3", !!sigRow?.storagePath?.startsWith(`irms/${reportId}/signatures/`), sigRow?.storagePath ?? "missing");
    check("signature object exists", (await statObject(sigRow?.storagePath ?? "")) !== null);
    const sigFile = await fetch(`${BASE}${sigRes.json.data.url}`, { headers: { cookie: supervisorCookie } });
    check("signature file endpoint serves PNG", sigFile.status === 200 && (sigFile.headers.get("content-type") ?? "").startsWith("image/png"));
    await sigFile.arrayBuffer();
  }

  // ── 6. Report delete → whole storage namespace cleaned (§40) ──
  const countTotal = await objectCount();
  check("report namespace has objects before delete", countTotal > 0, `count=${countTotal}`);
  const delReport = await api(adminCookie, "DELETE", `/api/v1/irms/reports/${reportId}`);
  check("delete report via API (admin)", delReport.status === 200 || delReport.status === 204, `status=${delReport.status} body=${JSON.stringify((delReport.json as { error?: unknown }) ?? {})}`);
  const afterReport = await objectCount();
  check("report delete cleans ALL its objects", afterReport === 0, `remaining=${afterReport}`);
  check("report rows cascade-deleted", (await db.inspectionPhoto.count({ where: { reportId } })) === 0);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("QA crashed:", err);
  await db.$disconnect();
  process.exit(1);
});
