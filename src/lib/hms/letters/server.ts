// MOHD.HMS ENTERPRISE — Letters: server-side helpers shared by the API routes.
//
// DTO mapping, template snapshot/serialization and the required-field
// validation that must pass BEFORE any AI generation is attempted (§12 —
// missing required data is reported, never invented).

import "server-only";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import type { LetterTemplate } from "@prisma/client";
import type {
  LetterDetailDto,
  LetterListItemDto,
  LetterTemplateDto,
  LetterTemplateVersionDto,
  TemplateField,
} from "./shared";

// ── Template serialization ──

/** Content-bearing fields captured in every version snapshot (§27). */
export type TemplateContentSnapshot = {
  name: string;
  letterType: string;
  subjectHint: string;
  aiInstructions: string;
  bodyTemplate: string;
  closingTemplate: string;
  fields: TemplateField[];
  pageSize: string;
  language: string;
};

export function templateSnapshot(t: LetterTemplate): TemplateContentSnapshot {
  return {
    name: t.name,
    letterType: t.letterType,
    subjectHint: t.subjectHint,
    aiInstructions: t.aiInstructions,
    bodyTemplate: t.bodyTemplate,
    closingTemplate: t.closingTemplate,
    fields: safeParseFields(t.fieldsJson),
    pageSize: t.pageSize,
    language: t.language,
  };
}

export function safeParseFields(json: string): TemplateField[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? (parsed as TemplateField[]) : [];
  } catch {
    return [];
  }
}

export function safeParseData(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function templateToDto(t: LetterTemplate & { _count?: { letters: number } }): LetterTemplateDto {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    letterType: t.letterType,
    description: t.description,
    department: t.department,
    version: t.version,
    status: t.status,
    language: t.language,
    pageSize: t.pageSize,
    isDefault: t.isDefault,
    effectiveDate: t.effectiveDate?.toISOString() ?? null,
    aiInstructions: t.aiInstructions,
    subjectHint: t.subjectHint,
    bodyTemplate: t.bodyTemplate,
    closingTemplate: t.closingTemplate,
    fields: safeParseFields(t.fieldsJson),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    ...(t._count ? { lettersCount: t._count.letters } : {}),
  };
}

export function versionToDto(v: { id: string; version: number; createdByName: string; createdAt: Date }): LetterTemplateVersionDto {
  return {
    id: v.id,
    version: v.version,
    createdByName: v.createdByName,
    createdAt: v.createdAt.toISOString(),
  };
}

// ── Letter DTOs ──

type LetterWithRelations = {
  id: string;
  letterNumber: string;
  letterType: string;
  status: string;
  templateId: string | null;
  templateVersion: number;
  letterDate: Date;
  dataJson: string;
  bodySlot: string;
  subject: string;
  body: string;
  salutation: string;
  closing: string;
  contentSource: string;
  recipientName: string;
  recipientCompany: string;
  employeeId: string | null;
  signatoryName: string;
  signatoryPosition: string;
  signatorySignatureKey: string;
  pdfObjectKey: string;
  finalizedAt: Date | null;
  approvedByName: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  createdByName: string;
  template?: { code: string; name: string; fieldsJson: string } | null;
  employee?: { firstName: string; lastName: string } | null;
};

export function letterListItemDto(l: LetterWithRelations): LetterListItemDto {
  return {
    id: l.id,
    letterNumber: l.letterNumber,
    letterType: l.letterType,
    status: l.status,
    subject: l.subject,
    recipientName: l.recipientName,
    recipientCompany: l.recipientCompany,
    employeeName: l.employee ? `${l.employee.firstName} ${l.employee.lastName}` : null,
    department: "",
    letterDate: l.letterDate.toISOString(),
    contentSource: l.contentSource,
    createdAt: l.createdAt.toISOString(),
    createdByName: l.createdByName,
    approvedByName: l.approvedByName,
    finalizedAt: l.finalizedAt?.toISOString() ?? null,
    hasPdf: Boolean(l.pdfObjectKey),
  };
}

export function letterDetailDto(l: LetterWithRelations & { attachments?: { id: string; name: string; sizeBytes: number; mimeType: string; createdAt: Date }[]; events?: { id: string; action: string; detail: string; actorName: string; createdAt: Date }[] }): LetterDetailDto {
  return {
    id: l.id,
    letterNumber: l.letterNumber,
    letterType: l.letterType,
    status: l.status,
    templateId: l.templateId,
    templateCode: l.template?.code ?? "",
    templateName: l.template?.name ?? "",
    templateVersion: l.templateVersion,
    letterDate: l.letterDate.toISOString(),
    data: safeParseData(l.dataJson),
    bodySlot: l.bodySlot,
    subject: l.subject,
    body: l.body,
    salutation: l.salutation,
    closing: l.closing,
    contentSource: l.contentSource,
    recipientName: l.recipientName,
    recipientCompany: l.recipientCompany,
    employeeId: l.employeeId,
    employeeName: l.employee ? `${l.employee.firstName} ${l.employee.lastName}` : null,
    signatoryName: l.signatoryName,
    signatoryPosition: l.signatoryPosition,
    hasSignatureImage: Boolean(l.signatorySignatureKey),
    hasPdf: Boolean(l.pdfObjectKey),
    finalizedAt: l.finalizedAt?.toISOString() ?? null,
    approvedByName: l.approvedByName,
    approvedAt: l.approvedAt?.toISOString() ?? null,
    sentAt: l.sentAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
    createdByName: l.createdByName,
    fields: safeParseFields(l.template?.fieldsJson ?? ""),
    attachments: (l.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      sizeBytes: a.sizeBytes,
      mimeType: a.mimeType,
      createdAt: a.createdAt.toISOString(),
    })),
    events: (l.events ?? []).map((e) => ({
      id: e.id,
      action: e.action,
      detail: e.detail,
      actorName: e.actorName,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

// ── Required-field validation (§12) ──

export type MissingField = { key: string; label: string };

/** Returns the template's required fields that have no non-blank value. */
export function missingRequiredFields(fields: TemplateField[], data: Record<string, string>): MissingField[] {
  return fields
    .filter((f) => f.required)
    .filter((f) => !String(data[f.key] ?? "").trim())
    .map((f) => ({ key: f.key, label: f.label }));
}

/** 422 with the exact missing list — the AI never invents missing data (§12). */
export function assertRequiredFields(fields: TemplateField[], data: Record<string, string>): void {
  const missing = missingRequiredFields(fields, data);
  if (missing.length > 0) {
    throw Errors.badRequest(
      `Required information is missing: ${missing.map((m) => m.label).join(", ")}. AI generation will not invent missing details — please complete the highlighted fields.`,
      { missingFields: missing }
    );
  }
}

/** Load a letter with everything the API routes need; 404 when absent. */
export async function getLetterOr404(id: string) {
  const letter = await db.letter.findUnique({
    where: { id },
    include: {
      template: { select: { code: true, name: true, fieldsJson: true, department: true } },
      employee: { select: { firstName: true, lastName: true } },
      attachments: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!letter) throw Errors.notFound("Letter not found.");
  return letter;
}
