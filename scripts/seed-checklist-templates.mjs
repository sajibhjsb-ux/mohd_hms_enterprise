// MOHD.HMS ENTERPRISE — Idempotent checklist template seed + legacy backfill.
// One CORRECTIVE template per required category plus GENERAL fallback.
// Existing templates are never duplicated: a category already represented by an
// active template (after canonical aliasing) is skipped.
import { PrismaClient } from "@prisma/client";

const CATEGORY_ALIASES = {
  POWER: "ELECTRICAL", ELEC: "ELECTRICAL", ELECTRIC: "ELECTRICAL",
  FIRE_SAFETY: "FIRE_PROTECTION", FIRE: "FIRE_PROTECTION",
  VERTICAL_TRANSPORT: "LIFT", ELEVATOR: "LIFT", LIFT_ESCALATOR: "LIFT",
  BUILDING_MAINTENANCE: "BUILDING", CIVIL_WORKS: "CIVIL", PEST: "PEST_CONTROL",
};
function canonicalize(raw) {
  const v = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return CATEGORY_ALIASES[v] ?? (v || "GENERAL");
}

const REQUIRED_CATEGORIES = [
  "HVAC", "ELECTRICAL", "PLUMBING", "FIRE_PROTECTION", "GENERATOR", "LIFT",
  "BUILDING", "CIVIL", "MECHANICAL", "PEST_CONTROL", "CLEANING", "LANDSCAPE", "GENERAL",
];

const templateData = {
  HVAC: {
    name: "HVAC Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for air-conditioning and ventilation faults.",
    items: [
      { label: "Confirm reported cooling issue with customer", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Inspect filter condition", required: true, responseType: "PASSFAIL", priority: "ROUTINE", failRequiresFinding: true },
      { label: "Record supply air temperature", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "°C" },
      { label: "Photograph outdoor unit nameplate", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Inspect condenser coils", required: true, responseType: "PASSFAIL", priority: "ROUTINE", failRequiresFinding: true },
      { label: "Measure refrigerant pressures", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "bar" },
      { label: "Inspect electrical connections", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Test thermostat calibration", required: false, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Check drain pan and condensate line", required: true, responseType: "PASSFAIL", priority: "ROUTINE", failRequiresFinding: true },
      { label: "Measure airflow at registers", required: false, responseType: "NUMERIC", priority: "ROUTINE", unit: "m³/h" },
      { label: "Inspect ductwork insulation", required: false, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Test safety controls", required: true, responseType: "PASSFAIL", priority: "SAFETY", safetyCritical: true, failRequiresFinding: true },
      { label: "Final commissioning test", required: true, responseType: "PASSFAIL", priority: "CRITICAL" },
      { label: "Record technician completion notes", required: false, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  ELECTRICAL: {
    name: "Electrical Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for lighting, power and distribution faults.",
    items: [
      { label: "Isolate supply before work", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Verify zero energy with tester", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Inspect circuit breakers and panels", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Measure supply voltage", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "V" },
      { label: "Check earth continuity", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Inspect cable terminations", required: true, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Test residual current device", required: true, responseType: "PASSFAIL", priority: "SAFETY", safetyCritical: true },
      { label: "Photograph label/circuit schedule", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Functional test after reinstatement", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Record test readings", required: false, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  PLUMBING: {
    name: "Plumbing Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for leaks, drains and sanitary work.",
    items: [
      { label: "Isolate water supply before work", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Locate and confirm leak source", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Inspect pipe condition and joints", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Test water pressure and flow", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "bar" },
      { label: "Clear drain or blockage", required: false, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Replace seals/washers", required: false, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Photograph repaired joint", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Pressure/leak test after reassembly", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Record final readings", required: false, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  FIRE_PROTECTION: {
    name: "Fire Protection Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for fire alarm, sprinkler and suppression systems.",
    items: [
      { label: "Confirm system status with facility owner", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Inspect fire alarm control panel", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Test smoke/heat detectors", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Inspect sprinkler heads and piping", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Test fire pump operation", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Check extinguisher pressure and tags", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Photograph panel and devices", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Record test results", required: true, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  GENERATOR: {
    name: "Generator Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for standby generator faults.",
    items: [
      { label: "Confirm generator status and load", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Check oil, coolant and fuel levels", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Inspect battery and starting system", required: true, responseType: "PASSFAIL", priority: "IMPORTANT" },
      { label: "Measure output voltage and frequency", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "V" },
      { label: "Inspect exhaust and cooling", required: true, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Run load test", required: false, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Photograph nameplate and readings", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Record test results", required: true, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  LIFT: {
    name: "Lift & Escalator Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for lift/escalator faults.",
    items: [
      { label: "Isolate lift power before work", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Confirm fault with building contact", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Inspect car doors and landing doors", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Inspect control panel and buttons", required: true, responseType: "PASSFAIL", priority: "IMPORTANT" },
      { label: "Run leveling and door tests", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Inspect machine room", required: true, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Photograph control panel and fault", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Record service notes", required: false, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
  BUILDING: {
    name: "Building Maintenance Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for walls, ceilings, doors and general fabric.",
    items: [
      { label: "Inspect reported defect area", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Check surrounding finishes", required: true, responseType: "PASSFAIL", priority: "ROUTINE", failRequiresFinding: true },
      { label: "Test door/window operation", required: false, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Photograph defect before repair", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Carry out repair", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Photograph completed repair", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Final inspection and sign-off", required: true, responseType: "PASSFAIL", priority: "CRITICAL" },
    ],
  },
  CIVIL: {
    name: "Civil Works Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for concrete, roofing and drainage civil work.",
    items: [
      { label: "Inspect reported civil defect", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Assess structural condition", required: true, responseType: "PASSFAIL", priority: "SAFETY", safetyCritical: true, failRequiresFinding: true },
      { label: "Check drainage and water ingress", required: true, responseType: "PASSFAIL", priority: "IMPORTANT" },
      { label: "Photograph defect", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Carry out civil repair", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Final stability inspection", required: true, responseType: "PASSFAIL", priority: "CRITICAL" },
    ],
  },
  MECHANICAL: {
    name: "Mechanical Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for pumps, motors, belts and mechanical drives.",
    items: [
      { label: "Isolate equipment before work", required: true, responseType: "CHECKBOX", priority: "SAFETY", safetyCritical: true },
      { label: "Inspect bearings and seals", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Check belt tension and alignment", required: true, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Measure motor current", required: true, responseType: "NUMERIC", priority: "ROUTINE", unit: "A" },
      { label: "Inspect lubrication", required: true, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Photograph nameplate and readings", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Run functional test", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
    ],
  },
  PEST_CONTROL: {
    name: "Pest Control Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for pest inspection and treatment.",
    items: [
      { label: "Confirm pest type and location", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Inspect harborage and entry points", required: true, responseType: "PASSFAIL", priority: "IMPORTANT", failRequiresFinding: true },
      { label: "Apply approved treatment", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Place traps/bait stations", required: false, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Photograph treatment areas", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Record pesticide used and quantity", required: true, responseType: "TEXT", priority: "ROUTINE" },
      { label: "Schedule follow-up inspection", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
    ],
  },
  CLEANING: {
    name: "Cleaning Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for cleaning and housekeeping faults.",
    items: [
      { label: "Inspect reported cleaning issue", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Check consumables stock", required: false, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Clean and disinfect area", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Photograph before and after", required: false, responseType: "CHECKBOX", priority: "ROUTINE", requiresPhoto: true },
      { label: "Final inspection sign-off", required: true, responseType: "PASSFAIL", priority: "CRITICAL" },
    ],
  },
  LANDSCAPE: {
    name: "Landscape Corrective",
    workType: "CORRECTIVE",
    description: "Standard corrective checklist for grounds, lawns and garden maintenance.",
    items: [
      { label: "Inspect reported grounds issue", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Mow/trim as required", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Check irrigation operation", required: false, responseType: "PASSFAIL", priority: "ROUTINE" },
      { label: "Remove green waste", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Final site inspection", required: true, responseType: "PASSFAIL", priority: "CRITICAL" },
    ],
  },
  GENERAL: {
    name: "General Corrective",
    workType: "CORRECTIVE",
    description: "Built-in fallback checklist used when no category template matches.",
    items: [
      { label: "Confirm reported fault and scope", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Identify root cause", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Perform approved corrective action", required: true, responseType: "CHECKBOX", priority: "IMPORTANT" },
      { label: "Functional test after work", required: true, responseType: "PASSFAIL", priority: "CRITICAL", failRequiresFinding: true },
      { label: "Clean work area", required: true, responseType: "CHECKBOX", priority: "ROUTINE" },
      { label: "Record final result and notes", required: true, responseType: "TEXT", priority: "ROUTINE" },
    ],
  },
};

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.checklistTemplate.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, category: true, workType: true },
  });
  const present = new Set(existing.map((t) => canonicalize(t.category)));
  const now = new Date();

  let created = 0;
  let skipped = 0;
  for (const category of REQUIRED_CATEGORIES) {
    if (present.has(category)) {
      skipped += 1;
      continue;
    }
    const data = templateData[category];
    if (!data) {
      throw new Error(`No template data defined for ${category}`);
    }
    await prisma.checklistTemplate.create({
      data: {
        name: data.name,
        category,
        workType: data.workType,
        description: data.description,
        items: JSON.stringify(data.items.map((it) => ({ ...it, origin: "TEMPLATE" }))),
        version: 1,
        status: "ACTIVE",
        approvalRequired: false,
        requiredPhotos: data.items.filter((i) => i.requiresPhoto).length,
        requiredFindings: data.items.filter((i) => i.failRequiresFinding).length,
      },
    });
    created += 1;
    present.add(category);
  }

  // Backfill legacy completed rows done=true -> COMPLETED without losing doneAt.
  const backfill = await prisma.workOrderChecklistItem.updateMany({
    where: { done: true, status: "PENDING" },
    data: { status: "COMPLETED", doneAt: now },
  });

  console.log(JSON.stringify({
    created, skipped, total: REQUIRED_CATEGORIES.length,
    backfill: { matched: backfill.count, note: "done=true rows set to COMPLETED" },
  }, null, 2));
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { await prisma.$disconnect(); throw e; });
