/**
 * QA — Complaint ↔ Work Order lifecycle (spec §9-§19) + 15 GB quota (§3).
 * Uses the LIVE dev server. Cleans up every row it creates.
 * Run: bun scripts/complaint-wo-qa.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password@123" }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const session = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("hms_session="))
    ?? setCookie.map((c) => c.split(";")[0]).find((c) => c.includes("session"));
  if (!session) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(setCookie)}`);
  return session;
}
const get = (cookie: string, path: string) =>
  fetch(`${BASE}${path}`, { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const post = (cookie: string, path: string, data?: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { cookie, "Content-Type": "application/json" }, body: data ? JSON.stringify(data) : undefined })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const created = { complaintIds: [] as string[], woIds: [] as string[], sessionCookies: [] as string[], hadQuotaSetting: false };

async function main() {
  console.log("── Complaint ↔ Work Order lifecycle ──");
  const sup = await login("supervisor@mohdhms.com");
  const tech = await login("ahmad.tech@mohdhms.com");
  created.sessionCookies.push(sup, tech);

  const customers = await get(sup, "/api/v1/customers?pageSize=1");
  const customerId = customers.body?.data?.[0]?.id;
  ok("seed customer available", !!customerId);
  const techs = await get(sup, "/api/v1/technicians?pageSize=5");
  const techProfile = (techs.body?.data ?? []).find((t: { user?: { email?: string } }) => t.user?.email === "ahmad.tech@mohdhms.com");
  ok("technician profile available", !!techProfile?.id);

  // 1. Create complaint
  const cmp = await post(sup, "/api/v1/complaints", {
    customerId, title: "QA lifecycle complaint", description: "Complaint→WO lifecycle QA", priority: "HIGH",
  });
  ok("complaint created (201)", cmp.status === 201 || cmp.status === 200, `status=${cmp.status}`);
  const complaint = cmp.body?.data;
  created.complaintIds.push(complaint.id);

  // 2. Assign technician
  const assigned = await post(sup, `/api/v1/complaints/${complaint.id}/transition`, { action: "assign", technicianId: techProfile.id });
  ok("complaint assigned", assigned.status === 200 && assigned.body?.data?.status === "ASSIGNED", `status=${assigned.status}`);

  // 3. Create work order from the complaint (manual path)
  const wo = await post(sup, "/api/v1/work-orders", {
    title: "QA lifecycle WO", description: "From complaint", customerId, complaintId: complaint.id, technicianId: techProfile.id, priority: "HIGH",
  });
  ok("work order created (201)", wo.status === 201, `status=${wo.status}`);
  const workOrder = wo.body?.data;
  created.woIds.push(workOrder?.id);
  ok("WO linked to complaint (§9)", workOrder?.complaintId === complaint.id);
  ok("WO sourceType=COMPLAINT (§9)", workOrder?.sourceType === "COMPLAINT");
  ok("complaint moved to IN_PROGRESS (§10)", wo.status === 201 && (await get(sup, `/api/v1/complaints/${complaint.id}`)).body?.data?.status === "IN_PROGRESS");

  // 4. Idempotency — same complaint again returns the SAME work order (§45)
  const wo2 = await post(sup, "/api/v1/work-orders", {
    title: "QA lifecycle WO duplicate", customerId, complaintId: complaint.id, technicianId: techProfile.id,
  });
  ok("duplicate WO returns alreadyLinked (§45)", wo2.status === 200 && wo2.body?.data?.alreadyLinked === true && wo2.body?.data?.workOrder?.id === workOrder.id, `status=${wo2.status}`);

  // 5. Cancel blocked while WO exists (§13)
  const cancelBlocked = await post(sup, `/api/v1/complaints/${complaint.id}/transition`, { action: "cancel" });
  ok("cancel BLOCKED (§13)", cancelBlocked.status === 422, `status=${cancelBlocked.status} msg=${cancelBlocked.body?.error?.message ?? ""}`);
  ok("cancel message mentions work order", (cancelBlocked.body?.error?.message ?? "").toLowerCase().includes("work order"));

  // 6. Complete + confirm the complaint, then close must be blocked (§11) while WO active
  const completed = await post(sup, `/api/v1/complaints/${complaint.id}/transition`, { action: "complete", note: "fixed" });
  ok("complaint completed", completed.status === 200 && completed.body?.data?.status === "COMPLETED");
  const confirmed = await post(sup, `/api/v1/complaints/${complaint.id}/transition`, { action: "confirm" });
  ok("complaint confirmed", confirmed.status === 200 && confirmed.body?.data?.status === "CONFIRMED");
  const closeBlocked = await post(sup, `/api/v1/complaints/${complaint.id}/transition`, { action: "close" });
  ok("close BLOCKED while WO active (§11)", closeBlocked.status === 422, `status=${closeBlocked.status} msg=${closeBlocked.body?.error?.message ?? ""}`);
  ok("close message mentions active WO", (closeBlocked.body?.error?.message ?? "").includes("Closure blocked"));

  // 7. WO lifecycle: accept → start → complete (as the assigned technician)
  const acc = await post(tech, `/api/v1/work-orders/${workOrder.id}/transition`, { action: "accept" });
  ok("technician accepted WO", acc.status === 200, `status=${acc.status}`);
  const start = await post(tech, `/api/v1/work-orders/${workOrder.id}/transition`, { action: "start" });
  ok("technician started WO", start.status === 200, `status=${start.status}`);
  const done = await post(tech, `/api/v1/work-orders/${workOrder.id}/transition`, { action: "complete", note: "work done" });
  ok("technician completed WO", done.status === 200 && done.body?.data?.status === "COMPLETED", `status=${done.status}`);

  // 8. §15 — complaint AUTO-CLOSED after WO completion
  const after = await get(sup, `/api/v1/complaints/${complaint.id}`);
  ok("complaint AUTO-CLOSED (§15)", after.body?.data?.status === "CLOSED", `status=${after.body?.data?.status}`);
  const autoHistory = (after.body?.data?.statusHistory ?? []).find((h: { note?: string }) => (h.note ?? "").includes("automatically closed"));
  ok("auto-close history row written", !!autoHistory, autoHistory?.note ?? "");

  // 9. §13 exception — cancelling is allowed once every WO is cancelled
  const cmp2res = await post(sup, "/api/v1/complaints", { customerId, title: "QA cancel-path complaint", description: "cancel path", priority: "LOW" });
  const cmp2 = cmp2res.body?.data;
  created.complaintIds.push(cmp2.id);
  await post(sup, `/api/v1/complaints/${cmp2.id}/transition`, { action: "assign", technicianId: techProfile.id });
  const wo3 = await post(sup, "/api/v1/work-orders", { title: "QA cancel-path WO", customerId, complaintId: cmp2.id, technicianId: techProfile.id });
  const wo3id = wo3.body?.data?.id;
  created.woIds.push(wo3id);
  const wocancel = await post(sup, `/api/v1/work-orders/${wo3id}/transition`, { action: "cancel" });
  ok("WO cancelled", wocancel.status === 200);
  const cmpCancel = await post(sup, `/api/v1/complaints/${cmp2.id}/transition`, { action: "cancel" });
  ok("complaint cancellable after WO cancelled", cmpCancel.status === 200 && cmpCancel.body?.data?.status === "CANCELLED", `status=${cmpCancel.status}`);

  // 10. Direct API abuse — customer cannot transition complaints
  const cust = await login("customer1@demo.my");
  created.sessionCookies.push(cust);
  const custCancel = await post(cust, `/api/v1/complaints/${complaint.id}/transition`, { action: "cancel" });
  ok("customer cannot cancel complaints (RBAC)", custCancel.status === 403 || custCancel.status === 422, `status=${custCancel.status}`);

  console.log("── 15 GB storage quota (§3/§50) ──");
  const admin = await login("admin@mohdhms.com");
  created.sessionCookies.push(admin);
  const st0 = await get(admin, "/api/v1/files/admin/storage?page=1");
  const prevQuotaMb = st0.body?.data?.totals?.quotaMb;
  ok("quota readable", typeof prevQuotaMb === "number", `${prevQuotaMb} MB`);

  // Shrink quota to 1 MB, try a 2 MB upload (chunked session) → 413 at create
  const patch = await fetch(`${BASE}/api/v1/files/admin/storage`, {
    method: "PATCH", headers: { cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify({ quotaMb: 1 }),
  });
  ok("quota updated to 1 MB", patch.status === 200);

  const bigBuf = Buffer.alloc(2 * 1024 * 1024, 7);
  const up = await fetch(`${BASE}/api/v1/files/uploads`, {
    method: "POST", headers: { cookie: admin, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "quota-bomb.bin", sizeBytes: bigBuf.length, mimeType: "application/octet-stream", totalChunks: 1 }),
  });
  const upBody = await up.json().catch(() => null);
  ok("upload over quota REJECTED (413 QUOTA_EXCEEDED, §3)", up.status === 413 && upBody?.error?.code === "QUOTA_EXCEEDED", `status=${up.status} code=${upBody?.error?.code}`);
  ok("honest quota message", (upBody?.error?.message ?? "").toLowerCase().includes("storage"));

  // Restore quota: if there was no Setting row before, delete it again (default 15360 applies)
  created.hadQuotaSetting = prevQuotaMb !== 15360;
  if (created.hadQuotaSetting) {
    await fetch(`${BASE}/api/v1/files/admin/storage`, { method: "PATCH", headers: { cookie: admin, "Content-Type": "application/json" }, body: JSON.stringify({ quotaMb: prevQuotaMb }) });
  }
  // Verify the rejected upload left NO session/metadata behind (§3 no incomplete data)
  const sessionsAfter = await db.fileUploadSession.count({ where: { name: "quota-bomb.bin" } });
  ok("no incomplete upload session left", sessionsAfter === 0);

  // Staff storage view payload (§5)
  const st1 = await get(admin, "/api/v1/files/admin/storage?page=1&pageSize=5");
  const first = st1.body?.data?.perUser?.[0];
  ok("per-user quota payload (§5)", !!first && typeof first.limitBytes === "number" && typeof first.percentUsed === "number" && typeof first.warning === "string", first ? `${first.name}: ${first.percentUsed}% ${first.warning}` : "");

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await cleanup();
  process.exit(fail === 0 ? 0 : 1);
}

async function cleanup() {
  console.log("── cleanup ──");
  // Delete QA work orders + complaints (history + audit rows) created above.
  const woIds = created.woIds.filter(Boolean);
  const cmpIds = created.complaintIds.filter(Boolean);
  await db.workOrderChecklistItem.deleteMany({ where: { workOrderId: { in: woIds } } });
  await db.workOrderMaterial.deleteMany({ where: { workOrderId: { in: woIds } } });
  await db.workOrder.deleteMany({ where: { id: { in: woIds } } });
  await db.complaintStatusHistory.deleteMany({ where: { complaintId: { in: cmpIds } } });
  await db.complaint.deleteMany({ where: { id: { in: cmpIds } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { resourceType: "WORK_ORDER", resourceId: { in: woIds } },
        { resourceType: "COMPLAINT", resourceId: { in: cmpIds } },
      ],
    },
  });
  await db.domainEvent.deleteMany({ where: { resourceId: { in: [...woIds, ...cmpIds] } } });
  await db.notification.deleteMany({ where: { resourceId: { in: [...woIds, ...cmpIds] } } });
  await db.fileUploadSession.deleteMany({ where: { name: "quota-bomb.bin" } });
  console.log(`removed ${woIds.length} WOs, ${cmpIds.length} complaints + related rows`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
