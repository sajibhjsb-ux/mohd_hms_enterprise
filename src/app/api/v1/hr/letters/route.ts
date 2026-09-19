// MOHD.HMS ENTERPRISE — HR Letters collection API (§8/§17/§29/§30/§31/§32).
//
//   GET  /api/v1/hr/letters  — history list with filters (§29/§30)
//   POST /api/v1/hr/letters  — create a letter from a template (§8):
//       template → structured data (required fields validated, §12) →
//       deterministic initial body → transactional reference number (§17) →
//       template snapshot captured (§27) → DRAFT.

import { z } from "zod";
import { db } from "@/lib/db";
import { handler, ok, okList, parseBody, listQuery, pagedMeta, Errors } from "@/lib/hms/api";
import { PERMISSIONS } from "@/lib/hms/constants";
import { getBranding } from "@/lib/hms/pdf/branding";
import { ensureLetterTemplatesBootstrapped } from "@/lib/hms/letters/bootstrap";
import { assertRequiredFields, letterListItemDto, safeParseFields, templateSnapshot } from "@/lib/hms/letters/server";
import { defaultSalutation, renderInitialBody, resolvePlaceholders, systemValues } from "@/lib/hms/letters/renderer";
import { bruneiYear, nextLetterNumber, serverLetterDate } from "@/lib/hms/letters/numbering";
import { audit } from "@/lib/hms/services";

// ── GET (history + filters) ────────────────────────────────────────────────

export const GET = handler(
  async ({ req }) => {
    await ensureLetterTemplatesBootstrapped();
    const q = listQuery(req);
    const sp = new URL(req.url).searchParams;
    const letterType = (sp.get("letterType") ?? "").trim();
    const employeeId = (sp.get("employeeId") ?? "").trim();
    const department = (sp.get("department") ?? "").trim();
    const from = (sp.get("from") ?? "").trim();
    const to = (sp.get("to") ?? "").trim();

    const where = {
      AND: [
        q.status ? { status: q.status } : {},
        letterType ? { letterType } : {},
        employeeId ? { employeeId } : {},
        department ? { template: { department } } : {},
        from || to
          ? {
              letterDate: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
              },
            }
          : {},
        q.search
          ? {
              OR: [
                { letterNumber: { contains: q.search } },
                { subject: { contains: q.search } },
                { recipientName: { contains: q.search } },
                { recipientCompany: { contains: q.search } },
                { createdByName: { contains: q.search } },
              ],
            }
          : {},
      ],
    };

    const [letters, total] = await Promise.all([
      db.letter.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: q.skip,
        take: q.take,
        include: {
          employee: { select: { firstName: true, lastName: true } },
        },
      }),
      db.letter.count({ where }),
    ]);
    return okList(letters.map(letterListItemDto), pagedMeta(q.page, q.pageSize, total));
  },
  { permission: PERMISSIONS.letters_view }
);

// ── POST (create from template) ────────────────────────────────────────────

const createSchema = z.object({
  templateId: z.string().min(1),
  employeeId: z.string().max(64).optional(),
  customerId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional(),
  quotationId: z.string().max(64).optional(),
  workOrderId: z.string().max(64).optional(),
  letterDate: z.string().datetime().optional(), // authorized users may adjust (§18)
  signatoryName: z.string().max(120).default(""),
  signatoryPosition: z.string().max(120).default(""),
  data: z.record(z.string(), z.string().max(8000)).default({}),
});

export const POST = handler(
  async ({ req, user }) => {
    const body = await parseBody(req, createSchema);

    const template = await db.letterTemplate.findUnique({ where: { id: body.templateId } });
    if (!template) throw Errors.notFound("Letter template not found.");
    if (template.status !== "ACTIVE") throw Errors.badRequest("This template is not active. Choose an active template.");

    // ── Structured data: user input + server-authoritative auto-population ──
    const data: Record<string, string> = { ...body.data };
    const fields = safeParseFields(template.fieldsJson);
    const hasField = (key: string) => fields.some((f) => f.key === key);
    const fillIfBlank = (key: string, value: string) => {
      if (hasField(key) && value && !String(data[key] ?? "").trim()) data[key] = value;
    };

    // Employee letters (§31): only approved HR fields auto-populate.
    let employeeName: string | null = null;
    if (body.employeeId) {
      const emp = await db.employee.findUnique({
        where: { id: body.employeeId },
        include: { department: { select: { name: true } } },
      });
      if (!emp) throw Errors.badRequest("Selected employee was not found.");
      employeeName = `${emp.firstName} ${emp.lastName}`;
      fillIfBlank("EMPLOYEE_NAME", employeeName);
      fillIfBlank("EMPLOYEE_ID", emp.employeeNo);
      fillIfBlank("EMPLOYEE_POSITION", emp.position);
      fillIfBlank("DEPARTMENT", emp.department?.name ?? "");
      if (emp.joinDate) fillIfBlank("START_DATE", emp.joinDate.toISOString());
      // Salary auto-fills ONLY for templates that declare a salary field and
      // only for authorized letter creators (permission-gated route) (§31).
      if (hasField("SALARY") && !String(data["SALARY"] ?? "").trim() && emp.salaryCents > 0) {
        data["SALARY"] = (emp.salaryCents / 100).toFixed(2);
      }
    }

    // Customer/project letters (§32): populate from existing related records.
    if (body.customerId) {
      const c = await db.customer.findUnique({ where: { id: body.customerId } });
      if (!c) throw Errors.badRequest("Selected customer was not found.");
      fillIfBlank("RECIPIENT_NAME", c.contactPerson);
      fillIfBlank("RECIPIENT_COMPANY", c.companyName || c.contactPerson);
      fillIfBlank("RECIPIENT_ADDRESS", [c.address, c.city].filter(Boolean).join("\n"));
    }
    if (body.projectId) {
      const p = await db.irmsProject.findUnique({ where: { id: body.projectId } });
      if (!p) throw Errors.badRequest("Selected project was not found.");
      fillIfBlank("PROJECT_NAME", p.name);
      fillIfBlank("PROJECT_REFERENCE", p.code);
    }
    if (body.quotationId) {
      const qt = await db.quotation.findUnique({ where: { id: body.quotationId } });
      if (!qt) throw Errors.badRequest("Selected quotation was not found.");
      fillIfBlank("PROJECT_REFERENCE", qt.code);
    }
    if (body.workOrderId) {
      const wo = await db.workOrder.findUnique({ where: { id: body.workOrderId } });
      if (!wo) throw Errors.badRequest("Selected work order was not found.");
      fillIfBlank("PROJECT_REFERENCE", wo.code);
      fillIfBlank("PROJECT_NAME", wo.title);
    }

    // §12 — required fields are enforced BEFORE anything is generated.
    assertRequiredFields(fields, data);

    const branding = await getBranding();
    const letterDate = body.letterDate ? new Date(body.letterDate) : serverLetterDate();

    // Signatory resolution: template SIGNATORY_* fields (data) take precedence,
    // then the explicit payload, then the creating user (HR prepares, §16).
    const signatoryName =
      (hasField("SIGNATORY_NAME") ? String(data["SIGNATORY_NAME"] ?? "").trim() : "") ||
      body.signatoryName.trim() ||
      user.name;
    const signatoryPosition =
      (hasField("SIGNATORY_POSITION") ? String(data["SIGNATORY_POSITION"] ?? "").trim() : "") ||
      body.signatoryPosition.trim();

    // ── Deterministic initial content (template owns the structure, §46) ──
    const snapshot = templateSnapshot(template);
    const values = systemValues({
      letterNumber: "(pending)",
      letterDate,
      branding,
      salutation: "",
      signatoryName,
      signatoryPosition,
      body: "",
    });
    // Resolved against the provided data so the draft subject never shows raw
    // {{PLACEHOLDERS}} (unfilled ones drop to blank instead).
    const initialSubject =
      resolvePlaceholders(template.subjectHint || "Official Letter", { ...values, ...data }).trim() || "Official Letter";
    const initialBody = renderInitialBody(snapshot, values, "");
    const salutation = defaultSalutation(data);

    // ── Transactional reference number + row creation (§17) ──
    const year = bruneiYear(letterDate);
    const letterNumber = await nextLetterNumber(template.letterType, template.department, year);

    let letter;
    try {
      letter = await db.letter.create({
        data: {
          letterNumber,
          letterType: template.letterType,
          templateId: template.id,
          templateVersion: template.version,
          templateSnapshotJson: JSON.stringify(snapshot),
          status: "DRAFT",
          contentSource: "TEMPLATE",
          letterDate,
          dataJson: JSON.stringify(data),
          bodySlot: "",
          subject: initialSubject,
          body: initialBody,
          salutation,
          closing: template.closingTemplate || "Yours faithfully,",
          recipientName: String(data["RECIPIENT_NAME"] ?? data["EMPLOYEE_NAME"] ?? "").trim(),
          recipientCompany: String(data["RECIPIENT_COMPANY"] ?? "").trim(),
          employeeId: body.employeeId || null,
          signatoryName,
          signatoryPosition,
          createdById: user.id,
          createdByName: user.name,
          updatedById: user.id,
          events: {
            create: {
              action: "CREATED",
              detail: `Created from template ${template.code} (v${template.version})`,
              actorId: user.id,
              actorName: user.name,
            },
          },
        },
      });
    } catch {
      // Unique-violation on a racing Counter allocation → honest conflict.
      throw Errors.conflict("Could not allocate the letter reference number. Please try again.");
    }

    await audit({
      actorId: user.id,
      actorEmail: user.email,
      action: "LETTER_CREATED",
      resourceType: "LETTER",
      resourceId: letter.id,
      metadata: { letterNumber, letterType: template.letterType, templateCode: template.code, templateVersion: template.version },
      ip: req.headers.get("x-forwarded-for") ?? "",
    });

    void employeeName;
    return ok({ id: letter.id, letterNumber }, 201);
  },
  { permission: PERMISSIONS.letters_create }
);
