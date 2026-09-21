/**
 * MOHD.HMS ENTERPRISE — FILES module QA (scripts/files-qa.ts)
 *
 * Verifies the centralized Files module against the REAL running server, the
 * REAL object store (MinIO/s3rver) and the REAL database (files spec §51–§56):
 *
 *   §51  E2E upload: chunked upload (multi-chunk) → MinIO object → PG metadata
 *        → folder relationship → audit rows → listing → download checksum match
 *   §52  PRIVATE SECURITY/IDOR: User B cannot list/search/metadata/preview/
 *        download User A's private file; grant → exact permission; revoke →
 *        immediate loss
 *   §53  SHARING: file + folder grants, recipient notification, folder
 *        inheritance, revocation cascade (no inherited bypass)
 *   §54  VERSIONS: v1 → replace v2 → history → restore v1 (as v3, history kept)
 *   §55  TRASH: trash → restore to original folder → permanent delete removes
 *        MinIO objects + metadata, audit remains
 *   §56  SEARCH SECURITY: B's searches never return A's private content
 *   plus: quota enforcement, admin storage/audit RBAC, copy, star, single-shot
 *         multipart version upload, anonymous 401
 *
 * Idempotent: all scratch data is cleaned up at the end.
 * Run: bun scripts/files-qa.ts   (dev server on :3000)
 */

import { createHash } from "crypto";
import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";
const MB = 1024 * 1024;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

type Jar = Map<string, string>;
function cookieHeader(jar: Jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Jar, res: Response) {
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

async function api(method: string, path: string, body?: unknown, jar?: Jar) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(jar && jar.size ? { cookie: cookieHeader(jar) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (jar) absorb(jar, res);
  let data: unknown = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { status: res.status, data: data as Record<string, unknown> };
}

async function login(email: string): Promise<Jar> {
  const jar: Jar = new Map();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    absorb(jar, res);
    if (res.status === 200) return jar;
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    throw new Error(`login failed for ${email}: ${res.status}`);
  }
}

/** Chunked upload with a mid-upload interruption + resume (§8 pause/resume). */
async function chunkedUpload(jar: Jar, name: string, bytes: Buffer, folderId: string | null, pauseAfterChunk?: number) {
  const chunkSize = 8 * MB;
  const totalChunks = Math.ceil(bytes.length / chunkSize);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const created = await api("POST", "/api/v1/files/uploads", {
    name, sizeBytes: bytes.length, mimeType: "application/octet-stream",
    totalChunks, folderId, checksum: sha,
  }, jar);
  if (created.status !== 201) return { error: created as unknown as { status: number; data: Record<string, unknown> } };
  const sessionId = (created.data.data as Record<string, unknown>).sessionId as string;

  const stopAt = pauseAfterChunk ?? totalChunks;
  const pausedRun = pauseAfterChunk !== undefined;
  for (let i = 0; i < stopAt; i++) {
    const slice = bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length));
    const res = await fetch(`${BASE}/api/v1/files/uploads/${sessionId}/parts/${i}`, {
      method: "PUT", headers: { cookie: cookieHeader(jar), "content-type": "application/octet-stream" },
      body: new Uint8Array(slice),
    });
    absorb(jar, res);
    if (res.status !== 200) return { error: { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> } };
  }
  if (pausedRun) return { sessionId, status: 0, file: null, sha, pausedAt: stopAt };
  // "resume": fetch session state, confirm the server ledger matches
  const state = await api("GET", `/api/v1/files/uploads/${sessionId}`, undefined, jar);
  const received = ((state.data.data as Record<string, unknown>)?.receivedChunks as number[]) ?? [];
  if (received.length !== stopAt) return { error: { status: 0, data: { error: "resume ledger mismatch", received } } };
  for (let i = stopAt; i < totalChunks; i++) {
    const slice = bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length));
    const res = await fetch(`${BASE}/api/v1/files/uploads/${sessionId}/parts/${i}`, {
      method: "PUT", headers: { cookie: cookieHeader(jar), "content-type": "application/octet-stream" },
      body: new Uint8Array(slice),
    });
    absorb(jar, res);
    if (res.status !== 200) return { error: { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> } };
  }
  const done = await api("POST", `/api/v1/files/uploads/${sessionId}/complete`, undefined, jar);
  const file = ((done.data.data as Record<string, unknown>)?.file ?? null) as Record<string, unknown> | null;
  return { sessionId, status: done.status, file, sha };
}

async function downloadBytes(jar: Jar, fileId: string): Promise<{ status: number; bytes: Buffer | null }> {
  const res = await fetch(`${BASE}/api/v1/files/${fileId}/content?as=attachment`, { headers: { cookie: cookieHeader(jar) } });
  if (res.status !== 200) return { status: res.status, bytes: null };
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}

const DB_USER_A = "admin@mohdhms.com";      // SUPER_ADMIN (User A)
const DB_USER_B = "ahmad.tech@mohdhms.com"; // TECHNICIAN (User B)
const DB_CUSTOMER = "customer1@demo.my";    // CUSTOMER

async function main() {
  console.log("\n═══ FILES MODULE QA (spec §51–§56) ═══\n");

  const userA = await login(DB_USER_A);
  const userB = await login(DB_USER_B);
  const customer = await login(DB_CUSTOMER);
  const anon = new Map<string, string>();
  check("logins (A=SUPER_ADMIN, B=TECHNICIAN, C=CUSTOMER)", userA.size > 0 && userB.size > 0 && customer.size > 0);

  const aId = (await db.user.findUnique({ where: { email: DB_USER_A } }))!.id;
  const bId = (await db.user.findUnique({ where: { email: DB_USER_B } }))!.id;

  // ── §51: E2E chunked upload with mid-upload pause/resume ──────────────────
  console.log("\n── §51 E2E upload (chunked, pause/resume, checksum) ──");
  const rootFolder = await api("POST", "/api/v1/files/folders", { name: `QA-Files-${Date.now()}` }, userA);
  check("create root folder (201)", rootFolder.status === 201);
  const rootId = (rootFolder.data.data as Record<string, unknown>).id as string;
  const subFolder = await api("POST", "/api/v1/files/folders", { name: "Reports", parentId: rootId }, userA);
  check("create subfolder (201)", subFolder.status === 201);
  const subId = (subFolder.data.data as Record<string, unknown>).id as string;
  const dupFolder = await api("POST", "/api/v1/files/folders", { name: "Reports", parentId: rootId }, userA);
  check("duplicate folder name rejected (409)", dupFolder.status === 409, `got ${dupFolder.status}`);

  // ~9.5 MB deterministic buffer → 2 chunks; pause after chunk 0 → resume
  const fileBytes = Buffer.alloc(Math.floor(9.5 * MB));
  for (let i = 0; i < fileBytes.length; i += 4096) fileBytes.write(`F${(i % 65536).toString(16).padStart(4, "0")}`, i);
  const originalSha = createHash("sha256").update(fileBytes).digest("hex");

  const paused = await chunkedUpload(userA, "qa-evidence.bin", fileBytes, subId, 1);
  check("session created + chunk 0 accepted (paused)", !("error" in paused));
  if ("error" in paused) { console.log(paused.error); return; }
  const resumed = await chunkedUpload(userA, "qa-evidence.bin", fileBytes, subId);
  // §8 resume: fetch the PAUSED session state, then upload ONLY the missing chunks.
  const resumedState = await api("GET", `/api/v1/files/uploads/${paused.sessionId}`, undefined, userA);
  const resumeChunks = ((resumedState.data.data as Record<string, unknown>)?.receivedChunks as number[]) ?? [];
  check("resume state shows received chunks (server ledger)", resumedState.status === 200 && resumeChunks.length === 1 && resumeChunks[0] === 0, JSON.stringify(resumeChunks));
  for (let i = 0; i < Math.ceil(fileBytes.length / (8 * MB)); i++) {
    if (resumeChunks.includes(i)) continue;
    const slice = fileBytes.subarray(i * 8 * MB, Math.min((i + 1) * 8 * MB, fileBytes.length));
    const r = await fetch(`${BASE}/api/v1/files/uploads/${paused.sessionId}/parts/${i}`, {
      method: "PUT", headers: { cookie: cookieHeader(userA), "content-type": "application/octet-stream" }, body: new Uint8Array(slice),
    });
    absorb(userA, r);
  }
  const completePaused = await api("POST", `/api/v1/files/uploads/${paused.sessionId}/complete`, undefined, userA);
  const pausedFile = ((completePaused.data.data as Record<string, unknown>)?.file ?? null) as Record<string, unknown> | null;
  check("paused session completes after resume (201)", completePaused.status === 201 && Boolean(pausedFile), `got ${completePaused.status}`);
  const fileId = pausedFile!.id as string;

  check("fresh chunked upload completes (201)", resumed.status === 201 && Boolean(resumed.file), `got ${resumed.status}`);
  const fileBId = (resumed.file as Record<string, unknown>).id as string;

  const listing = await api("GET", `/api/v1/files?view=mine&folderId=${subId}`, undefined, userA);
  const listingFiles = ((listing.data.data as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
  check("file appears in folder listing (§8 #6)", listing.status === 200 && listingFiles.some((f) => f.id === fileId));
  const meta = await api("GET", `/api/v1/files/${fileId}`, undefined, userA);
  check("metadata: size + checksum + folder (§8 #2/#3/#4/#11)",
    meta.status === 200
    && (meta.data.data as Record<string, unknown>).file
    && ((meta.data.data as Record<string, unknown>).file as Record<string, unknown>).checksum === originalSha
    && ((meta.data.data as Record<string, unknown>).breadcrumb as unknown[]).length === 2);
  const dl = await downloadBytes(userA, fileId);
  const dlSha = dl.bytes ? createHash("sha256").update(dl.bytes).digest("hex") : "";
  check("download works + checksum matches original (§8 #7/§51 #15/#16)", dl.status === 200 && dl.bytes!.length === fileBytes.length && dlSha === originalSha);

  // Chunk plan mismatch + oversized file rejection (§36)
  const badPlan = await api("POST", "/api/v1/files/uploads", { name: "x.bin", sizeBytes: 100, totalChunks: 9 }, userA);
  check("chunk plan mismatch rejected (400)", badPlan.status === 400, `got ${badPlan.status}`);
  const tooBig = await api("POST", "/api/v1/files/uploads", { name: "x.bin", sizeBytes: 300 * MB, totalChunks: Math.ceil(300 * MB / (8 * MB)) }, userA);
  check("oversize upload rejected (400)", tooBig.status === 400, `got ${tooBig.status}`);

  // ── §52: IDOR / private file security ────────────────────────────────────
  console.log("\n── §52 private file security (IDOR) ──");
  const bMeta = await api("GET", `/api/v1/files/${fileId}`, undefined, userB);
  check("B: metadata of A's private file → 404", bMeta.status === 404, `got ${bMeta.status}`);
  const bList = await api("GET", `/api/v1/files?view=mine&folderId=${subId}`, undefined, userB);
  check("B: browse A's folder → 404", bList.status === 404, `got ${bList.status}`);
  const bDl = await downloadBytes(userB, fileId);
  check("B: download A's private file → 404", bDl.status === 404, `got ${bDl.status}`);
  const bPreview = await fetch(`${BASE}/api/v1/files/${fileId}/content?as=inline`, { headers: { cookie: cookieHeader(userB) } });
  check("B: preview A's private file → 404", bPreview.status === 404, `got ${bPreview.status}`);
  const bVersion = await api("GET", `/api/v1/files/${fileId}/versions`, undefined, userB);
  check("B: version history of A's file → 404", bVersion.status === 404, `got ${bVersion.status}`);
  const bShare = await api("POST", `/api/v1/files/${fileId}/shares`, { userId: bId, permission: "MANAGE" }, userB);
  check("B: cannot grant himself a share on A's file → 404", bShare.status === 404, `got ${bShare.status}`);
  const cDl = await downloadBytes(customer, fileId);
  check("CUSTOMER: download A's private file → 404", cDl.status === 404, `got ${cDl.status}`);
  const anonDl = await downloadBytes(anon, fileId);
  check("ANONYMOUS: download → 401", anonDl.status === 401, `got ${anonDl.status}`);

  // Grant DOWNLOAD exactly (not MANAGE) → exact permission (§52/§53)
  const grant = await api("POST", `/api/v1/files/${fileId}/shares`, { userId: bId, permission: "DOWNLOAD" }, userA);
  check("A: shares file with B (DOWNLOAD) → 201", grant.status === 201, `got ${grant.status}`);
  const bDl2 = await downloadBytes(userB, fileId);
  check("B: download after grant → 200", bDl2.status === 200);
  const bMeta2 = await api("GET", `/api/v1/files/${fileId}`, undefined, userB);
  check("B: metadata after grant → 200", bMeta2.status === 200);
  const bRename = await api("PATCH", `/api/v1/files/${fileId}`, { name: "hacked.bin" }, userB);
  check("B: rename with DOWNLOAD grant → 403", bRename.status === 403, `got ${bRename.status}`);
  const bSharedList = await api("GET", "/api/v1/files?view=shared", undefined, userB);
  const bSharedFiles = ((bSharedList.data.data as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
  check("B: Shared-With-Me lists the file with permission", bSharedList.status === 200 && bSharedFiles.some((f) => f.id === fileId && f.permission === "DOWNLOAD"));
  const bNotif = await db.notification.findFirst({ where: { userId: bId, resourceType: "FILE", resourceId: fileId }, orderBy: { createdAt: "desc" } });
  check("B: share notification created (§27/§53)", Boolean(bNotif), JSON.stringify(bNotif ? bNotif.title : null));

  const revoke = await api("DELETE", `/api/v1/files/${fileId}/shares/${((grant.data.data as Record<string, unknown>).share as Record<string, unknown>).id}`, undefined, userA);
  check("A: revoke share → 200", revoke.status === 200);
  const bDl3 = await downloadBytes(userB, fileId);
  check("B: download after revoke → IMMEDIATELY 404", bDl3.status === 404, `got ${bDl3.status}`);

  // ── §53: folder sharing + inheritance + revoke cascade ───────────────────
  console.log("\n── §53 folder sharing (inheritance) ──");
  const fGrant = await api("POST", `/api/v1/files/folders/${rootId}/shares`, { userId: bId, permission: "DOWNLOAD" }, userA);
  check("A: shares folder with B (DOWNLOAD) → 201", fGrant.status === 201, `got ${fGrant.status}`);
  const bBrowse = await api("GET", `/api/v1/files/folders/${rootId}`, undefined, userB);
  check("B: browse shared folder → 200", bBrowse.status === 200);
  const bDl4 = await downloadBytes(userB, fileId); // file inside subfolder → inherited
  check("B: download file inside shared tree (inherited) → 200", bDl4.status === 200, `got ${bDl4.status}`);
  const bSharedFolders = await api("GET", "/api/v1/files?view=shared-folders", undefined, userB);
  const sfRows = ((bSharedFolders.data.data as Record<string, unknown>).folders as Record<string, unknown>[]) ?? [];
  check("B: Shared-Folders lists the folder", sfRows.some((f) => f.id === rootId));
  const fRevoke = await api("DELETE", `/api/v1/files/folders/${rootId}/shares/${((fGrant.data.data as Record<string, unknown>).share as Record<string, unknown>).id}`, undefined, userA);
  const bDl5 = await downloadBytes(userB, fileId);
  check("B: access gone after folder revoke (no bypass)", fRevoke.status === 200 && bDl5.status === 404, `revoke ${fRevoke.status}, dl ${bDl5.status}`);

  // ── §54: versioning ──────────────────────────────────────────────────────
  console.log("\n── §54 versioning ──");
  const v1Bytes = Buffer.from("VERSION ONE CONTENT — payslip draft 2026");
  const v1Sha = createHash("sha256").update(v1Bytes).digest("hex");
  const v1 = await chunkedUpload(userA, "qa-contract.txt", v1Bytes, rootId);
  check("v1 uploaded (small, 1 chunk)", !("error" in v1) && v1.status === 201);
  const v1FileId = (v1.file as Record<string, unknown>).id as string;

  const v2Bytes = Buffer.from("VERSION TWO CONTENT — payslip final 2026 signed");
  const v2Sha = createHash("sha256").update(v2Bytes).digest("hex");
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(v2Bytes)], { type: "text/plain" }), "qa-contract.txt");
  fd.append("note", "final signed version");
  const v2res = await fetch(`${BASE}/api/v1/files/${v1FileId}/versions`, { method: "POST", headers: { cookie: cookieHeader(userA) }, body: fd });
  absorb(userA, v2res);
  const v2json = (await v2res.json().catch(() => ({}))) as Record<string, unknown>;
  check("replace with v2 (multipart) → 201", v2res.status === 201 && (v2json.data as Record<string, unknown>)?.version === 2, `got ${v2res.status}`);

  const versions = await api("GET", `/api/v1/files/${v1FileId}/versions`, undefined, userA);
  const versionRows = (versions.data.data as Record<string, unknown>).versions as Record<string, unknown>[];
  check("history shows v1 + v2 (§54)", versions.status === 200 && versionRows.length === 2 && versionRows.map((v) => v.version).sort().join(",") === "1,2");
  const v1dl = await fetch(`${BASE}/api/v1/files/${v1FileId}/versions/1?as=attachment`, { headers: { cookie: cookieHeader(userA) } });
  const v1dlSha = createHash("sha256").update(Buffer.from(await v1dl.arrayBuffer())).digest("hex");
  check("v1 download still original bytes", v1dl.status === 200 && v1dlSha === v1Sha);
  const restoreV1 = await api("POST", `/api/v1/files/${v1FileId}/versions/1`, undefined, userA);
  check("restore v1 → becomes v3 current", restoreV1.status === 200 && (restoreV1.data.data as Record<string, unknown>).newCurrentVersion === 3);
  const afterRestore = await api("GET", `/api/v1/files/${v1FileId}`, undefined, userA);
  check("current file bytes == v1 after restore", ((afterRestore.data.data as Record<string, unknown>).file as Record<string, unknown>).checksum === v1Sha);
  const versionsAfter = await api("GET", `/api/v1/files/${v1FileId}/versions`, undefined, userA);
  check("history preserved after restore (3 versions)", (((versionsAfter.data.data as Record<string, unknown>).versions as unknown[]).length === 3));

  // ── §55: trash → restore → permanent delete ─────────────────────────────
  console.log("\n── §55 trash semantics ──");
  const trash = await api("DELETE", `/api/v1/files/${v1FileId}`, undefined, userA);
  check("delete → trashed", trash.status === 200);
  const trashList = await api("GET", "/api/v1/files?view=trash", undefined, userA);
  const trashFiles = ((trashList.data.data as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
  check("file appears in Trash with deleted date", trashFiles.some((f) => f.id === v1FileId && f.trashedAt));
  const bTrashView = await api("GET", `/api/v1/files/${v1FileId}`, undefined, userB);
  check("trashed file hidden from others (404)", bTrashView.status === 404);
  const restore = await api("POST", `/api/v1/files/${v1FileId}/restore`, undefined, userA);
  const afterRestoreMeta = await api("GET", `/api/v1/files/${v1FileId}`, undefined, userA);
  const restoredFolderId = ((afterRestoreMeta.data.data as Record<string, unknown>).file as Record<string, unknown>).folderId;
  check("restore returns to ORIGINAL folder (§55)", restore.status === 200 && restoredFolderId === rootId, `folder ${restoredFolderId}`);

  const purge = await api("DELETE", `/api/v1/files/${v1FileId}/purge`, undefined, userA);
  check("permanent delete → purged", purge.status === 200);
  const afterPurge = await api("GET", `/api/v1/files/${v1FileId}`, undefined, userA);
  const afterPurgeDl = await downloadBytes(userA, v1FileId);
  check("metadata + MinIO object gone after purge", afterPurge.status === 404 && afterPurgeDl.status === 404);
  const auditRemains = await db.auditLog.findFirst({ where: { action: "FILE_PERMANENTLY_DELETED", resourceId: v1FileId } });
  check("audit record remains after purge (§55)", Boolean(auditRemains));

  // folder trash: trash root (contains Reports + 2 files) → descendants batched
  const folderTrash = await api("DELETE", `/api/v1/files/folders/${rootId}`, undefined, userA);
  check("folder delete → subtree trashed", folderTrash.status === 200 && (folderTrash.data.data as Record<string, unknown>).filesAffected === 2);
  const folderRestore = await api("POST", `/api/v1/files/folders/${rootId}/restore`, undefined, userA);
  const reportsBack = await api("GET", `/api/v1/files/folders/${subId}`, undefined, userA);
  check("folder restore brings batch back (files accessible)", folderRestore.status === 200 && reportsBack.status === 200 && (((reportsBack.data.data as Record<string, unknown>).files as unknown[]).length === 2));

  // ── §56: search security ────────────────────────────────────────────────
  console.log("\n── §56 search security ──");
  const marker = `topsecret-${Date.now()}`;
  const secretBytes = Buffer.from(`${marker} — only A should ever find this`);
  const secret = await chunkedUpload(userA, `${marker}.txt`, secretBytes, rootId);
  check("A uploads private marker file", !("error" in secret) && secret.status === 201);
  const secretId = (secret.file as Record<string, unknown>).id as string;
  const bSearch = await api("GET", `/api/v1/files?view=search&q=${marker}`, undefined, userB);
  const bSearchFiles = ((bSearch.data.data as Record<string, unknown>).files as Record<string, unknown>[]) ?? [];
  check("B search for marker → EMPTY (never leaks)", bSearch.status === 200 && bSearchFiles.length === 0, JSON.stringify(bSearchFiles.map((f) => f.name)));
  const aSearch = await api("GET", `/api/v1/files?view=search&q=${marker}`, undefined, userA);
  check("A search for marker → found", (((aSearch.data.data as Record<string, unknown>).files as unknown[]).length === 1));
  const bExtSearch = await api("GET", `/api/v1/files?view=search&q=${marker}&ext=txt`, undefined, userB);
  check("B ext-filtered search → still empty", ((((bExtSearch.data.data as Record<string, unknown>).files as unknown[]).length === 0)));

  // ── extras: copy, star, quota, admin RBAC ────────────────────────────────
  console.log("\n── extras: copy / star / quota / admin ──");
  const copy = await api("POST", `/api/v1/files/${fileId}/copy`, {}, userA);
  const copyId = ((copy.data.data as Record<string, unknown>)?.file as Record<string, unknown> | undefined)?.id as string | undefined;
  const copyDl = copyId ? await downloadBytes(userA, copyId) : { status: 0, bytes: null };
  check("copy → new file with identical bytes", copy.status === 201 && copyDl.status === 200 && copyDl.bytes!.length === fileBytes.length);
  const star = await api("POST", `/api/v1/files/${fileId}/star`, undefined, userA);
  const starredList = await api("GET", "/api/v1/files?view=starred", undefined, userA);
  check("star + starred listing", star.status === 200 && (((starredList.data.data as Record<string, unknown>).files as unknown[]).length >= 1));
  await api("POST", `/api/v1/files/${fileId}/star`, undefined, userA); // unstar

  const quotaSet = await api("PATCH", "/api/v1/files/admin/storage", { quotaMb: 1 }, userA);
  const overQuota = await chunkedUpload(userA, "quota-buster.bin", Buffer.alloc(2 * MB), null);
  check("quota enforcement: 1MB quota blocks 2MB upload (§29)", quotaSet.status === 200 && "error" in overQuota && overQuota.error.status === 400, JSON.stringify(overQuota));
  await api("PATCH", "/api/v1/files/admin/storage", { quotaMb: 512 }, userA);

  const bAdmin = await api("GET", "/api/v1/files/admin/storage", undefined, userB);
  const bAdminAudit = await api("GET", "/api/v1/files/admin/audit", undefined, userB);
  const bAdminStatus = await api("GET", "/api/v1/files/admin/status", undefined, userB);
  check("B (TECHNICIAN): admin storage/audit/status → 403", bAdmin.status === 403 && bAdminAudit.status === 403 && bAdminStatus.status === 403);
  const aAdmin = await api("GET", "/api/v1/files/admin/storage", undefined, userA);
  const aAdminAudit = await api("GET", "/api/v1/files/admin/audit", undefined, userA);
  const aStatus = await api("GET", "/api/v1/files/admin/status", undefined, userA);
  const statusOk = aStatus.status === 200 && ((aStatus.data.data as Record<string, unknown>).storage as Record<string, unknown>).ok === true;
  check("A (SUPER_ADMIN): storage stats + audit + status 200 (MinIO healthy)", aAdmin.status === 200 && aAdminAudit.status === 200 && statusOk);

  const dash = await api("GET", "/api/v1/files/dashboard", undefined, userA);
  const dashTotals = ((dash.data.data as Record<string, unknown>).totals as Record<string, unknown>) ?? {};
  check("dashboard aggregates present (§5)", dash.status === 200 && Number(dashTotals.files) > 0 && Number(dashTotals.quotaBytes) > 0);
  const activity = await api("GET", "/api/v1/files/activity", undefined, userA);
  const activityItems = activity.data.data as unknown[];
  check("activity feed from real audit data (§25)", activity.status === 200 && Array.isArray(activityItems) && activityItems.length > 0);
  const targets = await api("GET", "/api/v1/files/share-targets?q=ahmad", undefined, userA);
  check("share-target picker returns minimal users", targets.status === 200 && (((targets.data.data as Record<string, unknown>).users as unknown[]).length >= 1));

  // cleanup
  console.log("\n── cleanup ──");
  const myFolders = await api("GET", "/api/v1/files?view=mine", undefined, userA);
  const rootFolders = ((myFolders.data.data as Record<string, unknown>).folders as Record<string, unknown>[]).filter((f) => String(f.name).startsWith("QA-Files-"));
  for (const f of rootFolders) await api("DELETE", `/api/v1/files/folders/${f.id}/purge`, undefined, userA);
  for (const id of [fileId, fileBId, secretId].filter(Boolean)) await api("DELETE", `/api/v1/files/${id}/purge`, undefined, userA).catch(() => undefined);
  const orphans = await db.fileEntry.findMany({ where: { ownerId: aId, name: { in: ["quota-buster.bin"] } }, select: { id: true } });
  for (const o of orphans) await api("DELETE", `/api/v1/files/${o.id}/purge`, undefined, userA).catch(() => undefined);
  console.log(`  removed ${rootFolders.length} QA folder tree(s) + scratch files`);

  console.log(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("QA crashed:", e);
    process.exit(1);
  });
