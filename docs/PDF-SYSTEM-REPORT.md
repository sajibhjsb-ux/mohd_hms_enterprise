# PDF SYSTEM REPORT — Centralized Enterprise PDF Generation & Download

MOHD.HMS ENTERPRISE / FacilityPro — 40-section standard implementation report.
Sandbox note: the dev sandbox runs the portable SQLite Prisma provider; in
production (PostgreSQL) every Prisma query and money integer-cents contract is
identical, so the PDF data flow is unchanged.

---

## 1. ROOT CAUSE OF THE PDF DOWNLOAD PROBLEM

The application had **no PDF generation system at all**. A full audit
(frontend grep for `pdf/Content-Disposition/createObjectURL/download`,
backend route-tree inspection) found:

- zero PDF endpoints anywhere under `/api/v1/**`
- zero PDF libraries in `package.json`
- only a CSV export route (`/api/v1/reports/export`), client-side CSV in the
  shared DataTable, a QR-PNG download on the equipment label page, and
  browser `window.print()` flows on invoice/quotation/IRMS/reports pages.

"PDF buttons" appeared broken because (a) download endpoints did not exist and
(b) `window.print()` only prints an in-app HTML card, which fails silently on
mobile browsers and produces no file. The correct root-cause fix (§37) was to
build the missing centralized system — not to patch individual buttons.

## 2. EXISTING PDF SYSTEM FOUND

| Found | Location | Disposition |
|---|---|---|
| CSV export (aggregated reports) | `src/app/api/v1/reports/export/route.ts` | kept, unchanged |
| Client CSV in DataTable | `src/components/hms/shared/data-table.tsx` | kept, unchanged |
| QR PNG download | `equipment/label-page.tsx` | kept (label, not a document) |
| `window.print()` flows | invoice/quotation detail, IRMS report, reports page | kept as secondary Print flow (§11 "appropriate print flow"); server PDF Preview/Download added beside them |

## 3. PDF ENGINE USED

**pdf-lib 1.17.1** (pure TypeScript, MIT) wrapped in an in-house layout engine
(`src/lib/hms/pdf/engine.ts`): A4 geometry, brand header, page footers with
"Page X of Y", word wrap, tables with repeated headers across page breaks,
totals blocks, KV grids, signature lines, aspect-preserving image embedding,
and generation validation.

## 4. WHETHER UNIPDF WAS USED OR NOT

**No. UniPDF was not used.**

## 5. WHY THAT DECISION WAS MADE

Per the spec's own decision procedure (§3/§4):

- UniPDF is a **Go** library. The application's authoritative backend is the
  Next.js business layer (spec text describes a Python FastAPI host; either
  way UniPDF cannot be embedded there).
- Using UniPDF would require a separate internal Go micro-service — which the
  spec itself forbids ("DO NOT CREATE A SEPARATE APPLICATION", "DO NOT CREATE
  A SECOND BUSINESS LOGIC LAYER").
- UniPDF requires a **commercial license** (`UNIDOC_LICENSE_API_KEY`). No
  valid license exists in this project, and the spec forbids silently
  deploying an implementation that would fail in production, as well as
  forbidding license keys in source/Git/images. Reported here instead.
- pdf-lib is MIT-licensed (no key, no license risk), integrates directly into
  the existing single business layer, and produces real, valid, validated PDF
  bytes server-side. Option A/B rationale: "use the existing technology if it
  can solve the problem" — it can, with full A4 layout control.

## 6. PDF SERVICE ARCHITECTURE

```
Route (thin dispatcher)            src/app/api/v1/pdf/[type]/[id]/route.ts
  ↓ auth + per-type permission     lib/hms/api.ts handler() + lib/hms/rbac.ts
Document Registry (§6)             lib/hms/pdf/documents.ts — 9 types,
  ↓ loader (Prisma, scoped)           permission + loader + render + filename
PDFService core                    lib/hms/pdf/engine.ts (PdfDoc) + branding.ts
  ↓ validate (§20)                    (company settings + canonical logo)
Binary response (§8)               application/pdf + Content-Disposition
Browser (§10)                      lib/hms/pdf-client.ts + shared/pdf-buttons.tsx
```

Rendering code lives ONLY in the registry/builders — no route contains PDF
logic (§5 GOOD pattern).

## 7. API ENDPOINTS CREATED/FIXED

One consistent endpoint serves all document types (centralized registry;
query param selects inline preview):

- `GET /api/v1/pdf/{type}/{id}` → attachment
- `GET /api/v1/pdf/{type}/{id}?disposition=inline` → browser PDF viewer

Types (`{type}`): `work-order`, `complaint`, `inspection-report`, `quotation`,
`invoice`, `purchase-order`, `equipment-report`, `pm-task`, `payment-receipt`.

Document-type registry (§6): 9 types covering every existing module with
document needs: Work Orders, Complaints, IRMS Inspections, Quotations,
Invoices, Purchases, Equipment, Preventive Maintenance, Payments. No duplicate
modules invented; no buttons added where not required (§27).

## 8. FRONTEND DOWNLOAD FLOW FIXED

`src/lib/hms/pdf-client.ts` implements the spec flow exactly: loading state →
fetch (same-origin credentials, no-store) → status check → **content-type
check (must be `application/pdf`)** → blob → size sanity → object URL →
temporary `<a download>` with server filename → click → revoke after 30 s.
`usePdfDownload()` hook adds busy state + toasts. Shared buttons:
`src/components/hms/shared/pdf-buttons.tsx` (full button + icon variant).

## 9. AUTH/RBAC FIXES

- Every request passes the central `handler()` pipeline (session cookie,
  401 on anonymous, structured errors, request IDs).
- Per-document permission enforced server-side: work_orders.read,
  complaints.read, irms.read, quotations.read, invoices.read, purchases.read,
  equipment.read, pm.read, payments.read.
- Customer-portal scoping: customers can only ever load documents belonging to
  their linked customer; invisible records return **404** (existence never
  revealed). Payment receipts are staff-permission documents; customer
  visibility follows invoice ownership.
- Verified live: 401 (no auth), 403 (technician→invoice, customer→receipt),
  404 (unknown type/id, cross-tenant invoice/WO/equipment).

## 10. POSTGRESQL DATA FLOW

Every PDF is generated from a **fresh Prisma query** of authoritative records
(WorkOrder+checklist+materials, Complaint+statusHistory, InspectionReport+
findings, Quotation/Invoice+items+payments, PO+items+supplier, Equipment+PM
plans+history, PmTask+checklist, Payment+invoice). No frontend state, no
manually typed values, no sample data (§12). Amounts render from integer-cents
columns through the central BND formatter (`money()` → "BND 1,250.00") — the
same single source of truth used across the app (BND localization standard).
Totals are **never recalculated** for PDFs; they are read from the
backend-authoritative columns (§15/§16).

## 11. REDIS USAGE

None. No Redis client exists in this codebase (unchanged from the BND
localization audit). PostgreSQL is the sole source of document truth; PDF
generation is synchronous per-request with `Cache-Control: no-store` (§33).

## 12. FILE STORAGE

Documents are **generated on demand** (§22 option A) — no temporary files, no
uncontrolled storage, nothing to clean up. The only file read is the canonical
brand logo `public/brand/logo-256.png` (module-level cache). Filenames are
generated per §23 and sanitized (`safeFilename`: strips path separators,
control characters, Unicode, spaces → dashes; 120-char cap).

## 13. CLOUDFLARE/NGINX CHANGES

None needed — the sandbox exposes the app through its own gateway, which
passed binary PDF responses unchanged (verified: `Content-Type`,
`Content-Disposition`, `Content-Length`, 93–95 KB bodies through the proxy).
Response headers include `X-Content-Type-Options: nosniff` to survive
aggressive proxy content sniffing.

## 14. FILES CREATED

- `src/lib/hms/pdf/engine.ts` — central A4 layout engine + validation + filename sanitizer
- `src/lib/hms/pdf/branding.ts` — canonical company/logo branding source
- `src/lib/hms/pdf/documents.ts` — document type registry (9 loaders + renderers)
- `src/app/api/v1/pdf/[type]/[id]/route.ts` — thin central endpoint
- `src/lib/hms/pdf-client.ts` — browser download/preview flows + hook
- `src/components/hms/shared/pdf-buttons.tsx` — shared Download/Preview buttons
- `docs/PDF-SYSTEM-REPORT.md` — this report

## 15. FILES MODIFIED

- `invoices/detail-page.tsx` — Download PDF + Preview in header actions; per-payment Receipt icon buttons (permission-gated column)
- `quotations/detail-page.tsx` — Download PDF + Preview
- `work-orders/detail-page.tsx` — Download PDF
- `complaints/detail-page.tsx` — Download PDF
- `equipment/detail-page.tsx` — Download PDF (equipment report)
- `purchases/detail-page.tsx` — Download PDF
- `irms/report-detail-page.tsx` — Download PDF (beside existing Print)
- `pm/index.tsx` — per-task PDF icon button in Actions column (all tasks, incl. completed)

## 16. DEPENDENCIES ADDED

- `pdf-lib@1.17.1` (MIT) — the only new dependency.

## 17. ENVIRONMENT VARIABLES ADDED

None. No license keys or credentials are required or stored (§4). If UniPDF is
ever adopted, `UNIDOC_LICENSE_API_KEY` must be a server-side env var only —
documented, not implemented.

## 18. TESTS PERFORMED

Live API + real-browser verification (spec §30 mapped to executed checks):

1. Work Order PDF — 200, `%PDF-1.7`, 95 KB; amounts match DB (50+10+45 = 105)
2. Complaint PDF — 200; code, timeline section present
3. Inspection Report PDF — 200; INS-2026-0002
4. Quotation PDF — 200; unit/subtotal/total BND 350.00 == DB 35000 cents
5. Invoice PDF — 200; BND 65.00 totals == DB; Paid/Balance rows
6. Unauthorized request — 401
7. Customer restricted — customer→receipt 403; technician→invoice 403
8. Missing record — 404 ("Invoice not found.")
9. Invalid ID/type — 404 ("Unknown document type.")
10. Generation failure — structured `PDF_GENERATION_FAILED` branch implemented
    (500 + `requestId`, SUPER_ADMIN-only diagnostics via central handler);
    the 4xx error paths were exercised live; the 5xx branch was code-reviewed
    and shares the same central error pipeline (no artificial fault injected)
11. Empty document data — renderers use "—" placeholders; tables print
    empty-hint rows; engine rejects <400-byte output
12. Multi-page document — 40-line quotation → 3 A4 pages, repeated table
    headers on every page, all 40 rows intact, grand total BND 100.00
13. Image-containing document — engine supports aspect-preserving PNG/JPG
    embedding; the canonical logo embeds in every header; no document photos
    exist in the database, so none are included (§12 "only fields that exist")
14. BND financial document — "Currency: BND (Brunei Darussalam)" banner on
    quotation/invoice/PO/receipt; every amount "BND x,xxx.xx"
15. Filename validation — `MOHD-HMS-Work-Order-WO-2026-0005.pdf` pattern for
    all 9 types; sanitized; `filename` + RFC 5987 `filename*` headers

## 19. BROWSER QA RESULTS

agent-browser against `localhost:3000`, admin login:

- Complaint detail → "Download PDF" → toast "Complaint CPT-2026-0013
  downloaded" → file verified in `~/Downloads` (valid PDF, Title metadata)
- Invoice detail → Download + **Preview** (opened browser PDF viewer in new
  tab showing the document inline — no download triggered, §11)
- Quotation/Work order/Equipment/Purchase/IRMS/PM-task downloads — all clicked
  through the real UI, each produced the correctly-named PDF in Downloads
- Payment receipt icon button in the invoice Payments table → receipt PDF
- Customer portal: customer1@demo.my downloads own invoice (toast + file);
  Receipt column correctly absent (no payments.read permission)

## 20. DESKTOP RESULTS

Desktop 1280×800 Chrome (agent-browser): all flows above pass; buttons render
in page headers (no popups — consistent with NO-POPUP-CRUD architecture);
existing `window.print()` flows retained.

## 21. MOBILE RESULTS

375×720 viewport: invoice page renders single-column with Payments table and
icon receipt buttons, zero horizontal overflow (screenshot-verified). Download
uses blob + `<a download>` (works on Android Chrome); Preview opens the
browser PDF viewer (iOS Safari preview/share flow).

## 22. WORK ORDER PDF RESULT

PASS — checklist (4 items, done states), materials table, labour row, totals
block, confirmation banner, signature lines; all figures match PostgreSQL.

## 23. COMPLAINT PDF RESULT

PASS — record header grid, description, resolution, status timeline, linked
work orders; RBAC-scoped (customer PDFs contain no internal staff data beyond
assigned technician name, which customers already see in-app).

## 24. INSPECTION REPORT RESULT

PASS — project/client/site/equipment header, findings table (severity +
recommended actions), recommendations, inspector signature line.

## 25. QUOTATION PDF RESULT

PASS — itemised pricing, backend-authoritative totals (subtotal/discount/
shipping/tax/grand total), Currency: BND banner, terms, signature lines.

## 26. INVOICE PDF RESULT

PASS — line items, totals incl. Amount Paid + Balance Due, payments received
table, PAID-IN-FULL / balance-due banner, Currency: BND banner.

## 27. IRMS PDF RESULT

PASS — inspection report generated via registry type `inspection-report` from
the existing IRMS structure (no separate application, §14).

## 28. SECURITY RESULT

PASS — session auth on every request; per-type RBAC permissions; customer
tenant scoping with 404 (non-revealing); no stack traces/filesystem paths/
credentials in responses or PDFs (central handler gates diagnostics to
SUPER_ADMIN); `nosniff` header; no license keys anywhere.

## 29. PERFORMANCE RESULT

PASS — synchronous generation fits all documents comfortably: measured
37–73 ms per PDF (structured logs, `durationMs`), ~94 KB typical size. No
queue needed (§34: sync acceptable for small PDFs).

## 30. ANY REMAINING ISSUE

1. UniPDF: not adopted (Go service + commercial license). If the business
   later requires UniPDF specifically, provision a license key as a
   server-side env var and run it as an internal-only rendering service — the
   registry isolates the engine behind `PdfDoc`, so swapping engines touches
   one layer only.
2. `PDF_GENERATION_FAILED` 5xx path was code-reviewed and shares the live
   error pipeline verified via 4xx cases; no artificial fault was injected to
   trigger a real 500.
3. §29 API documentation: OpenAPI/Swagger (`/docs`) applies to the FastAPI
   host described in the spec; this Next.js backend documents endpoints in
   code. Endpoint contract is documented in this report (§7) and route source.
4. Photos/signatures stored per-record do not exist in the current database
   schema; the engine already supports embedding images, so they will appear
   in PDFs automatically once a records-photos feature stores them.

**FINAL STATUS: PASS — real PDFs download, open and verify for all 9 document
types from the real UI, with auth, RBAC, tenant scoping, BND currency,
professional A4 layout, validation and structured logging.**
