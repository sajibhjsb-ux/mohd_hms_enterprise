// MOHD.HMS ENTERPRISE — canonical legal content (bootstrap source).
//
// This module is the SEED for the canonical Terms & Conditions and Privacy
// Policy. After the first bootstrap the database rows become the single
// authoritative source (admin-editable in Settings → Legal); this module is
// only used when a document of that kind does not exist yet, so the app always
// has real legal content available (fresh databases, sandbox resets).
//
// WRITING RULES (enforced by review):
//   • Every statement must match ACTUAL application behaviour — no invented
//     policies (no penalties, refund rules, retention periods, warranties,
//     response-time promises or definitive jurisdiction claims).
//   • Sections whose wording has NOT been approved by management/legal counsel
//     carry needsReview: true — the admin Legal tab shows them with a
//     "requires review" badge until the company finalises the wording.
//   • Bodies are PLAIN TEXT (rendered with whitespace-pre-line). Never HTML.
//   • Company identity (name/address/phone/email/website) is NOT hardcoded
//     here — it is rendered dynamically from Company Settings at display time.

import type { LegalKind } from "./types";
export type { LegalKind } from "./types";

export type LegalSectionInput = {
  id: string;
  title: string;
  body: string;
  /** Wording not yet approved by management/legal counsel — surfaced in the
   *  admin Legal tab as a review badge. Never rendered publicly. */
  needsReview?: boolean;
};

export type LegalDocumentInput = {
  kind: LegalKind;
  version: string;
  status: "DRAFT" | "PUBLISHED";
  effectiveDate: string | null; // ISO date or null (pending company approval)
  changeSummary: string;
  sections: LegalSectionInput[];
};

export const LEGAL_KINDS: LegalKind[] = ["TERMS", "PRIVACY"];

// ─────────────────────────────────────────────────────────────────────────────
// TERMS & CONDITIONS — v1.0
// ─────────────────────────────────────────────────────────────────────────────

const TERMS_SECTIONS: LegalSectionInput[] = [
  {
    id: "introduction",
    title: "Introduction",
    body: `Welcome to MOHD.HMS Enterprise.

MOHD.HMS Enterprise operates an online platform for smart facility maintenance management. The platform allows customers to submit service and job requests, report issues, receive quotations, follow work progress and access related documents, while authorised company staff manage the day-to-day maintenance operation.

These Terms & Conditions ("Terms") govern access to and use of the platform and the customer portal. By creating an account, accessing or using the platform, you agree to these Terms. If you do not agree, please do not use the platform.

These Terms describe how the platform is used. They do not replace the specific commercial terms of any individual quotation, invoice or service agreement issued for particular work, which apply in addition to these Terms.`,
  },
  {
    id: "definitions",
    title: "Definitions",
    body: `"Company", "we", "us" and "our" mean MOHD.HMS Enterprise.

"Platform" means the MOHD.HMS Enterprise web application and any installed app (PWA) through which the services are accessed.

"User" means any person who accesses the platform. "Customer" means a user, or the organisation a user represents, on whose behalf service requests are made.

"Service Request" means a complaint, maintenance request, job request or inspection request submitted through the platform.

"Work Order" means an internal instruction created by the Company to carry out requested or planned work.

"Quotation" means a document issued through the platform describing proposed work and its price. "Invoice" means a document requesting payment for work or services.

"Inspection Report" means a report produced as part of an inspection project, including reports a Customer reviews and confirms through the customer portal.`,
  },
  {
    id: "account-registration",
    title: "Account Registration and Eligibility",
    body: `Customer accounts are created either by the Company (for example when onboarding a new customer) or through an approved self-service sign-up method offered on the platform, such as signing up with a Google account. Access to staff functions is granted only by the Company and is not available through self-service registration.

You agree to provide accurate, current and complete information when an account is created, and to keep it accurate. Accounts are personal to the user or organisation they were created for and must not be shared between different people or organisations.

If you use the platform on behalf of an organisation, you confirm that you are authorised to act for that organisation.

We may refuse to create an account, or limit features of an account, where this is reasonably necessary for security, operational or legal reasons.`,
  },
  {
    id: "customer-information",
    title: "Customer Information and Responsibilities",
    body: `As a Customer you are responsible for:

• providing accurate and truthful information in your account and in every service request;
• keeping your account security details (such as your password) confidential;
• keeping your contact information, including your mobile number and address, current;
• providing accurate service and site information so work can be planned and carried out properly.

The platform requires Customers to complete their mobile number and address before a service or job request can be submitted, so that the Company can contact you and locate the work site. The company name field in the customer profile is optional — individual and home customers may leave it blank.

You are responsible for the consequences of information you provide. If information you supplied is inaccurate and causes rework, delay or an avoidable site visit, the Company may discuss the practical consequences with you before continuing the work.`,
  },
  {
    id: "services-and-job-requests",
    title: "Services and Job Requests",
    body: `Through the platform, Customers may:

• submit complaints and report facility issues;
• request maintenance or other services;
• provide site information, photos and documents relevant to a request;
• follow the status of their requests.

Submitting a service or job request does not mean the work has already been accepted or scheduled. A request is processed through the platform's existing workflow: it is received, reviewed and assigned by authorised staff, and its progress is visible in the portal. The Company will communicate with you through the platform or your contact details as the request progresses.

Nothing on the platform is a promise that a particular service will be available at a particular time, that a request will be answered within a specific period, or that work will be completed within a specific period, unless the Company has explicitly confirmed this to you for that particular job.`,
  },
  {
    id: "service-requests-and-work-orders",
    title: "Service Requests and Work Orders",
    body: `When the Company accepts a request, it is managed through the platform's workflow. The Company may create a Work Order describing the work to be performed. Work Order and request records are part of the service record for the work.

Customers agree to provide the access, cooperation and site information reasonably required to carry out agreed work, and to ensure that a person responsible for the site is available where this is needed.

Where a request cannot proceed — for example because the requested work is outside the services the Company provides, because required information is missing, or because the site cannot be accessed — the Company will record this in the request and inform you where practical.`,
  },
  {
    id: "quotations",
    title: "Quotations",
    body: `For work that requires a price to be agreed first, the usual flow is:

Customer Request → Assessment → Quotation → Customer Acceptance → Work Order / Service → Completion → Invoice → Payment.

A Quotation describes the proposed work and its price. The conditions of a quotation — such as its validity period and any assumptions made — are those stated on the quotation itself. Quotations are managed through the Company's quotation workflow, and acceptance is handled by the Company through the platform's existing process.

Prices, quantities and scopes are those stated in the Quotation. A Quotation is an offer to perform the described work under the stated conditions; it is not a confirmation that work has started. If work is requested that is outside an accepted Quotation, the Company may issue a further assessment or quotation for it.`,
  },
  {
    id: "invoices-and-payments",
    title: "Invoices and Payments",
    body: `Invoices are issued through the platform after work is performed or as agreed for the particular job. Amounts are stated in Brunei Dollars (BND). Taxes or charges, where applicable to a particular invoice, are shown on that invoice.

The payment terms for each invoice — including the due date and how payment should be made — are stated on the invoice or communicated with it. Payments made are recorded in the platform, and a payment record or receipt may be issued.

If you believe an invoice is incorrect, or you wish to dispute all or part of an invoice, please contact the Company promptly using the contact details in the "Contact Information" section or those shown on the invoice, so the matter can be reviewed while it is current.

Payment records made through the platform form part of the financial records of the services provided to you.`,
  },
  {
    id: "cancellations-and-rescheduling",
    title: "Cancellations and Rescheduling",
    body: `Requests to cancel or reschedule a service, appointment or agreed work may be made through the platform or by contacting the Company. Cancellation and rescheduling are handled through the Company's existing workflow and are subject to confirmation by the Company.

Any charges or consequences that may apply to a cancellation or reschedule depend on the nature of the work and how far it has progressed. Where such charges may apply, the Company will inform you before they are confirmed. No cancellation fee applies unless it has been communicated to and agreed with you for the specific job.

(This section is deliberately conservative: the Company has not approved a general cancellation-penalty policy. If the Company later adopts one, this section and the applicable documents will be updated.)`,
    needsReview: true,
  },
  {
    id: "customer-confirmation",
    title: "Customer Confirmation and Completion",
    body: `Certain workflows ask the Customer to review and confirm completed work — for example, confirming an inspection report through the customer portal, or acknowledging completed work on a work-order record.

Confirmation records that the described work or report has been reviewed and that the workflow step is complete. Before confirming, you should review the work or report and raise any questions or issues through the platform or your usual Company contact.

Confirming a completion record does not remove any rights you have under these Terms, under the documents issued for the work, or under applicable law. If you identify a problem after confirming, contact the Company and it will be handled through the Company's normal service process.`,
  },
  {
    id: "equipment-and-site-access",
    title: "Equipment and Site Access",
    body: `The platform can track equipment and assets, including equipment identified by QR-coded labels. Customers agree to provide accurate information about the equipment and sites where services are requested, and not to remove, alter or misuse equipment labels or identification placed by the Company.

Where the Company needs access to a site to carry out agreed work, Customers are responsible for arranging safe and reasonable access during the agreed times, and for pointing out any site-specific conditions, hazards or access restrictions that a reasonable visitor should be told about.`,
  },
  {
    id: "customer-provided-information",
    title: "Customer-Provided Information",
    body: `You keep ownership of the information, photos, documents and other materials you provide through the platform ("Customer Content").

You give the Company permission to store, reproduce and use Customer Content for the purposes of operating the platform and providing services to you — for example, attaching photos to a work order, including site information in a quotation, or keeping records of completed work. This permission ends when the business purpose for it ends, except where the Company must retain records.

You confirm that Customer Content you provide is accurate, lawful and yours to provide, and that it does not contain malicious software or content that could harm the platform or other users.`,
  },
  {
    id: "service-limitations",
    title: "Service Limitations",
    body: `The platform is a management and communication tool. It is not an emergency service. If a situation presents an immediate risk to safety or property, contact the appropriate emergency services first.

The Company works to keep the platform available and correct, but the platform may be temporarily unavailable — for example for maintenance, upgrades, or events outside the Company's reasonable control. Where practical, planned unavailability will be communicated.

Features described in these Terms depend on the platform's current functionality. The Company may add, change or remove platform features over time, provided that this does not remove access to records of services already provided to you.`,
  },
  {
    id: "third-party-services",
    title: "Third-Party Services",
    body: `The platform relies on some third-party services to operate — for example Google sign-in for accounts that use it, and email or push delivery services used to send notifications. Their availability is outside the Company's control.

Where you use a third-party sign-in method, that provider handles your sign-in information under its own terms and privacy policy. The Company receives from it only the information needed to operate your account (such as your name, email address and account identifier).

The platform may display or link to third-party content where relevant to a service. The Company does not control third-party systems and is not responsible for their content or availability.`,
  },
  {
    id: "intellectual-property",
    title: "Intellectual Property",
    body: `The platform — including its software, interface, design, branding, the MOHD.HMS name and logo, and content the Company publishes on it — is owned by MOHD.HMS Enterprise or used under licence, and is protected by applicable intellectual-property laws. Except for the rights expressly granted to you in these Terms, no rights in the platform are transferred to you.

Documents and reports produced by the Company as part of providing services to you (such as quotations, invoices, work orders, service reports and inspection reports) are issued for your use in connection with the relevant services and premises.

Customer Content remains yours, as described in the "Customer-Provided Information" section. If you send the Company suggestions or feedback about the platform, you agree the Company may use them to improve its products and services without obligation to you.

(The ownership statements in this section are standard platform wording and have not yet been reviewed by legal counsel.)`,
    needsReview: true,
  },
  {
    id: "platform-usage",
    title: "Platform Usage",
    body: `When using the platform you must not:

• misuse the platform or use it for any unlawful purpose;
• attempt to access accounts, data or systems you are not authorised to access;
• interfere with the operation of the platform, including through automated load, denial-of-service attempts or reverse engineering;
• upload or transmit malicious software or harmful content;
• submit false, misleading or fraudulent information, including false requests, identities or payment references;
• access or use another customer's information;
• bypass or attempt to bypass security controls, rate limits or access restrictions;
• attempt to manipulate prices, workflow statuses, roles or permissions;
• exploit or attempt to exploit vulnerabilities for any purpose.

The platform enforces these rules technically — through role-based access control, data scoping, session handling, audit logging and rate limiting — and violations may result in access being restricted and, where appropriate, reports to the relevant authorities.

If you discover a security vulnerability, please report it responsibly through the contact details in the "Contact Information" section.`,
  },
  {
    id: "account-security",
    title: "User Accounts and Security",
    body: `You are responsible for keeping your account secure: choosing a strong password, keeping your credentials confidential, and not letting others use your account.

The platform may ask you to verify your identity or your email address with a verification code. Verification codes are short-lived and single-use; never share them with anyone. Company staff will not ask you for your password.

For your protection, the platform may: end sessions that have expired under its session policy; require you to sign in again; restrict access temporarily while a security concern is investigated; or end sessions on all devices when, for example, your password is reset.

Tell the Company promptly if you believe an unauthorised person has used your account.`,
  },
  {
    id: "data-and-privacy",
    title: "Data and Privacy",
    body: `Personal information you provide through the platform is handled according to the Company's Privacy Policy, which explains what information is collected, how it is used, and the choices available to you.

The Privacy Policy is part of these Terms. The current version is available at any time from the platform footer and at the Privacy Policy page: /privacy.`,
  },
  {
    id: "electronic-communications",
    title: "Electronic Communications",
    body: `You agree to receive communications from the Company and the platform electronically — through in-app notifications, email, or push notifications where you have enabled them — including service updates, verification codes, status changes and documents.

Communications and records kept in the platform, including documents presented in electronic form, may be relied on as records of the services. You agree that electronic form satisfies any requirement that communications be in writing, to the extent permitted by applicable law.`,
  },
  {
    id: "notifications",
    title: "Notifications",
    body: `The platform sends in-app notifications about events that concern you, such as updates to your requests, quotations, invoices and inspection reports. Email and push notifications may also be used; push notifications on a device require your permission and can be turned off in that device's settings and in your profile preferences.

Some messages are essential to the operation of your account or a service (for example verification codes), so turning off optional channels does not turn off all messages.`,
  },
  {
    id: "documents-and-records",
    title: "Documents, Reports and Records",
    body: `The platform produces documents as part of providing services, which may include: quotations, invoices and payment receipts, work orders, service reports, inspection and IRMS reports, and project records. These documents form part of the service record for the work.

Documents you are party to are available to you through the platform, and copies can be provided on request. Records are kept in accordance with the Company's record-keeping practices; the Privacy Policy describes how personal information in records is handled.

If you believe a record about you or your services is inaccurate, contact the Company so it can be reviewed and, where appropriate, corrected.`,
  },
  {
    id: "liability",
    title: "Liability and Service Limitations",
    body: `This section limits what the Company is responsible for, to the extent permitted by applicable law.

The platform is provided on an "as is" and "as available" basis. The Company works to keep the platform available, secure and correct, but does not promise that it will be uninterrupted or error-free.

The Company is responsible for the services it agrees to perform as described in the applicable quotation, work order or service agreement. Subject to that, the Company is not liable for: losses caused by information you or others provide through the platform; unavailability or errors of third-party systems; events outside the Company's reasonable control (including natural events, utility failures, and actions of authorities); or indirect or consequential losses such as loss of profit, revenue or data arising from use of the platform itself.

Nothing in these Terms limits liability that cannot be limited under applicable law, including liability for death or personal injury caused by negligence, or for fraud.

(IMPORTANT: This limitation wording is a conservative default and has NOT been reviewed or approved by legal counsel. It must be reviewed and, if necessary, rewritten for Brunei Darussalam law before being relied on commercially.)`,
    needsReview: true,
  },
  {
    id: "indemnification",
    title: "Indemnification",
    body: `To the extent permitted by applicable law, you agree to compensate the Company for losses and reasonable costs the Company incurs that arise directly from: your breach of these Terms; your misuse of the platform; or information or materials you provided that were inaccurate, unlawful or not yours to provide.

The Company will notify you of any claim in this category and give you reasonable information about it.

(This section is standard wording that has NOT yet been reviewed by legal counsel and may need adjustment for Brunei Darussalam law and the Company's risk position.)`,
    needsReview: true,
  },
  {
    id: "suspension-termination",
    title: "Suspension and Termination",
    body: `The Company may suspend or restrict access to the platform, or specific features, where reasonably necessary — for example during a security investigation, to stop suspected misuse, to protect other users, or for operational maintenance. Where practical and appropriate, the Company will tell you what happened and what is needed to restore access.

You may stop using the platform at any time. If you want your account closed, contact the Company using the details in the "Contact Information" section. Records of services provided to you may be retained after an account is closed, as described in the Privacy Policy.

Sections of these Terms that should survive ending an account — such as those about records, liability and governing law — continue to apply.`,
  },
  {
    id: "dispute-resolution",
    title: "Dispute Resolution",
    body: `If you have a complaint or dispute, please raise it first through the platform or the contact details in the "Contact Information" section, so it can be reviewed and resolved in good faith. Most matters are resolved fastest this way, because the platform keeps the relevant request, quotation, invoice and work records available for review.

(No formal arbitration or escalation procedure has been approved by the Company. Until management approves one, disputes are handled through ordinary good-faith discussion and, failing that, the parties' ordinary legal rights.)`,
    needsReview: true,
  },
  {
    id: "governing-law",
    title: "Governing Law",
    body: `MOHD.HMS Enterprise operates in Brunei Darussalam, and these Terms are intended to be read and applied in that context.

(A definitive governing-law and jurisdiction clause has NOT been approved by the Company. This placeholder — "the laws of Brunei Darussalam apply" — must be confirmed by management/legal counsel before it is treated as the final legal position.)`,
    needsReview: true,
  },
  {
    id: "changes-to-terms",
    title: "Changes to Terms",
    body: `The Company may update these Terms from time to time. The current version, its version number and its dates are always shown on the Terms & Conditions page.

When a new version is published, the platform may show you a notice describing what changed and ask you to review it. Where the Company requires Customers to accept the current version, the portal will clearly request that acceptance before the affected features can continue to be used, and the acceptance is recorded.

What you can do under these Terms is always governed by the version in force at the time. Different versions remain viewable in the platform's version history where the Company has kept them available.`,
  },
  {
    id: "contact",
    title: "Contact Information",
    body: `Questions about these Terms, the platform or the services can be raised through the platform, or using the company contact details published on this page and on Company documents.

The contact details shown in this section (company name, address, telephone, email and website) are maintained in the Company Settings of the platform and are the Company's official contact details for the purposes of these Terms.`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY POLICY — v1.0
// ─────────────────────────────────────────────────────────────────────────────

const PRIVACY_SECTIONS: LegalSectionInput[] = [
  {
    id: "privacy-introduction",
    title: "Introduction",
    body: `MOHD.HMS Enterprise ("we", "the Company") respects your privacy. This Privacy Policy explains how personal information is handled when you use the MOHD.HMS Enterprise platform — the web application and installed app (PWA) used to request and manage facility maintenance services.

This Policy applies together with the Terms & Conditions. It describes the platform's current data practices; it is not a legal opinion on data-protection law, and sections marked for review in the Company's records may be updated once the Company's legal position is confirmed.`,
  },
  {
    id: "information-we-collect",
    title: "Information We Collect",
    body: `Account information: your name, email address, role in the platform, and — where you sign in with Google — your Google account identifier and profile name/email as provided by Google. Passwords are stored only as cryptographic hashes, never in readable form.

Customer profile information: the customer record linked to your account, including company name (optional — individual and home customers may leave it blank), mobile number, address and country. The mobile number and address are required in order to request services, because the Company needs to contact you and locate the work site.

Service information: the content of what you submit through the platform — complaints and service requests, messages and comments, photos and documents you attach, quotations, invoices and payment records, work-order and completion records, and inspection reports (including photos and signatures where the inspection workflow uses them).

Security and technical records: audit logs of significant actions (who did what and when), session records (sign-in time, expiry, IP address and browser information), and delivery records for emails the platform sends.`,
  },
  {
    id: "how-we-use-information",
    title: "How We Use Information",
    body: `We use the information described above to:

• operate the platform and provide the maintenance services you request;
• contact you about your account, requests, quotations, invoices and inspections;
• verify accounts and protect them (for example, one-time verification codes for email verification and password reset);
• keep service, financial and safety records;
• maintain security — access control, audit trails, rate limiting and abuse prevention;
• improve the platform and the services.

We do not sell personal information, and we do not use platform data for advertising.`,
  },
  {
    id: "verification-and-security",
    title: "Account Security and Verification",
    body: `The platform verifies your email address with a one-time code when a verification challenge applies (for example on first sign-in for some customer accounts), and verifies password-reset requests with a one-time code.

Verification codes are short-lived and single-use, and only a cryptographic hash of each code is stored. Never share codes or passwords with anyone — including people claiming to be Company staff. Company staff will not ask you for your password or a verification code.`,
  },
  {
    id: "cookies-and-storage",
    title: "Cookies and Local Storage",
    body: `The platform uses a small number of strictly necessary cookies and browser storage items: a session cookie that keeps you signed in, and local preferences for the installed-app (PWA) experience such as your theme choice.

The platform does not use advertising cookies or third-party analytics trackers.`,
  },
  {
    id: "sharing",
    title: "Sharing of Information",
    body: `Personal information is used inside the Company by authorised staff on a role-based, need-to-know basis — the platform's access controls scope what each role can see, and customers can only see their own records.

Information may be shared outside the Company only where the operation requires it and under safeguards — for example with the providers that deliver email or push notifications on the platform's behalf (they receive only what is needed to deliver the message), or with professional advisers bound by confidentiality.

Information may also be disclosed where required by law, regulation or a lawful order of a competent authority.

(This sharing description reflects current practice; it has not yet been reviewed by legal counsel and should be confirmed before being relied on.)`,
    needsReview: true,
  },
  {
    id: "retention",
    title: "Data Retention",
    body: `Service, financial and safety records are kept for as long as the Company needs them for its records and for any applicable legal or business requirements. Information that is no longer needed is removed or anonymised as part of normal data housekeeping.

(The Company has not approved specific retention periods. This section deliberately does not state any; it will be updated if the Company adopts a retention schedule.)`,
    needsReview: true,
  },
  {
    id: "your-choices",
    title: "Your Responsibilities and Choices",
    body: `You can keep your information current in the platform: your customer profile (mobile number, address, company name) can be edited in the profile area, and your account password can be changed from the account menu.

Push notifications are optional and can be enabled, disabled or removed at any time from your device settings and your profile preferences.

To ask questions about your information, or to request correction of records you believe are inaccurate, contact the Company using the details on the Terms & Conditions page.`,
  },
  {
    id: "security-measures",
    title: "Security Measures",
    body: `The platform applies security measures including: role-based access control with per-customer data scoping; hashed passwords; hashed, single-use verification codes; signed session cookies with server-side session expiry; audit logging of significant actions; and rate limiting on sensitive operations.

No system is perfectly secure. If a security issue affects your information, the Company will handle it in accordance with its obligations and inform affected users where appropriate.`,
  },
  {
    id: "policy-changes",
    title: "Changes to This Policy",
    body: `The Company may update this Privacy Policy as the platform and its practices evolve. The current version, its version number and its "last updated" date are shown on the Privacy Policy page, and material changes may be announced in the platform.`,
  },
  {
    id: "privacy-contact",
    title: "Contact",
    body: `Privacy questions can be raised through the platform or using the Company contact details published on the Terms & Conditions page and on Company documents.`,
  },
];

export const CANONICAL_DOCUMENTS: LegalDocumentInput[] = [
  {
    kind: "TERMS",
    version: "1.0",
    status: "PUBLISHED",
    // No effective date has been approved by the company yet — the field stays
    // NULL (rendered as "pending approval") until management/legal sets it.
    effectiveDate: null,
    changeSummary: "Initial release of the consolidated Terms & Conditions.",
    sections: TERMS_SECTIONS,
  },
  {
    kind: "PRIVACY",
    version: "1.0",
    status: "PUBLISHED",
    effectiveDate: null,
    changeSummary: "Initial release of the Privacy Policy.",
    sections: PRIVACY_SECTIONS,
  },
];
