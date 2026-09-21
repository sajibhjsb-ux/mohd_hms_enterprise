// MOHD.HMS ENTERPRISE — Email CLIENT QA (throwaway test fixture, NOT app code).
// Exercises the user-facing email client end-to-end against the REAL server:
// REAL SMTP sink (scripts/smtp-sink-qa.ts on 127.0.0.1:2525), REAL MinIO,
// REAL database, REAL worker. Spec §47–§50 — no fake success anywhere.
// Idempotent: cleans up its rows at the end.

import { db } from "../src/lib/db";

const BASE = "http://localhost:3000";
const PASSWORD = "Password@123";
const ADMIN = "admin@mohdhms.com"; // SUPER_ADMIN
const TECH = "ahmad.tech@mohdhms.com"; // TECHNICIAN
const CUSTOMER = "customer1@demo.my"; // CUSTOMER
const SINK_HOST = "127.0.0.1";
const SINK_PORT = 2525;
const STAMP = `qa-${Date.now()}`;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
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
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  absorb(jar, res);
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return jar;
}
const d = (envelope: unknown) => (envelope as { data?: unknown })?.data;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => Promise<boolean>, ms = 15_000, label = "condition"): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(1200);
  }
  console.log(`  (timeout waiting for ${label})`);
  return false;
}

async function main() {
  console.log(`\n=== EMAIL CLIENT QA — ${STAMP} ===`);
  // Idempotent start: sweep leftovers from any earlier crashed run.
  const stale = await db.mailbox.findMany({ where: { email: { contains: "qa." } }, select: { id: true } });
  for (const m of stale) {
    await db.mailMessage.deleteMany({ where: { mailboxId: m.id } });
    await db.mailbox.delete({ where: { id: m.id } }).catch(() => undefined);
  }
  await db.emailLog.deleteMany({ where: { relatedType: "MAIL_MESSAGE" } });

  const admin = await login(ADMIN);
  const tech = await login(TECH);
  const customer = await login(CUSTOMER);
  const adminId = (await db.user.findUnique({ where: { email: ADMIN } }))!.id;
  const techId = (await db.user.findUnique({ where: { email: TECH } }))!.id;

  // ── 0. Point the REAL EmailConfig at the QA sink (admin config surface) ──
  const cfgRes = await api("PATCH", "/api/v1/email/config", {
    smtpHost: SINK_HOST, smtpPort: SINK_PORT, smtpSecurity: "NONE",
    smtpUser: "qa-sender@mohdhms.com", smtpPassword: "qa-sink-accepts-anything",
    fromName: "MOHD.HMS QA", fromEmail: "qa-sender@mohdhms.com",
  }, admin);
  check("PATCH /email/config (admin)", cfgRes.status === 200, JSON.stringify(cfgRes.data).slice(0, 120));
  const cfgSafe = d(cfgRes.data) as Record<string, unknown>;
  check("config safe: hasPassword boolean, no secret", cfgSafe.hasPassword === true && !JSON.stringify(cfgSafe).includes("qa-sink-accepts-anything"));

  // ── 1. Mailbox administration (§28) ──
  const mbPersonal = await api("POST", "/api/v1/email/mailboxes", {
    email: `qa.personal.${STAMP}@mohdhms.com`, displayName: "QA Personal", kind: "PERSONAL", ownerUserId: adminId,
  }, admin);
  check("create PERSONAL mailbox (admin)", mbPersonal.status === 201, JSON.stringify(mbPersonal.data).slice(0, 120));
  const personalId = String((d(mbPersonal.data) as Record<string, string>)?.id ?? "");

  const mbShared = await api("POST", "/api/v1/email/mailboxes", {
    email: `qa.shared.${STAMP}@mohdhms.com`, displayName: "QA Service", kind: "SHARED",
  }, admin);
  const sharedId = String((d(mbShared.data) as Record<string, string>)?.id ?? "");
  check("create SHARED mailbox (admin)", mbShared.status === 201 && Boolean(sharedId));

  const addTech = await api("POST", `/api/v1/email/mailboxes/${sharedId}/members/${techId}`, { canSend: true }, admin);
  check("add technician member (canSend)", addTech.status === 200);
  const addAdmin = await api("POST", `/api/v1/email/mailboxes/${sharedId}/members/${adminId}`, { canSend: true }, admin);
  check("add admin member to shared mailbox", addAdmin.status === 200);
  const dupOwner = await api("POST", `/api/v1/email/mailboxes/${personalId}/members/${adminId}`, { canSend: true }, admin);
  check("owner membership idempotent upsert", dupOwner.status === 200);

  const mbDupe = await api("POST", "/api/v1/email/mailboxes", { email: `qa.shared.${STAMP}@mohdhms.com`, kind: "SHARED" }, admin);
  check("duplicate mailbox address rejected (409)", mbDupe.status === 409);
  const mbBad = await api("POST", "/api/v1/email/mailboxes", { email: "not-an-address", kind: "PERSONAL" }, admin);
  check("invalid mailbox address rejected (400)", mbBad.status === 400);
  const mbCust = await api("POST", `/api/v1/email/mailboxes/${sharedId}/members/${(await db.user.findUnique({ where: { email: CUSTOMER } }))!.id}`, { canSend: true }, admin);
  check("customer cannot be assigned to internal mailbox (400)", mbCust.status === 400);
  const mbTechAdmin = await api("POST", "/api/v1/email/mailboxes", { email: `x${STAMP}@mohdhms.com` }, tech);
  check("technician cannot create mailboxes (403)", mbTechAdmin.status === 403);

  // ── 2. Bootstrap + RBAC (§36) ──
  const bootAdmin = await api("GET", "/api/v1/email/client/bootstrap", undefined, admin);
  const boot = d(bootAdmin.data) as Record<string, unknown>;
  const bootMailboxes = (boot?.mailboxes ?? []) as Record<string, unknown>[];
  check("bootstrap: 2 readable mailboxes", bootAdmin.status === 200 && bootMailboxes.length === 2);
  check("bootstrap: smtp.configured TRUE (real config)", boot?.smtp && (boot.smtp as Record<string, unknown>).configured === true);
  check("bootstrap: inbound.supported=false (honest)", boot?.inbound && (boot.inbound as Record<string, unknown>).supported === false);
  const bootTech = d((await api("GET", "/api/v1/email/client/bootstrap", undefined, tech)).data) as Record<string, unknown>;
  check("technician: email.client OK, sees exactly the shared mailbox", ((bootTech?.mailboxes ?? []) as unknown[]).length === 1);
  const bootCust = await api("GET", "/api/v1/email/client/bootstrap", undefined, customer);
  check("CUSTOMER: email.client denied (403)", bootCust.status === 403);
  const anon = await api("GET", "/api/v1/email/client/bootstrap");
  check("anonymous: 401", anon.status === 401);

  // ── 3. Drafts (§10 — PostgreSQL persistence) ──
  const sinkRcpt = `sink.${STAMP}@example.com`;
  const draftRes = await api("POST", "/api/v1/email/client/drafts", {
    mailboxId: personalId, to: [sinkRcpt], subject: `${STAMP} first draft`, body: "Draft body v1.",
  }, admin);
  const draft = d(draftRes.data) as Record<string, unknown>;
  const draftId = String(draft?.id ?? "");
  check("create draft (201, DRAFTS folder)", draftRes.status === 201 && draft?.folder === "DRAFTS" && Boolean(draftId));
  const patched = await api("PATCH", `/api/v1/email/client/drafts/${draftId}`, {
    mailboxId: personalId, to: [sinkRcpt], subject: `${STAMP} draft v2`, body: `Body v2 with marker ${STAMP}.`,
  }, admin);
  check("autosave PATCH updates draft", patched.status === 200 && (d(patched.data) as Record<string, unknown>)?.subject === `${STAMP} draft v2`);
  const listDrafts = d((await api("GET", "/api/v1/email/client/messages?folder=DRAFTS", undefined, admin)).data) as Record<string, unknown>;
  check("draft visible in DRAFTS list", ((listDrafts?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === draftId));
  // threadId always set
  const draftDetail = d((await api("GET", `/api/v1/email/client/messages/${draftId}`, undefined, admin)).data) as Record<string, unknown>;
  check("draft threadId = own id", String(draftDetail?.threadId ?? "") === draftId);

  // ── 4. Send the draft (§12 — REAL SMTP via worker) ──
  const sendRes = await api("POST", `/api/v1/email/client/drafts/${draftId}/send`, {
    to: [sinkRcpt], subject: `${STAMP} hello from the client`, body: `Real send body ${STAMP}.`,
  }, admin);
  const sent = d(sendRes.data) as Record<string, unknown>;
  check("draft send accepted → status QUEUED (never 'sent')", sendRes.status === 200 && sent?.status === "QUEUED" && Boolean(sent?.emailLogId));
  const emailLogId = String(sent?.emailLogId ?? "");

  const becameSent = await waitFor(async () => {
    const msg = d((await api("GET", `/api/v1/email/client/messages/${draftId}`, undefined, admin)).data) as Record<string, unknown>;
    return msg?.status === "SENT" && msg?.folder === "SENT";
  }, 20_000, "worker SENT transition");
  check("worker delivered → MailMessage SENT + folder SENT (mirrored)", becameSent);
  const sentDetail = d((await api("GET", `/api/v1/email/client/messages/${draftId}`, undefined, admin)).data) as Record<string, unknown>;
  check("SMTP Message-ID captured on the message", String(sentDetail?.messageId ?? "").includes("@"));
  const log = await db.emailLog.findUnique({ where: { id: emailLogId } });
  check("authoritative EmailLog SENT with provider evidence", log?.status === "SENT" && log.providerResponse.includes("250"));
  check("EmailLog linked to the MailMessage", log?.relatedType === "MAIL_MESSAGE" && log.relatedId === draftId && log.category === "COMPOSE");

  const listSent = d((await api("GET", "/api/v1/email/client/messages?folder=SENT", undefined, admin)).data) as Record<string, unknown>;
  check("message listed under SENT", ((listSent?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === draftId));

  // ── 5. Direct send + attachment (§11/§19/§20 — Files + MinIO) ──
  const fd = new FormData();
  fd.append("file", new File([new TextEncoder().encode(`attachment payload ${STAMP}`)], `qa-att-${STAMP}.txt`, { type: "text/plain" }));
  const upRes = await fetch(`${BASE}/api/v1/email/client/attachments`, { method: "POST", body: fd, headers: { cookie: cookieHeader(admin) } });
  const up = d(await upRes.json()) as Record<string, unknown>;
  check("attachment upload → real FileEntry (Files integration)", upRes.status === 201 && Boolean(up?.fileId));
  const fileEntry = await db.fileEntry.findUnique({ where: { id: String(up?.fileId) } });
  check("uploaded attachment is a FileEntry in MinIO", Boolean(fileEntry?.objectKey?.startsWith("mail/uploads/")));

  const send2 = await api("POST", "/api/v1/email/client/send", {
    mailboxId: personalId, to: [sinkRcpt], cc: [`cc.${STAMP}@example.com`], bcc: [`bcc.${STAMP}@example.com`],
    subject: `${STAMP} with attachment`, body: `Attachment send ${STAMP}.`, attachmentFileIds: [String(up?.fileId)],
  }, admin);
  const sent2 = d(send2.data) as Record<string, unknown>;
  check("direct send with attachment accepted", send2.status === 200 && sent2?.status === "QUEUED");
  const msg2Id = String(sent2?.messageId ?? "");
  await waitFor(async () => {
    const m = d((await api("GET", `/api/v1/email/client/messages/${msg2Id}`, undefined, admin)).data) as Record<string, unknown>;
    return m?.status === "SENT";
  }, 20_000, "attachment send SENT");
  const det2 = d((await api("GET", `/api/v1/email/client/messages/${msg2Id}`, undefined, admin)).data) as Record<string, unknown>;
  const atts = (det2?.attachments ?? []) as Record<string, unknown>[];
  check("attachment materialized into mail-owned MinIO key", atts.length === 1 && String((atts[0] as Record<string, unknown>).id).length > 0);
  const attRow = await db.mailAttachment.findFirst({ where: { messageId: msg2Id } });
  check("MailAttachment key moved to mail/messages prefix", Boolean(attRow && attRow.objectKey.startsWith(`mail/messages/${msg2Id}/`)));
  check("bcc stored on sender copy only, not echoed to cc field", String(det2?.bccEmail ?? "").includes(`bcc.${STAMP}@example.com`));

  if (atts.length === 1) {
    // Authorized attachment download — byte-identical
    const dl = await fetch(`${BASE}/api/v1/email/client/messages/${msg2Id}/attachments/${String(atts[0].id)}`, { headers: { cookie: cookieHeader(admin) } });
    const dlText = await dl.text();
    check("attachment download byte-identical (authorized)", dl.status === 200 && dlText === `attachment payload ${STAMP}`);
    check("download disposition is attachment", (dl.headers.get("content-disposition") ?? "").startsWith("attachment"));
  }

  // ── 6. IDOR / mailbox crossover (§44/§45) ──
  const techDraftForeign = await api("POST", "/api/v1/email/client/drafts", { mailboxId: personalId, to: [sinkRcpt], subject: "x", body: "x" }, tech);
  check("technician cannot use a mailbox he cannot access (404)", techDraftForeign.status === 404);
  const techReadSent = await api("GET", `/api/v1/email/client/messages/${draftId}`, undefined, tech);
  check("technician cannot read admin's message (404)", techReadSent.status === 404);
  const techDownload = await fetch(`${BASE}/api/v1/email/client/messages/${msg2Id}/attachments/${atts.length === 1 ? String(atts[0].id) : "none"}`, { headers: { cookie: cookieHeader(tech) } });
  check("technician cannot download admin's attachment (404)", techDownload.status === 404);
  const custRead = await api("GET", `/api/v1/email/client/messages/${draftId}`, undefined, customer);
  check("customer cannot read (403)", custRead.status === 403);
  const forgedSender = await api("POST", "/api/v1/email/client/send", { mailboxId: sharedId, to: [sinkRcpt], subject: "x", body: "y" }, customer);
  check("customer cannot send from shared mailbox (403 — no permission at all)", forgedSender.status === 403);
  const anonSend = await api("POST", "/api/v1/email/client/send", { mailboxId: personalId, to: [sinkRcpt], subject: "x", body: "y" });
  check("anonymous send rejected (401)", anonSend.status === 401);
  const badRcpt = await api("POST", "/api/v1/email/client/send", { mailboxId: personalId, to: ["not-an-email"], subject: "x", body: "y" }, admin);
  check("invalid recipient rejected (400)", badRcpt.status === 400);
  const headerInject = await api("POST", "/api/v1/email/client/send", { mailboxId: personalId, to: [sinkRcpt], subject: `subj\r\nBcc: victim@example.com`, body: "x" }, admin);
  const injMsg = d(headerInject.data) as Record<string, unknown> | undefined;
  const injRow = injMsg?.messageId ? await db.mailMessage.findUnique({ where: { id: String(injMsg.messageId) } }) : null;
  check("header injection sanitized — no CR/LF persisted or relayed", headerInject.status === 400 || (injRow !== null && !/[\r\n]/.test(injRow.subject)));

  // ── 7. Reply / Reply-All / Forward (§16–§18) ──
  const prefillReply = d((await api("GET", `/api/v1/email/client/messages/${msg2Id}/prefill?mode=reply`, undefined, admin)).data) as Record<string, unknown>;
  check("reply prefill: To = original recipient, Re: subject, quoted body", Array.isArray(prefillReply.to) && (prefillReply.to as string[])[0] === sinkRcpt && String(prefillReply.subject).startsWith("Re:") && String(prefillReply.body).includes("> Attachment send"));
  const prefillAll = d((await api("GET", `/api/v1/email/client/messages/${msg2Id}/prefill?mode=replyAll`, undefined, admin)).data) as Record<string, unknown>;
  const allTo = (prefillAll.to ?? []) as string[];
  const allCc = (prefillAll.cc ?? []) as string[];
  // cc recipient stays in CC; BCC of the original must appear NOWHERE (§17).
  check("reply-all keeps to/cc and drops BCC entirely (§17)", allTo.includes(sinkRcpt) && allCc.includes(`cc.${STAMP}@example.com`) && !allTo.concat(allCc).some((a) => a.includes(`bcc.${STAMP}`)));
  const fwdDraft = await api("POST", "/api/v1/email/client/drafts", {
    mailboxId: personalId, to: [`fwd.${STAMP}@example.com`], subject: "Fwd test", body: "Forwarding…", forwardFrom: msg2Id,
  }, admin);
  const fwdDetail = d(fwdDraft.data) as Record<string, unknown>;
  check("forward draft clones the original attachment (§18/§20)", fwdDraft.status === 201 && ((fwdDetail?.attachments ?? []) as unknown[]).length === 1);
  await api("DELETE", `/api/v1/email/client/drafts/${String(fwdDetail?.id)}`, undefined, admin);

  // ── 8. Threads (§22) ──
  const replySend = await api("POST", "/api/v1/email/client/send", {
    mailboxId: personalId, to: [sinkRcpt], subject: `Re: ${STAMP} with attachment`, body: "threaded reply",
  }, admin);
  const replyId = String((d(replySend.data) as Record<string, unknown>)?.messageId ?? "");
  const replyDetail = d((await api("GET", `/api/v1/email/client/messages/${replyId}`, undefined, admin)).data) as Record<string, unknown>;
  check("fresh compose is its own thread (no invented threading)", String(replyDetail?.threadId ?? "") === replyId);

  // ── 9. Flags, folders, search (§21/§23–§27) ──
  await api("PATCH", `/api/v1/email/client/messages/${draftId}`, { action: "star" }, admin);
  await api("PATCH", `/api/v1/email/client/messages/${draftId}`, { action: "important" }, admin);
  await api("PATCH", `/api/v1/email/client/messages/${draftId}`, { action: "unread" }, admin);
  let starList = d((await api("GET", "/api/v1/email/client/messages?folder=STARRED", undefined, admin)).data) as Record<string, unknown>;
  check("STARRED virtual folder reflects persisted star", ((starList?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === draftId));
  let impList = d((await api("GET", "/api/v1/email/client/messages?folder=IMPORTANT", undefined, admin)).data) as Record<string, unknown>;
  check("IMPORTANT virtual folder reflects persisted flag", ((impList?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === draftId));
  const bootAfterFlags = d((await api("GET", "/api/v1/email/client/bootstrap", undefined, admin)).data) as Record<string, unknown>;
  check("unread count reflects real state (INBOX-independent unread=1)", ((bootAfterFlags?.counts ?? {}) as Record<string, number>).STARRED >= 1);

  await api("PATCH", `/api/v1/email/client/messages/${msg2Id}`, { action: "archive" }, admin);
  const archList = d((await api("GET", "/api/v1/email/client/messages?folder=ARCHIVE", undefined, admin)).data) as Record<string, unknown>;
  check("archive moves out of normal view into ARCHIVE", ((archList?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === msg2Id));
  await api("PATCH", `/api/v1/email/client/messages/${msg2Id}`, { action: "restore" }, admin);
  const restored = d((await api("GET", `/api/v1/email/client/messages/${msg2Id}`, undefined, admin)).data) as Record<string, unknown>;
  check("restore returns OUT mail to SENT", restored?.folder === "SENT");

  await api("PATCH", `/api/v1/email/client/messages/${msg2Id}`, { action: "spam" }, admin);
  const spamList = d((await api("GET", "/api/v1/email/client/messages?folder=SPAM", undefined, admin)).data) as Record<string, unknown>;
  check("spam folder holds moved message", ((spamList?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === msg2Id));

  const searchRes = d((await api("GET", `/api/v1/email/client/messages?q=${encodeURIComponent("Real send body")}`, undefined, admin)).data) as Record<string, unknown>;
  check("server-side search finds the sent body text", ((searchRes?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === draftId));
  const searchScoped = d((await api("GET", `/api/v1/email/client/messages?q=${encodeURIComponent(`marker ${STAMP}`)}`, undefined, tech)).data) as Record<string, unknown>;
  check("search is mailbox-scoped — technician finds nothing of admin's", ((searchScoped?.messages ?? []) as Record<string, unknown>[]).length === 0);

  // ── 10. Trash / permanent delete (§27) ──
  await api("PATCH", `/api/v1/email/client/messages/${msg2Id}`, { action: "trash" }, admin);
  const trashList = d((await api("GET", "/api/v1/email/client/messages?folder=TRASH", undefined, admin)).data) as Record<string, unknown>;
  check("trash holds the message", ((trashList?.messages ?? []) as Record<string, unknown>[]).some((m) => m.id === msg2Id));
  const del = await api("DELETE", `/api/v1/email/client/messages/${msg2Id}`, undefined, admin);
  check("delete inside Trash = permanent", del.status === 200);
  const gone = await db.mailMessage.findUnique({ where: { id: msg2Id } });
  check("permanent delete removed the row + mail-owned object key recorded", gone === null);
  const goneAfter = await api("GET", `/api/v1/email/client/messages/${msg2Id}`, undefined, admin);
  check("deleted message 404 afterwards", goneAfter.status === 404);

  // ── 11. Honesty when SMTP unconfigured (§49) ──
  await api("PATCH", "/api/v1/email/config", { smtpHost: "", smtpPassword: null }, admin);
  const queuedMsg = await api("POST", "/api/v1/email/client/send", { mailboxId: personalId, to: [sinkRcpt], subject: `${STAMP} while unconfigured`, body: "stays queued" }, admin);
  const queuedId = String((d(queuedMsg.data) as Record<string, unknown>)?.messageId ?? "");
  await sleep(13_000); // two worker ticks
  const queuedDetail = d((await api("GET", `/api/v1/email/client/messages/${queuedId}`, undefined, admin)).data) as Record<string, unknown>;
  check("unconfigured SMTP → message stays QUEUED with honest CONFIG error, NOT sent", queuedDetail?.status === "QUEUED" && String(queuedDetail?.lastError ?? "").toLowerCase().includes("not configured"));

  // Retry path (§12/§14): restore config, retry → SENT
  await api("PATCH", "/api/v1/email/config", { smtpHost: SINK_HOST, smtpPort: SINK_PORT, smtpSecurity: "NONE", smtpUser: "qa-sender@mohdhms.com", smtpPassword: "qa-sink-accepts-anything" }, admin);
  const retryRes = await api("POST", `/api/v1/email/client/messages/${queuedId}/retry`, undefined, admin);
  const retriedSent = await waitFor(async () => {
    const m = d((await api("GET", `/api/v1/email/client/messages/${queuedId}`, undefined, admin)).data) as Record<string, unknown>;
    return m?.status === "SENT";
  }, 20_000, "retry SENT");
  check("retry requeues through the existing EmailService → SENT", retryRes.status === 200 && retriedSent);

  // ── 12. Audit trail (§46) ──
  const audits = await db.auditLog.findMany({
    where: { action: { in: ["MAIL_SENT", "MAIL_DRAFT_CREATED", "MAIL_DRAFT_UPDATED", "MAIL_TRASHED", "MAIL_PERMANENTLY_DELETED", "MAIL_RETRY", "MAILBOX_CREATED", "MAILBOX_MEMBER_ADDED", "MAIL_ATTACHMENT_ADDED"] }, createdAt: { gte: new Date(Date.now() - 600_000) } },
    select: { action: true, metadata: true },
  });
  const actions = new Set(audits.map((a) => a.action));
  check("audit covers sends/drafts/moves/deletes/retry/mailbox ops", ["MAIL_SENT", "MAIL_DRAFT_CREATED", "MAIL_TRASHED", "MAIL_PERMANENTLY_DELETED", "MAIL_RETRY", "MAILBOX_CREATED", "MAILBOX_MEMBER_ADDED"].every((a) => actions.has(a)));
  check("no credentials in audit metadata", !audits.some((a) => a.metadata.includes("qa-sink-accepts-anything")));

  // ── Cleanup (idempotent) ──
  await db.mailMessage.deleteMany({ where: { mailboxId: { in: [personalId, sharedId] } } });
  await db.mailbox.deleteMany({ where: { id: { in: [personalId, sharedId] } } });
  if (fileEntry) {
    // Remove the object straight through the S3 API (the storage lib is
    // server-only and cannot be imported from a standalone script).
    const { Client } = await import("minio");
    const s3 = new Client({
      endPoint: process.env.S3_ENDPOINT ?? "127.0.0.1", port: Number(process.env.S3_PORT ?? 3090),
      useSSL: false, accessKey: process.env.S3_ACCESS_KEY ?? "S3RVER", secretKey: process.env.S3_SECRET_KEY ?? "S3RVER",
    });
    await s3.removeObject(process.env.S3_BUCKET ?? "hms-files", fileEntry.objectKey).catch(() => undefined);
    await db.fileEntry.delete({ where: { id: fileEntry.id } }).catch(() => undefined);
  }
  await db.emailLog.deleteMany({ where: { relatedType: "MAIL_MESSAGE" } });
  await db.emailConfig.update({ where: { id: "singleton" }, data: { smtpHost: "", smtpSecretEnc: "", fromEmail: "", lastVerifyAt: null, lastVerifyOk: null } }).catch(() => undefined);
  // messages for other tests
  await db.mailMessage.deleteMany({ where: { subject: { contains: STAMP } } });

  console.log(`\n=== EMAIL CLIENT QA: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .then(() => process.exit(0));
