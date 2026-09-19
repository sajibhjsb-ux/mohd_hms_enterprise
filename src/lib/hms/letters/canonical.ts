// MOHD.HMS ENTERPRISE — Canonical letter templates (v1.0 bootstrap content).
//
// ONE canonical source for the initial template catalog (like legal/canonical).
// `bootstrap.ts` seeds these idempotently — only when the catalog is empty — so
// fresh installs start with a professional, production-usable template set and
// admins edit/duplicate/extend from there (§4: extensible without rewrites).
//
// Content rules baked into every template:
//  - The body skeleton is DETERMINISTIC: plain text with {{PLACEHOLDERS}} and
//    exactly one {{BODY}} slot where the AI draft (or manual content) goes.
//  - The AI never redesigns structure — it only writes the {{BODY}} content.
//  - Fields marked required MUST be provided before generation (§12).
//  - ai:true fields are the only user data sent to the AI provider (§41).

import type { LetterType, TemplateField } from "./shared";

export type CanonicalTemplate = {
  code: string;
  name: string;
  letterType: LetterType;
  description: string;
  department: string;
  isDefault: true;
  subjectHint: string;
  aiInstructions: string;
  bodyTemplate: string;
  closingTemplate: string;
  fields: TemplateField[];
};

const commonSignatory: TemplateField[] = [
  { key: "SIGNATORY_NAME", label: "Signatory Name", type: "text", required: true, ai: false, hint: "Person who signs the letter" },
  { key: "SIGNATORY_POSITION", label: "Signatory Position", type: "text", required: true, ai: false },
];

export const CANONICAL_LETTER_TEMPLATES: CanonicalTemplate[] = [
  {
    code: "LOU-001",
    name: "Letter of Undertaking (Standard)",
    letterType: "LOU",
    description: "Standard undertaking letter in which MOHD.HMS ENTERPRISE formally undertakes to carry out specified obligations.",
    department: "HR",
    isDefault: true,
    subjectHint: "Undertaking — {{PROJECT_NAME}}",
    aiInstructions:
      "Write a formal Letter of Undertaking body. Clearly state what the company undertakes to do, using ONLY the obligations and details supplied in the letter data. State the validity period only if provided. Close by affirming the company stands by the undertaking. Do not invent obligations, dates, project numbers, values or legal claims.",
    bodyTemplate:
      "We refer to the matter stated below.\n\n{{BODY}}\n\nWe trust the above sufficiently records our undertaking. Should you require any further clarification, please contact the undersigned.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_POSITION", label: "Recipient Position", type: "text", ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea", required: true },
      { key: "UNDERTAKING_MATTER", label: "Subject / Matter of Undertaking", type: "textarea", required: true, ai: true, hint: "What is being undertaken and in relation to what" },
      { key: "OBLIGATIONS", label: "Obligations Undertaken", type: "textarea", required: true, ai: true, hint: "One obligation per line" },
      { key: "PROJECT_NAME", label: "Project Name", type: "text", ai: true },
      { key: "PROJECT_REFERENCE", label: "Project / Contract Reference", type: "text", ai: true },
      { key: "VALIDITY_PERIOD", label: "Validity Period", type: "text", ai: true, hint: "Leave blank if not applicable" },
      ...commonSignatory,
    ],
  },
  {
    code: "LOA-001",
    name: "Letter of Authorization (Standard)",
    letterType: "LOA",
    description: "Authorizes a named person to act on behalf of MOHD.HMS ENTERPRISE for a defined purpose and scope.",
    department: "HR",
    isDefault: true,
    subjectHint: "Letter of Authorization — {{AUTHORIZED_PERSON}}",
    aiInstructions:
      "Write a formal Letter of Authorization body. State exactly who is authorized, for what purpose and scope — never expand the scope beyond the supplied details. Include the validity period only if provided. Do not invent identification numbers, project details or powers not supplied.",
    bodyTemplate:
      "This letter serves to confirm that the person named below is authorized to act on behalf of {{COMPANY_NAME}} as stated.\n\n{{BODY}}\n\nThis authorization is limited strictly to the scope stated above. Please do not hesitate to contact the undersigned to verify this authorization.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "AUTHORIZED_PERSON", label: "Authorized Person", type: "text", required: true, ai: true },
      { key: "AUTHORIZED_ID", label: "ID / Passport No.", type: "text", ai: true, hint: "Leave blank if not applicable" },
      { key: "AUTHORIZED_POSITION", label: "Position of Authorized Person", type: "text", ai: true },
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea", required: true },
      { key: "AUTHORIZATION_PURPOSE", label: "Purpose of Authorization", type: "textarea", required: true, ai: true },
      { key: "AUTHORIZATION_SCOPE", label: "Scope of Authorization", type: "textarea", required: true, ai: true, hint: "Exactly what the person may do" },
      { key: "PROJECT_NAME", label: "Project / Contract", type: "text", ai: true },
      { key: "VALIDITY_PERIOD", label: "Validity Period", type: "text", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "SUB-001",
    name: "Submission Letter (Standard)",
    letterType: "SUBMISSION",
    description: "Covers the submission of documents, drawings, samples or tenders to a client, consultant or authority.",
    department: "HR",
    isDefault: true,
    subjectHint: "Submission of {{SUBMISSION_ITEMS}} — {{PROJECT_NAME}}",
    aiInstructions:
      "Write a professional submission letter body. Reference the enclosed items exactly as listed, state the purpose of the submission and, where provided, the project and tender references. Request acknowledgment of receipt in an appropriate manner. Do not invent project numbers, quantities or dates not supplied.",
    bodyTemplate:
      "We are pleased to submit the following for your kind attention and review.\n\n{{BODY}}\n\nWe would appreciate your acknowledgment of receipt. Should any item require clarification, please contact the undersigned.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_POSITION", label: "Recipient Position", type: "text", ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea", required: true },
      { key: "PROJECT_NAME", label: "Project Name", type: "text", ai: true },
      { key: "PROJECT_REFERENCE", label: "Project Reference", type: "text", ai: true },
      { key: "TENDER_REFERENCE", label: "Tender Reference", type: "text", ai: true },
      { key: "SUBMISSION_PURPOSE", label: "Submission Purpose", type: "textarea", required: true, ai: true, hint: "Why these documents are being submitted" },
      { key: "SUBMISSION_ITEMS", label: "Documents / Items Submitted", type: "textarea", required: true, ai: true, hint: "One item per line" },
      { key: "CONTACT_PERSON", label: "Contact Person", type: "text", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "CLAR-001",
    name: "Clarification Letter (Standard)",
    letterType: "CLARIFICATION",
    description: "Seeks or provides clarification on a technical, contractual or administrative matter.",
    department: "HR",
    isDefault: true,
    subjectHint: "Clarification — {{CLARIFICATION_TOPIC}}",
    aiInstructions:
      "Write a professional clarification letter body. State the topic, the question or issue requiring clarification and, where supplied, the required explanation or supporting information. Preserve every technical fact exactly as provided — never alter specifications, measurements, references or requirements.",
    bodyTemplate:
      "We write with reference to the matter stated below and would appreciate your clarification.\n\n{{BODY}}\n\nWe look forward to your response at your earliest convenience. Please contact the undersigned should any further information be required from our side.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_POSITION", label: "Recipient Position", type: "text", ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea", required: true },
      { key: "PROJECT_NAME", label: "Project Name", type: "text", ai: true },
      { key: "PROJECT_REFERENCE", label: "Reference", type: "text", ai: true },
      { key: "CLARIFICATION_TOPIC", label: "Clarification Topic", type: "text", required: true, ai: true },
      { key: "QUESTION", label: "Question / Issue", type: "textarea", required: true, ai: true },
      { key: "SUPPORTING_INFO", label: "Supporting Information", type: "textarea", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "APT-001",
    name: "Appointment Letter (Standard)",
    letterType: "APPOINTMENT",
    description: "Appoints a new employee to a stated position with the stated terms of employment.",
    department: "HR",
    isDefault: true,
    subjectHint: "Appointment as {{EMPLOYEE_POSITION}}",
    aiInstructions:
      "Write a formal appointment letter body confirming the appointment of the named person to the stated position, commencing on the provided start date and reporting to the provided reporting line where given. Use only the terms supplied in the letter data. Do not invent salary figures, benefits, probation terms or obligations not provided.",
    bodyTemplate:
      "Following your application and the subsequent interview, we are pleased to appoint you on the terms set out below.\n\n{{BODY}}\n\nPlease sign and return the duplicate copy of this letter to indicate your acceptance of the appointment.\n\nWe welcome you to the company and look forward to a successful working relationship.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true, hint: "Pick from the employee register to auto-fill details" },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "START_DATE", label: "Commencement Date", type: "date", required: true, ai: true },
      { key: "REPORTS_TO", label: "Reports To", type: "text", ai: true },
      { key: "WORK_LOCATION", label: "Work Location", type: "text", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "CNF-001",
    name: "Confirmation Letter (After Probation)",
    letterType: "CONFIRMATION",
    description: "Confirms an employee in their position upon successful completion of the probation period.",
    department: "HR",
    isDefault: true,
    subjectHint: "Confirmation of Employment — {{EMPLOYEE_NAME}}",
    aiInstructions:
      "Write a formal confirmation letter body confirming the named employee in the stated position following satisfactory completion of the probation period. Mention the probation end date and any revised terms only if supplied. Do not invent performance details or benefits.",
    bodyTemplate:
      "We refer to your employment with the company and to the probationary period applicable to your appointment.\n\n{{BODY}}\n\nWe congratulate you on your confirmation and look forward to your continued contribution to the company.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "START_DATE", label: "Probation End Date", type: "date", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "WRN-001",
    name: "Warning Letter (Formal)",
    letterType: "WARNING",
    description: "Formal warning letter documenting misconduct or performance issues and the required improvement.",
    department: "HR",
    isDefault: true,
    subjectHint: "Warning Letter — {{INCIDENT_DATE}}",
    aiInstructions:
      "Write a formal warning letter body stating the conduct or performance concern, the date it occurred (only if provided), the improvement or corrective action required and the consequences of recurrence as supplied. Use a firm, professional and factual tone — no emotional language, no threats beyond the stated consequences, no invented incident details.",
    bodyTemplate:
      "This letter serves as a formal warning regarding the matter described below.\n\n{{BODY}}\n\nPlease acknowledge receipt of this warning letter by signing and returning the duplicate copy. You are encouraged to discuss this matter with the undersigned should you require any clarification.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "INCIDENT_DATE", label: "Date of Incident / Concern", type: "date", ai: true },
      { key: "INCIDENT_DESCRIPTION", label: "Description of Conduct / Performance Concern", type: "textarea", required: true, ai: true },
      { key: "REQUIRED_ACTION", label: "Required Improvement / Corrective Action", type: "textarea", required: true, ai: true },
      { key: "CONSEQUENCES", label: "Consequences of Recurrence", type: "textarea", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "EMP-001",
    name: "Employment Letter (Standard)",
    letterType: "EMPLOYMENT",
    description: "Confirms that a person is employed by MOHD.HMS ENTERPRISE and states their role and duration.",
    department: "HR",
    isDefault: true,
    subjectHint: "Confirmation of Employment — {{EMPLOYEE_NAME}}",
    aiInstructions:
      "Write a concise employment confirmation letter body confirming the named person's employment, position and department as supplied, and employment duration only where dates are provided. Address the letter to the recipient organization where given. Do not invent salary, benefits or contract terms.",
    bodyTemplate:
      "This is to confirm the employment particulars of the person named below.\n\n{{BODY}}\n\nThis letter is issued at the request of the employee for the purpose stated above and should be treated as confidential.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "START_DATE", label: "Joining Date", type: "date", ai: true },
      { key: "END_DATE", label: "Employment End Date (if any)", type: "date", ai: true },
      { key: "PURPOSE", label: "Purpose of Letter", type: "text", ai: true, hint: "e.g. bank loan application, visa application" },
      { key: "RECIPIENT_NAME", label: "Recipient Name (if addressed)", type: "text", ai: false },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization (if addressed)", type: "text", ai: false },
      ...commonSignatory,
    ],
  },
  {
    code: "VER-001",
    name: "Salary / Employment Verification Letter",
    letterType: "VERIFICATION",
    description: "Verifies employment and salary details, typically addressed to banks or landlords.",
    department: "HR",
    isDefault: true,
    subjectHint: "Salary & Employment Verification — {{EMPLOYEE_NAME}}",
    aiInstructions:
      "Write a formal verification letter body confirming the named employee's employment, position and — where the salary value is supplied — the monthly salary in words consistent with the figure provided. Address the recipient organization. Do not invent allowances, deductions, contract terms or employment history beyond the supplied dates.",
    bodyTemplate:
      "This letter is to verify the employment and salary particulars of the person named below, as at the date of this letter.\n\n{{BODY}}\n\nThis verification is issued strictly for the stated purpose and without any liability or obligation on the part of the company.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "START_DATE", label: "Joining Date", type: "date", ai: true },
      { key: "SALARY", label: "Monthly Salary (BND)", type: "number", ai: true, hint: "Leave blank to omit salary from the letter" },
      { key: "PURPOSE", label: "Purpose", type: "text", required: true, ai: true, hint: "e.g. housing loan application" },
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea" },
      ...commonSignatory,
    ],
  },
  {
    code: "TRN-001",
    name: "Training / Internship Letter",
    letterType: "TRAINING",
    description: "Accepts a trainee or intern for practical training, stating the placement and duration.",
    department: "HR",
    isDefault: true,
    subjectHint: "Industrial Training Placement — {{TRAINEE_NAME}}",
    aiInstructions:
      "Write a formal training/internship acceptance letter body confirming the placement of the named trainee in the stated department and period as supplied, and the reporting arrangements where provided. Do not invent allowances, working hours or assessments.",
    bodyTemplate:
      "Thank you for your application for practical training with our organization. We are pleased to inform you of the following placement.\n\n{{BODY}}\n\nPlease report to the undersigned on the commencement date. We wish you a fruitful training experience with the company.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "TRAINEE_NAME", label: "Trainee / Intern Name", type: "text", required: true, ai: true },
      { key: "TRAINEE_INSTITUTION", label: "Institution", type: "text", ai: true },
      { key: "TRAINEE_PROGRAMME", label: "Programme / Course", type: "text", ai: true },
      { key: "DEPARTMENT", label: "Placement Department", type: "text", required: true, ai: true },
      { key: "START_DATE", label: "Training Start Date", type: "date", required: true, ai: true },
      { key: "END_DATE", label: "Training End Date", type: "date", required: true, ai: true },
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", ai: true, hint: "e.g. institution coordinator" },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "REF-001",
    name: "Reference Letter (Professional)",
    letterType: "REFERENCE",
    description: "Professional reference for a current or former employee.",
    department: "HR",
    isDefault: true,
    subjectHint: "Letter of Reference — {{EMPLOYEE_NAME}}",
    aiInstructions:
      "Write a professional reference letter body summarizing the person's role, period of employment and the strengths explicitly supplied in the letter data. Do not invent accomplishments, character judgments or employment details beyond what is provided. If no strengths are supplied, keep the reference factual.",
    bodyTemplate:
      "I am pleased to provide this letter of reference for the person named below.\n\n{{BODY}}\n\nI would be pleased to elaborate further should you require additional information. Please contact the undersigned directly.",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "EMPLOYEE_NAME", label: "Employee Name", type: "employee", required: true, ai: true },
      { key: "EMPLOYEE_ID", label: "Employee No.", type: "text", ai: true },
      { key: "EMPLOYEE_POSITION", label: "Position", type: "text", required: true, ai: true },
      { key: "DEPARTMENT", label: "Department", type: "text", ai: true },
      { key: "START_DATE", label: "Employment From", type: "date", ai: true },
      { key: "END_DATE", label: "Employment To (blank if current)", type: "date", ai: true },
      { key: "STRENGTHS", label: "Strengths / Achievements", type: "textarea", ai: true, hint: "Only factual, approved observations" },
      { key: "RECIPIENT_NAME", label: "Recipient Name (if addressed)", type: "text", ai: false },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization (if addressed)", type: "text", ai: false },
      ...commonSignatory,
    ],
  },
  {
    code: "GEN-001",
    name: "General Official Letter",
    letterType: "GENERAL",
    description: "Versatile template for any official company correspondence.",
    department: "HR",
    isDefault: true,
    subjectHint: "{{SUBJECT}}",
    aiInstructions:
      "Write the body of a formal business letter on the stated subject, incorporating the main points supplied in the letter data. Structure the content logically (context → content → requested action/next step). Use only the supplied information — never add facts, dates, figures or commitments.",
    bodyTemplate: "{{BODY}}",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_POSITION", label: "Recipient Position", type: "text", ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", required: true, ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea", required: true },
      { key: "MAIN_POINTS", label: "Main Points / Message", type: "textarea", required: true, ai: true, hint: "What the letter needs to communicate" },
      { key: "REQUESTED_ACTION", label: "Requested Action / Next Step", type: "textarea", ai: true },
      ...commonSignatory,
    ],
  },
  {
    code: "CUS-001",
    name: "Custom Letter Template",
    letterType: "CUSTOM",
    description: "Minimal starting point for user-defined letters — extend the fields via the template editor.",
    department: "HR",
    isDefault: true,
    subjectHint: "{{SUBJECT}}",
    aiInstructions:
      "Write the body of a formal business letter using ONLY the supplied letter data. Structure the content professionally (context → content → requested action where applicable). Never add facts, dates, figures or commitments that were not supplied.",
    bodyTemplate: "{{BODY}}",
    closingTemplate: "Yours faithfully,",
    fields: [
      { key: "RECIPIENT_NAME", label: "Recipient Name", type: "text", required: true, ai: true },
      { key: "RECIPIENT_COMPANY", label: "Recipient Organization", type: "text", ai: true },
      { key: "RECIPIENT_ADDRESS", label: "Recipient Address", type: "textarea" },
      { key: "SUBJECT", label: "Subject", type: "text", required: true, ai: true },
      { key: "MAIN_POINTS", label: "Main Points / Message", type: "textarea", required: true, ai: true },
      ...commonSignatory,
    ],
  },
];
