// MOHD.HMS ENTERPRISE — database seed (initial production data)
// Run: bunx tsx prisma/seed.ts   (or: bun run prisma/seed.ts)
import { PrismaClient, type User, type Customer, type Location, type Equipment, type Complaint, type WorkOrder, type Supplier, type InventoryItem, type Employee, type TechnicianProfile } from "@prisma/client";
import { randomBytes, scrypt as _scrypt } from "crypto";
import { promisify } from "util";

const scrypt = promisify(_scrypt) as (p: string, s: string, k: number) => Promise<Buffer>;

const db = new PrismaClient();

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

function days(n: number): Date {
  return new Date(Date.now() + n * 86400000);
}
function at(offsetDays: number, h = 9, m = 0): Date {
  const d = days(offsetDays);
  d.setHours(h, m, 0, 0);
  return d;
}

async function counter(prefix: string, n: number) {
  await db.counter.upsert({ where: { key: prefix }, update: { value: n }, create: { key: prefix, value: n } });
}

async function main() {
  console.log("Seeding MOHD.HMS ENTERPRISE …");

  // wipe in dependency-safe order (fresh init only)
  await db.$transaction([
    db.auditLog.deleteMany(), db.notification.deleteMany(), db.draft.deleteMany(),
    db.payment.deleteMany(), db.invoiceItem.deleteMany(), db.invoice.deleteMany(),
    db.quotationItem.deleteMany(), db.quotation.deleteMany(),
    db.purchaseItem.deleteMany(), db.purchaseOrder.deleteMany(),
    db.stockMovement.deleteMany(), db.inventoryItem.deleteMany(), db.supplier.deleteMany(),
    db.expense.deleteMany(), db.transaction.deleteMany(), db.account.deleteMany(),
    db.workOrderMaterial.deleteMany(), db.workOrderChecklistItem.deleteMany(), db.workOrder.deleteMany(),
    db.complaintStatusHistory.deleteMany(), db.complaint.deleteMany(),
    db.pmTaskChecklistItem.deleteMany(), db.pmTask.deleteMany(), db.pmPlan.deleteMany(),
    db.inspectionFinding.deleteMany(), db.inspectionReport.deleteMany(), db.irmsProject.deleteMany(),
    db.equipment.deleteMany(), db.location.deleteMany(),
    db.attendance.deleteMany(), db.leaveRequest.deleteMany(), db.employee.deleteMany(), db.department.deleteMany(),
    db.vehicle.deleteMany(), db.technicianProfile.deleteMany(),
    db.session.deleteMany(), db.passwordResetToken.deleteMany(), db.user.deleteMany(),
    db.customer.deleteMany(), db.setting.deleteMany(), db.counter.deleteMany(),
  ]);

  const PW = await hashPassword("Password@123");

  // ── Users ──
  const superAdmin = await db.user.create({ data: { email: "admin@mohdhms.com", passwordHash: PW, name: "MohdAdmin", role: "SUPER_ADMIN", emailVerified: new Date() } });
  const admin = await db.user.create({ data: { email: "operations@mohdhms.com", passwordHash: PW, name: "Operations Manager", role: "ADMIN", emailVerified: new Date() } });
  const supervisor = await db.user.create({ data: { email: "supervisor@mohdhms.com", passwordHash: PW, name: "Field Supervisor", role: "SUPERVISOR", emailVerified: new Date() } });
  const financeUser = await db.user.create({ data: { email: "finance@mohdhms.com", passwordHash: PW, name: "Finance Officer", role: "FINANCE", emailVerified: new Date() } });
  const hrUser = await db.user.create({ data: { email: "hr@mohdhms.com", passwordHash: PW, name: "HR Officer", role: "HR", emailVerified: new Date() } });
  const techUsers: User[] = [];
  for (const [i, tn] of ([
    ["Ahmad Faizal", "ahmad.tech@mohdhms.com"], ["Lim Wei Cheng", "lim.tech@mohdhms.com"], ["Rajesh Kumar", "rajesh.tech@mohdhms.com"],
  ] as [string, string][]).entries()) {
    const u = await db.user.create({ data: { email: tn[1], passwordHash: PW, name: tn[0], role: "TECHNICIAN", emailVerified: new Date() } });
    techUsers.push(u);
    await db.technicianProfile.create({ data: { userId: u.id, employeeNo: `TEC-${String(i + 1).padStart(3, "0")}`, skills: ["HVAC,Electrical", "Plumbing,Hydraulics", "Mechanical,Electrical"][i], specialty: ["HVAC", "PLUMBING", "ELECTRICAL"][i], hourlyRateCents: 5500 + i * 500, status: "AVAILABLE" } });
  }

  // ── Customers ──
  const customerData = [
    { code: "CUS-0001", companyName: "Sunrise Mall Management", contactPerson: "Tan Mei Ling", email: "ops@sunrisemall.my", phone: "+60 3-7788 1200", city: "Kuala Lumpur", address: "88 Jalan Bukit Bintang" },
    { code: "CUS-0002", companyName: "Greenview Hospital", contactPerson: "Dr. Suresh Nair", email: "facilities@greenview.my", phone: "+60 3-7966 4400", city: "Petaling Jaya", address: "12 Jalan Gasing" },
    { code: "CUS-0003", companyName: "Metro Tower Facilities", contactPerson: "Farah Aziz", email: "fm@metrotower.my", phone: "+60 3-2166 8800", city: "Kuala Lumpur", address: "1 Jalan Ampang" },
  ];
  const customers: Customer[] = [];
  const portalUserIds: string[] = [];
  for (const [i, c] of customerData.entries()) {
    const portal = await db.user.create({ data: { email: `customer${i + 1}@demo.my`, passwordHash: PW, name: c.contactPerson, role: "CUSTOMER", emailVerified: new Date(), phone: c.phone } });
    const cu = await db.customer.create({ data: { ...c, status: "ACTIVE", portalUser: { connect: { id: portal.id } } } });
    await db.user.update({ where: { id: portal.id }, data: { customerId: cu.id } });
    customers.push(cu);
    portalUserIds.push(portal.id);
  }

  // ── Locations & Equipment ──
  const locs: Location[] = [];
  for (const l of ([["Main Chiller Plant", "LOC-CHP"], ["Level 3 AHU Room", "LOC-AHU3"], ["Basement Pump Room", "LOC-PMP"], ["Roof Solar Array", "LOC-SOL"]] as [string, string][])) {
    locs.push(await db.location.create({ data: { name: l[0], code: l[1] } }));
  }
  const equipment: Equipment[] = [];
  const eqData: [string, string, string, string, string][] = [
    ["Chiller Unit #1", "Carrier", "30XA-252", "HVAC", "LOC-CHP"],
    ["Air Handling Unit AHU-3", "York", "YVAA-36", "HVAC", "LOC-AHU3"],
    ["Booster Pump BP-02", "Grundfos", "CR-15", "PLUMBING", "LOC-PMP"],
    ["Diesel Generator DG-1", "Perkins", "1106A", "POWER", "LOC-CHP"],
    ["Passenger Lift L-04", "Otis", "GEN2", "VERTICAL_TRANSPORT", "LOC-AHU3"],
    ["Fire Pump FP-01", "Pentax", "CM-32", "FIRE_SAFETY", "LOC-PMP"],
    ["Solar Inverter INV-2", "Huawei", "SUN2000", "POWER", "LOC-SOL"],
    ["Cooling Tower CT-1", "Baltimore", "VXT-25", "HVAC", "LOC-CHP"],
  ];
  for (const [i, e] of eqData.entries()) {
    equipment.push(await db.equipment.create({
      data: {
        assetTag: `EQ-${String(i + 1).padStart(4, "0")}`, name: e[0], manufacturer: e[1], model: e[2], category: e[3],
        serialNumber: `SN-${randomBytes(3).toString("hex").toUpperCase()}${1000 + i}`,
        locationId: locs.find((l) => l.code === e[4])!.id,
        customerId: customers[i % 3].id,
        installationDate: days(-400 - i * 30), warrantyExpiry: days(200 + i * 45),
        pmFrequencyDays: [30, 90, 60, 90, 180, 90, 365, 30][i],
        status: i === 3 ? "UNDER_MAINTENANCE" : "ACTIVE",
      },
    }));
  }

  // ── Tech profiles shortcuts ──
  const techs: TechnicianProfile[] = await db.technicianProfile.findMany({ include: { user: true } });

  // ── Complaints (workflow spread) ──
  const complaints: Complaint[] = [];
  const cmpData: [string, string, string, number, number, string, number][] = [
    ["Water leaking from AHU-3 ceiling diffuser", "Tenants report water dripping near unit A3-12 corridor. Floor is wet, hazard slip risk.", "HIGH", 0, 1, "ASSIGNED", -2],
    ["Chiller 1 tripping on high pressure alarm", "Chiller trips every afternoon around 2-3pm. Display shows HP alarm code E-42.", "URGENT", 1, 2, "IN_PROGRESS", -4],
    ["Lift L-04 door closes too fast", "Door closing interval seems shorter; nearly caught a resident today.", "MEDIUM", 2, 0, "NEW", -1],
    ["Generator DG-1 monthly test failed", "Generator failed auto-start during scheduled monthly test run.", "HIGH", 0, 0, "COMPLETED", -8],
    ["Low water pressure at level 6 washrooms", "Pressure noticeably weak since yesterday morning.", "MEDIUM", 1, 2, "CONFIRMED", -12],
    ["Corridor light flickering near entrance", "Tube light flickers continuously, disturbing visitors.", "LOW", 2, 1, "CLOSED", -20],
  ];
  for (const [i, c] of cmpData.entries()) {
    const created = at(c[6], 9 + i);
    const st = c[5];
    const cmp = await db.complaint.create({
      data: {
        code: `CPT-2025-${String(i + 1).padStart(4, "0")}`,
        customerId: customers[c[3]].id, equipmentId: equipment[c[4]].id,
        title: c[0] as string, description: c[1] as string, priority: c[2] as string,
        status: st as string, createdById: portalUserIds[c[3]] ?? null,
        assignedTechnicianId: st !== "NEW" ? techs[i % 3].id : null,
        assignedAt: st !== "NEW" ? days(c[6] + 1) : null,
        acceptedAt: ["IN_PROGRESS", "COMPLETED", "CONFIRMED", "CLOSED"].includes(st) ? days(c[6] + 1) : null,
        startedAt: ["IN_PROGRESS", "COMPLETED", "CONFIRMED", "CLOSED"].includes(st) ? days(c[6] + 1) : null,
        completedAt: ["COMPLETED", "CONFIRMED", "CLOSED"].includes(st) ? days(c[6] + 3) : null,
        confirmedAt: ["CONFIRMED", "CLOSED"].includes(st) ? days(c[6] + 4) : null,
        closedAt: st === "CLOSED" ? days(c[6] + 5) : null,
        resolutionNotes: ["COMPLETED", "CONFIRMED", "CLOSED"].includes(st) ? "Replaced faulty component, tested, and cleaned the unit. Verified normal operation." : "",
        customerFeedback: st === "CLOSED" ? "Fixed quickly, thank you." : "",
        customerRating: st === "CLOSED" ? 5 : null,
        createdAt: created, updatedAt: created,
      },
    });
    const hist: { fromStatus: string; toStatus: string; createdAt: Date }[] = [{ fromStatus: "NEW", toStatus: "NEW", createdAt: created }];
    if (st !== "NEW") hist.push({ fromStatus: "NEW", toStatus: "ASSIGNED", createdAt: days(c[6] + 1) });
    if (["IN_PROGRESS", "COMPLETED", "CONFIRMED", "CLOSED"].includes(st)) hist.push({ fromStatus: "ASSIGNED", toStatus: "IN_PROGRESS", createdAt: days(c[6] + 1) });
    if (["COMPLETED", "CONFIRMED", "CLOSED"].includes(st)) hist.push({ fromStatus: "IN_PROGRESS", toStatus: "COMPLETED", createdAt: days(c[6] + 3) });
    if (["CONFIRMED", "CLOSED"].includes(st)) hist.push({ fromStatus: "COMPLETED", toStatus: "CONFIRMED", createdAt: days(c[6] + 4) });
    if (st === "CLOSED") hist.push({ fromStatus: "CONFIRMED", toStatus: "CLOSED", createdAt: days(c[6] + 5) });
    for (const h of hist) {
      await db.complaintStatusHistory.create({ data: { complaintId: cmp.id, fromStatus: h.fromStatus, toStatus: h.toStatus, createdAt: h.createdAt } });
    }
    complaints.push(cmp);
  }

  // ── Work orders (for completed/confirmed complaints + standalone PM repair) ──
  const woChecklist = ["Isolate & secure work area", "Diagnose fault", "Carry out repair", "Function test", "Clean up & handover"];
  const wos: WorkOrder[] = [];
  const woSrc: [number, number, string, string, number][] = [
    [3, 0, "DG-1 auto-start failure repair", "COMPLETED", 2.5],
    [4, 2, "Booster pump low pressure service", "COMPLETED", 1.5],
    [0, 1, "Chiller HP alarm diagnosis", "IN_PROGRESS", 0],
    [5, 1, "Corridor light replacement", "COMPLETED", 0.5],
  ] as const;
  for (const [i, w] of woSrc.entries()) {
    const cmp = complaints[w[0]];
    const tech = techs[w[1]];
    const labourHours = w[4];
    const labourRate = tech.hourlyRateCents;
    const labourTotal = Math.round(labourHours * labourRate);
    const materials = i === 0 ? [{ name: "Starter battery 12V", qty: 1, cost: 38000 }] : i === 1 ? [{ name: "Pressure valve kit", qty: 1, cost: 12500 }] : i === 3 ? [{ name: "LED tube 4ft", qty: 2, cost: 1800 }] : [];
    const materialsTotal = materials.reduce((s, m) => s + m.qty * m.cost, 0);
    const wo = await db.workOrder.create({
      data: {
        code: `WO-2025-${String(i + 1).padStart(4, "0")}`,
        complaintId: cmp.id, customerId: cmp.customerId, equipmentId: cmp.equipmentId,
        technicianId: tech.id, title: w[2], description: `Rectification for ${cmp.code}`, priority: cmp.priority,
        status: w[3], scheduledDate: days(-6 + i), startedAt: ["IN_PROGRESS", "COMPLETED"].includes(w[3]) ? days(-6 + i) : null,
        completedAt: w[3] === "COMPLETED" ? days(-3 + i) : null,
        labourHours, labourRateCents: labourRate, labourTotalCents: labourTotal,
        materialsTotalCents: materialsTotal, totalCents: labourTotal + materialsTotal,
        customerConfirmed: w[3] === "COMPLETED", confirmedAt: w[3] === "COMPLETED" ? days(-3 + i) : null,
      },
    });
    for (const [ci, label] of woChecklist.entries()) {
      await db.workOrderChecklistItem.create({ data: { workOrderId: wo.id, label, done: w[3] === "COMPLETED", doneAt: w[3] === "COMPLETED" ? days(-3 + i) : null, sortOrder: ci } });
    }
    for (const m of materials) {
      await db.workOrderMaterial.create({ data: { workOrderId: wo.id, name: m.name, quantity: m.qty, unit: "pcs", unitCostCents: m.cost, totalCents: m.qty * m.cost } });
    }
    wos.push(wo);
  }

  // ── PM plans & tasks ──
  const pmChecklists: Record<string, string[]> = {
    HVAC: ["Clean/replace filters", "Check refrigerant pressure", "Inspect belts & bearings", "Test safety controls", "Record readings"],
    PLUMBING: ["Inspect pump seals", "Check pressure readings", "Lubricate bearings", "Test auto-start"],
    POWER: ["Check fuel & oil levels", "Test auto-start", "Inspect battery charger", "Log voltage readings"],
  };
  const pmPlanDefs = [
    ["Chiller quarterly service", 0, "QUARTERLY", 0],
    ["AHU monthly maintenance", 1, "MONTHLY", 1],
    ["Booster pump 2-monthly PM", 2, "MONTHLY", 2],
    ["Generator annual overhaul", 3, "SEMI_ANNUAL", 0],
    ["Cooling tower monthly clean", 7, "MONTHLY", 1],
  ] as const;
  for (const [i, p] of pmPlanDefs.entries()) {
    const eq = equipment[p[1]];
    await db.pmPlan.create({
      data: {
        code: `PM-2025-${String(i + 1).padStart(4, "0")}`, name: p[0], equipmentId: eq.id,
        frequency: p[2], assignedTechnicianId: techs[p[3]].id,
        checklistTemplate: JSON.stringify(pmChecklists[eq.category] ?? pmChecklists.HVAC),
        nextDueDate: days([5, 12, 3, 60, 9][i]),
        lastCompletedAt: i % 2 === 0 ? days(-FREQ(p[2]) + 10) : null,
      },
    });
  }
  function FREQ(f: string): number { return { WEEKLY: 7, MONTHLY: 30, QUARTERLY: 90, SEMI_ANNUAL: 182, ANNUAL: 365 }[f] ?? 30; }
  const plans = await db.pmPlan.findMany();
  const taskStates = ["SCHEDULED", "OVERDUE", "COMPLETED", "SCHEDULED", "IN_PROGRESS"] as const;
  for (const [i, plan] of plans.entries()) {
    const st = taskStates[i];
    const task = await db.pmTask.create({
      data: {
        code: `PMT-2025-${String(i + 1).padStart(4, "0")}`, planId: plan.id, equipmentId: plan.equipmentId,
        technicianId: plan.assignedTechnicianId, dueDate: days([-3, -1, -20, 12, 2][i]),
        status: st, completedAt: st === "COMPLETED" ? days(-19) : null,
        notes: st === "COMPLETED" ? "All checklist items verified, readings normal." : "",
      },
    });
    const labels = JSON.parse(plan.checklistTemplate) as string[];
    for (const [li, label] of labels.entries()) {
      await db.pmTaskChecklistItem.create({ data: { taskId: task.id, label, done: st === "COMPLETED", sortOrder: li } });
    }
  }

  // ── Suppliers & Inventory ──
  const suppliers: Supplier[] = [];
  for (const [i, s] of (["CoolTech Supplies Sdn Bhd|Sally Chong", "AquaFlow Trading|Mohd Rizal", "Powerline Enterprises|Vince Lau"].map((x) => x.split("|")) as [string, string][]).entries()) {
    suppliers.push(await db.supplier.create({ data: { code: `SUP-${String(i + 1).padStart(3, "0")}`, name: s[0], contactPerson: s[1], email: `sales@${["cooltech", "aquaflow", "powerline"][i]}.my`, phone: `+60 3-55${i}9 20${i}0`, address: `Lot ${i + 2}, Jalan Industry ${i + 1}, Shah Alam` } }));
  }
  const items: InventoryItem[] = [];
  const itemDefs: [string, string, string, string, number, number, number][] = [
    ["HVF-202", "HV Air Filter 20x25", "FILTERS", "pcs", 40, 10, 2500],
    ["BLT-401", "V-Belt A45", "SPARES", "pcs", 24, 12, 950],
    ["RFR-134", "Refrigerant R134a", "CONSUMABLES", "kg", 18, 20, 6800],
    ["LED-4F", "LED Tube 4ft 18W", "ELECTRICAL", "pcs", 120, 30, 900],
    ["VLV-PR", "Pressure Valve Kit", "SPARES", "set", 6, 5, 12500],
    ["GRS-1L", "Machine Grease 1L", "CONSUMABLES", "btl", 15, 8, 2100],
    ["BTR-12V", "Starter Battery 12V", "ELECTRICAL", "pcs", 4, 3, 38000],
    ["PMP-SL", "Pump Seal Kit CR-15", "SPARES", "set", 3, 4, 8900],
    ["CBL-3C", "3-Core Cable 2.5mm", "ELECTRICAL", "m", 250, 50, 420],
    ["FLT-AF", "Activated Carbon Filter", "FILTERS", "pcs", 9, 10, 3200],
  ] as const;
  for (const [i, it] of itemDefs.entries()) {
    items.push(await db.inventoryItem.create({
      data: { sku: it[0], name: it[1], category: it[2], unit: it[3], stockQty: it[4], minStockQty: it[5], unitCostCents: it[6], supplierId: suppliers[i % 3].id },
    }));
    await db.stockMovement.create({ data: { itemId: items[i].id, type: "RECEIVE", quantity: it[4], balanceAfter: it[4], referenceType: "MANUAL", note: "Opening stock", createdById: admin.id } });
  }

  // ── Purchase order ──
  const poItems = [
    { item: items[2], qty: 24, cost: 6800 },
    { item: items[7], qty: 6, cost: 8900 },
    { item: items[9], qty: 10, cost: 3200 },
  ];
  const poSubtotal = poItems.reduce((s, p) => s + p.qty * p.cost, 0);
  const po = await db.purchaseOrder.create({
    data: {
      code: "PO-2025-0001", supplierId: suppliers[0].id, orderDate: days(-9), expectedDate: days(-4),
      status: "APPROVED", subtotalCents: poSubtotal, taxCents: Math.round(poSubtotal * 0.06),
      totalCents: Math.round(poSubtotal * 1.06), notes: "Urgent restock for chiller maintenance season.",
      approvedById: admin.id, approvedAt: days(-8),
    },
  });
  for (const p of poItems) {
    await db.purchaseItem.create({ data: { poId: po.id, itemId: p.item.id, description: p.item.name, quantity: p.qty, unitCostCents: p.cost, totalCents: p.qty * p.cost } });
  }

  // ── Quotation ──
  const qItems = [
    { kind: "MATERIAL", desc: "HV Air Filter 20x25 (bulk)", qty: 40, unit: "pcs", price: 3200, disc: 5, tax: 6 },
    { kind: "LABOUR", desc: "AHU deep-cleaning service — 2 technicians", qty: 8, unit: "hr", price: 6500, disc: 0, tax: 6 },
    { kind: "SERVICE", desc: "Quarterly preventive maintenance package", qty: 1, unit: "pkg", price: 145000, disc: 0, tax: 6 },
  ];
  const qSub = qItems.reduce((s, q) => s + Math.round(q.qty * q.price * (1 - q.disc / 100)), 0);
  const qTax = Math.round(qSub * 0.06);
  const quotation = await db.quotation.create({
    data: {
      code: "QTN-2025-0001", customerId: customers[0].id, quotationDate: days(-6), validUntil: days(24),
      status: "SENT", subtotalCents: qSub, taxCents: qTax, totalCents: qSub + qTax,
      labourCostCents: Math.round(8 * 6500), materialCostCents: 40 * 2500,
      notes: "Prices valid for 30 days. Includes material and labour.",
      terms: "1. Payment within 30 days.\n2. Rates include SST where applicable.\n3. Work carried out during mall off-hours (12am-6am).",
      createdById: admin.id,
    },
  });
  for (const q of qItems) {
    await db.quotationItem.create({ data: { quotationId: quotation.id, kind: q.kind, description: q.desc, quantity: q.qty, unit: q.unit, unitPriceCents: q.price, discountPercent: q.disc, taxPercent: q.tax, totalCents: Math.round(q.qty * q.price * (1 - q.disc / 100)) } });
  }

  // ── Invoice + payment (from confirmed complaint WO chain) ──
  const invItems = [
    { kind: "MATERIAL", desc: "Starter battery 12V", qty: 1, unit: "pcs", price: 38000 },
    { kind: "LABOUR", desc: "Generator rectification labour", qty: 2.5, unit: "hr", price: 5500 },
  ];
  const invSub = invItems.reduce((s, q) => s + Math.round(q.qty * q.price), 0);
  const invTax = Math.round(invSub * 0.06);
  const invoice = await db.invoice.create({
    data: {
      code: "INV-2025-0001", customerId: customers[0].id, workOrderId: wos[0].id, complaintId: complaints[3].id,
      invoiceDate: days(-2), dueDate: days(28), status: "PARTIALLY_PAID",
      subtotalCents: invSub, taxCents: invTax, totalCents: invSub + invTax,
      paidCents: 20000, balanceCents: invSub + invTax - 20000,
      notes: "Thank you for your business.", terms: "Payment due within 30 days of invoice date.",
      sentAt: days(-2), createdById: admin.id,
    },
  });
  for (const q of invItems) {
    await db.invoiceItem.create({ data: { invoiceId: invoice.id, kind: q.kind, description: q.desc, quantity: q.qty, unit: q.unit, unitPriceCents: q.price, taxPercent: 6, totalCents: Math.round(q.qty * q.price) } });
  }
  await db.payment.create({ data: { code: "PAY-2025-0001", invoiceId: invoice.id, customerId: customers[0].id, amountCents: 20000, method: "BANK_TRANSFER", reference: "MBB-889201", paidAt: days(-1), recordedById: financeUser.id, note: "Part payment" } });
  await db.workOrder.update({ where: { id: wos[0].id }, data: { invoiceId: invoice.id } });

  // Second invoice (fully paid, from CONFIRMED complaint)
  const inv2Items = [
    { kind: "MATERIAL", desc: "Pressure valve kit", qty: 1, unit: "set", price: 12500 },
    { kind: "LABOUR", desc: "Booster pump service labour", qty: 1.5, unit: "hr", price: 6000 },
  ];
  const inv2Sub = inv2Items.reduce((s, q) => s + Math.round(q.qty * q.price), 0);
  const inv2Tax = Math.round(inv2Sub * 0.06);
  const inv2 = await db.invoice.create({
    data: {
      code: "INV-2025-0002", customerId: customers[1].id, complaintId: complaints[4].id,
      invoiceDate: days(-10), dueDate: days(20), status: "PAID",
      subtotalCents: inv2Sub, taxCents: inv2Tax, totalCents: inv2Sub + inv2Tax,
      paidCents: inv2Sub + inv2Tax, balanceCents: 0, sentAt: days(-10), createdById: admin.id,
    },
  });
  for (const q of inv2Items) {
    await db.invoiceItem.create({ data: { invoiceId: inv2.id, kind: q.kind, description: q.desc, quantity: q.qty, unit: q.unit, unitPriceCents: q.price, taxPercent: 6, totalCents: Math.round(q.qty * q.price) } });
  }
  await db.payment.create({ data: { code: "PAY-2025-0002", invoiceId: inv2.id, customerId: customers[1].id, amountCents: inv2Sub + inv2Tax, method: "CASH", reference: "CASH-R004", paidAt: days(-9), recordedById: financeUser.id } });

  // ── Finance accounts & transactions ──
  const bank = await db.account.create({ data: { code: "ACC-BANK", name: "Maybank Current Account", type: "BANK", balanceCents: 48250000 } });
  const cash = await db.account.create({ data: { code: "ACC-CASH", name: "Petty Cash", type: "CASH", balanceCents: 350000 } });
  await db.transaction.create({ data: { code: "TRX-2025-0001", type: "INCOME", category: "SERVICE_INCOME", description: "Payment INV-2025-0001", amountCents: 20000, accountId: bank.id, date: days(-1), referenceType: "PAYMENT", createdById: financeUser.id } });
  await db.transaction.create({ data: { code: "TRX-2025-0002", type: "INCOME", category: "SERVICE_INCOME", description: "Payment INV-2025-0002", amountCents: inv2Sub + inv2Tax, accountId: bank.id, date: days(-9), referenceType: "PAYMENT", createdById: financeUser.id } });
  await db.transaction.create({ data: { code: "TRX-2025-0003", type: "EXPENSE", category: "MATERIALS", description: "Diesel for generator tests", amountCents: 42000, accountId: cash.id, date: days(-7), referenceType: "EXPENSE", createdById: financeUser.id } });
  await db.expense.create({ data: { code: "EXP-2025-0001", category: "FUEL", description: "Diesel for generator tests", amountCents: 42000, expenseDate: days(-7), status: "APPROVED", approvedById: admin.id, createdById: financeUser.id } });

  // ── HR ──
  const deptIT = await db.department.create({ data: { name: "Field Operations", description: "Technicians and field crews" } });
  const deptAdmin = await db.department.create({ data: { name: "Administration", description: "Office and management" } });
  const empDefs = [
    ["Ahmad", "Faizal", deptIT.id, "Senior HVAC Technician", 320000],
    ["Lim", "Wei Cheng", deptIT.id, "Plumbing Technician", 280000],
    ["Rajesh", "Kumar", deptIT.id, "Electrical Technician", 290000],
    ["Nurul", "Hidayah", deptAdmin.id, "Office Administrator", 260000],
  ];
  const employees: Employee[] = [];
  for (const [i, e] of (empDefs as [string, string, string, string, number][]).entries()) {
    const linked = i < 3 ? techUsers[i].id : null;
    employees.push(await db.employee.create({
      data: {
        employeeNo: `EMP-${String(i + 1).padStart(3, "0")}`, userId: linked, firstName: e[0], lastName: e[1],
        departmentId: e[2], position: e[3], email: i < 3 ? techUsers[i].email : "nurul@mohdhms.com",
        phone: `+60 12-345 67${i}0`, joinDate: days(-700 + i * 60), salaryCents: e[4], status: "ACTIVE",
      },
    }));
  }
  for (let d = 0; d < 7; d++) {
    for (const [ei, emp] of employees.entries()) {
      const st = (d + ei) % 9 === 0 ? "LEAVE" : (d + ei) % 11 === 0 ? "ABSENT" : (d + ei) % 7 === 0 ? "HALF_DAY" : "PRESENT";
      await db.attendance.create({ data: { employeeId: emp.id, date: days(-d), status: st, checkIn: st === "PRESENT" || st === "HALF_DAY" ? at(-d, 8, 5) : null, checkOut: st === "PRESENT" ? at(-d, 17, 10) : st === "HALF_DAY" ? at(-d, 13, 0) : null } });
    }
  }
  await db.leaveRequest.create({ data: { employeeId: employees[1].id, type: "ANNUAL", startDate: days(14), endDate: days(18), days: 5, reason: "Family holiday", status: "PENDING" } });
  await db.leaveRequest.create({ data: { employeeId: employees[2].id, type: "SICK", startDate: days(-5), endDate: days(-4), days: 2, reason: "Fever", status: "APPROVED", approvedById: hrUser.id, approvedAt: days(-5) } });

  // ── IRMS ──
  const proj = await db.irmsProject.create({
    data: {
      code: "PRJ-2025-0001", name: "Sunrise Mall Annual Facility Audit", customerId: customers[0].id,
      siteLocation: "Sunrise Mall, Bukit Bintang", description: "Comprehensive annual inspection of HVAC, electrical, plumbing and fire safety systems.",
      status: "ACTIVE", startDate: days(-30), endDate: days(30),
    },
  });
  const proj2 = await db.irmsProject.create({
    data: { code: "PRJ-2025-0002", name: "Greenview Hospital Safety Inspection", customerId: customers[1].id, siteLocation: "Greenview Hospital, PJ", description: "Quarterly safety and compliance inspection.", status: "ACTIVE", startDate: days(-10), endDate: days(50) },
  });
  const rep1 = await db.inspectionReport.create({
    data: {
      code: "INS-2025-0001", projectId: proj.id, equipmentId: equipment[0].id, title: "Chiller Plant Quarterly Inspection",
      type: "EQUIPMENT", inspectionDate: days(-15), inspectorId: techs[0].id, status: "APPROVED",
      summary: "Chiller operating within normal parameters. Minor corrosion observed on condenser pipes.",
      overallCondition: "GOOD", recommendations: "Schedule condenser pipe re-coating within next quarter. Continue quarterly vibration analysis.",
    },
  });
  await db.inspectionFinding.createMany({ data: [
    { reportId: rep1.id, finding: "Corrosion patches on condenser inlet pipe", severity: "MEDIUM", recommendation: "Re-coat with marine-grade epoxy" },
    { reportId: rep1.id, finding: "Refrigerant pressure slightly above nominal", severity: "LOW", recommendation: "Monitor at next PM cycle" },
    { reportId: rep1.id, finding: "Insulation degraded on 2 pipe sections", severity: "HIGH", recommendation: "Replace insulation within 30 days" },
  ] });
  const rep2 = await db.inspectionReport.create({
    data: { code: "INS-2025-0002", projectId: proj2.id, equipmentId: equipment[5].id, title: "Fire Pump Compliance Check", type: "SAFETY", inspectionDate: days(-3), inspectorId: techs[2].id, status: "SUBMITTED", summary: "Fire pump jockey pressure switch requires calibration.", overallCondition: "FAIR", recommendations: "Calibrate pressure switch and retest churn pressure." },
  });
  await db.inspectionFinding.create({ data: { reportId: rep2.id, finding: "Jockey pump pressure switch out of calibration", severity: "HIGH", recommendation: "Calibrate and retest" } });

  // ── Vehicles ──
  await db.vehicle.create({ data: { code: "VEH-001", registrationNo: "WXY 1234", make: "Toyota", model: "Hilux", type: "PICKUP", assignedTechnicianId: techs[0].id, status: "IN_USE", odometer: 88450, lastServiceDate: days(-60), nextServiceDue: days(30) } });
  await db.vehicle.create({ data: { code: "VEH-002", registrationNo: "WAB 5678", make: "Proton", model: "Saga", type: "CAR", status: "AVAILABLE", odometer: 45200, lastServiceDate: days(-25), nextServiceDue: days(65) } });
  await db.vehicle.create({ data: { code: "VEH-003", registrationNo: "WVW 9012", make: "Isuzu", model: "NPR", type: "TRUCK", status: "MAINTENANCE", odometer: 120300, lastServiceDate: days(-2), nextServiceDue: days(88) } });

  // ── Settings ──
  const settings: Record<string, string> = {
    company_name: "MOHD.HMS Enterprise",
    company_email_info: "info@mohdhms.com",
    company_email_sales: "sales@mohdhms.com",
    company_email_service: "service@mohdhms.com",
    company_email_finance: "finance@mohdhms.com",
    company_email_hr: "hr@mohdhms.com",
    company_email_procurement: "procurement@mohdhms.com",
    company_email_inspection: "inspection@mohdhms.com",
    company_phone: "+60 3-8080 9000",
    company_address: "22 Jalan Enterprise, 47100 Shah Alam, Selangor",
    invoice_terms: "Payment due within 30 days of invoice date. Late payments incur 1.5% monthly interest.",
    quotation_terms: "Quotation valid for 30 days unless otherwise stated. Prices subject to change after validity.",
    tax_percent_default: "6",
    currency: "MYR",
    public_url: "https://www.mohdhms.com",
    // Legal (Terms & Conditions): customers are asked to accept the current
    // version in the portal before using it (toggle in Settings → Legal).
    terms_acceptance_required: "true",
  };
  for (const [key, value] of Object.entries(settings)) {
    await db.setting.create({ data: { key, value } });
  }

  // ── Notifications ──
  await db.notification.createMany({ data: [
    { userId: superAdmin.id, type: "WARNING", title: "Low stock alert", message: "3 inventory items are at or below minimum stock level.", resourceType: "INVENTORY" },
    { userId: superAdmin.id, type: "INFO", title: "New complaint assigned", message: "CPT-2025-0001 water leak assigned to Ahmad Faizal.", resourceType: "COMPLAINT", resourceId: complaints[0].id },
    { userId: supervisor.id, type: "WARNING", title: "PM task overdue", message: "PMT-2025-0002 AHU monthly maintenance is overdue.", resourceType: "PM_TASK" },
    { userId: techUsers[0].id, type: "INFO", title: "New work assigned", message: "Chiller HP alarm diagnosis assigned to you.", resourceType: "COMPLAINT", resourceId: complaints[1].id },
    { userId: portalUserIds[0], type: "INFO", title: "Complaint update", message: "Your complaint CPT-2025-0001 has been assigned to a technician.", resourceType: "COMPLAINT", resourceId: complaints[0].id },
    { userId: financeUser.id, type: "SUCCESS", title: "Payment received", message: "Part payment received for INV-2025-0001.", resourceType: "INVOICE", resourceId: invoice.id },
  ] });

  // ── Audit trail ──
  await db.auditLog.createMany({ data: [
    { actorId: superAdmin.id, actorEmail: superAdmin.email, action: "SYSTEM_SEED", resourceType: "SYSTEM", metadata: JSON.stringify({ source: "seed", version: "1.0" }) },
    { actorId: admin.id, actorEmail: admin.email, action: "INVOICE_SENT", resourceType: "INVOICE", resourceId: invoice.id },
    { actorId: supervisor.id, actorEmail: supervisor.email, action: "COMPLAINT_ASSIGNED", resourceType: "COMPLAINT", resourceId: complaints[0].id, metadata: JSON.stringify({ technician: "Ahmad Faizal" }) },
  ] });

  // counters
  await counter("CPT", 6); await counter("WO", 4); await counter("PM", 5); await counter("PMT", 5);
  await counter("QTN", 1); await counter("INV", 2); await counter("PAY", 2); await counter("PO", 1);
  await counter("TRX", 3); await counter("EXP", 1); await counter("INS", 2); await counter("PRJ", 2);

  console.log("Seed complete.");
  console.log("Logins (password Password@123):");
  console.log("  admin@mohdhms.com (SUPER_ADMIN) / operations@mohdhms.com (ADMIN) / supervisor@mohdhms.com (SUPERVISOR)");
  console.log("  ahmad.tech@mohdhms.com (TECHNICIAN) / finance@mohdhms.com (FINANCE) / hr@mohdhms.com (HR) / customer1@demo.my (CUSTOMER)");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
