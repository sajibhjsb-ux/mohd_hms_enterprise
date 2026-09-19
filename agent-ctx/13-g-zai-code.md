# Task ID: 13-g — Quotations + Invoices → dedicated pages (no popup CRUD)

Agent: Z.ai Code (subagent, Task 13-g)
Date: 2026 build session (post 13-a/13-b infrastructure)

## Scope
Converted the QUOTATIONS and INVOICES modules to the hash-routed dedicated-page
architecture per the 13-a/13-b contract. Export names `QuotationsModule` /
`InvoicesModule` unchanged (registry untouched). Zero backend changes, zero new
APIs, zero business dialogs.

## Files written
| File | Change |
|---|---|
| `src/components/hms/shared/line-items-editor.tsx` | NEW — `LineItemsEditor` (kind Select MATERIAL/LABOUR/SERVICE/CUSTOM, inventory pick-or-custom Select with autofill, description/qty/unit/Price RM/Disc %/Tax %, Remove, live line total, Add item), `TotalsPanel`, server-mirroring `lineTotalCents`/`formTotals`. Markup moved verbatim from the former dialogs; used by both new pages. |
| `src/components/hms/modules/quotations/shared.tsx` | NEW — `CustomerLite/QuotationRow/QuotationItemRow/QuotationDetail/InventoryLite/FormItem/QForm` types, `emptyItem/emptyForm`, `loadCompanyName`, `DocumentPreview` (moved verbatim). |
| `src/components/hms/modules/quotations/new-page.tsx` | NEW — dedicated New Quotation page. PageShell ("Back to Quotations", crumbs Quotations / New Quotation, title "New Quotation"). Draft formKey `quotation.create` KEPT (restore banner). Refs GET /customers + /inventory on mount. Same validation (customer*; ≥1 valid line). `pageDirty` via `draft.dirty`. Success → `navigateTo("quotations", [res.data.id])`. RBAC `quotations.manage` → EmptyState. |
| `src/components/hms/modules/quotations/detail-page.tsx` | NEW — crumbs Quotations / {code}; main card = `DocumentPreview`; status-driven action cards (Send / Approve / Reject / Mark expired / Convert to Invoice / Delete draft). Delete `window.confirm` → AlertDialog "Delete draft quotation {code}?". Convert → `navigateTo("invoices", [createdInvoiceId])`. Transitions re-GET the full detail. Page-level print pattern (`print:hidden` chrome + `hidden print:block` DocumentPreview). |
| `src/components/hms/modules/quotations/index.tsx` | REWRITTEN — module router (`[]` list, `["new"]`, `[id]`) + list page. Row click → `navigateTo("quotations", [r.id])`; New Quotation + EmptyState → `["new"]`. Stats/table/filters/CSV unchanged. All dialogs deleted. |
| `src/components/hms/modules/invoices/shared.tsx` | NEW — invoice types (`PaymentRow/InvoiceRow/InvoiceItemRow/InvoiceDetail/WoLite/IForm`), `METHODS`, factories, `loadCompanyName`, `DocumentPreview` incl. Paid/Balance-due rows (moved verbatim). |
| `src/components/hms/modules/invoices/new-page.tsx` | NEW — dedicated New Invoice page. Segmented source control (Manual / From completed WO) shown when `woState==="ready"`; WO path = completed WO Select (`GET /work-orders?status=COMPLETED&pageSize=100`; 403/empty hides option) + due date; Manual path = draft formKey `invoice.create` KEPT + banner, customer*, due date, shared line-items editor, discount/shipping, notes/terms, totals. Same payloads. Success → `navigateTo("invoices", [res.data.id])`. RBAC `invoices.manage` → EmptyState. |
| `src/components/hms/modules/invoices/detail-page.tsx` | NEW — crumbs Invoices / {code}; main = DocumentPreview + source attribution (quotation/WO chips link to their detail pages) + payments table card; actions: Send, Record Payment → `navigateTo("invoices", [id, "payment"])`, Cancel, Delete draft (AlertDialog "Delete draft invoice {code}?"), Print page-level. |
| `src/components/hms/modules/invoices/payment-page.tsx` | NEW — #/invoices/{id}/payment. Back "Back to Invoice" → `#/invoices/{id}`; crumbs Invoices / {code} / Record Payment. Invoice summary card (code, customer, total, paid, balance due). Amount RM* / Method / Reference / Note + live balance/status preview (`payPreview` memo kept). Validation >0 and ≤ balanceCents. POST payments → toast → `navigateTo("invoices", [id])`. Eligibility guard (DRAFT/CANCELLED/PAID/zero balance → EmptyState); RBAC `payments.record` → EmptyState. `pageDirty` via touched flag. |
| `src/components/hms/modules/invoices/index.tsx` | REWRITTEN — module router (`[]` list, `["new"]`, `[id]`, `[id,"payment"]`) + list page (KPI meta cards preserved). Row click → detail; New Invoice + EmptyState → `["new"]`. All dialogs deleted. |

## Contract compliance
- Entries read `useUi((s) => s.pages["quotations"|"invoices"]) ?? []` + `pageFromSeg`; views new/detail/payment only.
- ALL navigation via `navigateTo(module, seg)`; no direct `setPage`, no `location.hash` writes.
- PageShell on every dedicated page; back links/crumbs are hash anchors so the central dirty guard applies.
- `window.confirm` (quotations L273, invoices L289) → AlertDialog. No business Dialogs remain in either module.
- Drafts, validation, payload shapes, totals math, document previews and print output unchanged.

## Documented decisions / deviations
1. **RBAC keys**: spec said "quotations.create / invoices.create"; the permission matrix has no such keys — every quotation/invoice mutation endpoint is enforced server-side with `quotations.manage` / `invoices.manage` (also what the old New Quotation/New Invoice buttons used). Pages gate on those. Payment page gates on `payments.record` (same as the old Record Payment button).
2. **Convert navigation**: verified `POST /api/v1/quotations/{id}/convert` returns the full created invoice (id + code) → detail navigates straight to `#/invoices/{id}`; no invented endpoints.
3. **Post-transition refresh**: transition endpoints return the bare row (no items/customer), so detail pages re-GET the full detail after each transition — mirrors the old dialog's `openDetail(id)` refresh.
4. **Small navigation-only additions**: "Open invoice" card on CONVERTED quotations (uses existing `convertedInvoiceId` from GET detail) and source-attribution chips are links — consistent with the complaints linked-WO pattern.
5. **Toast polish**: transition toasts now say approved/rejected/expired (old `action+"ed"` produced "approveed"); payment/send/delete toasts unchanged.
6. **Lists no longer `print:hidden`**: the old wrapper existed only because the print-only document block lived in the same component; printing the list now prints the list.

## Verify
`bunx tsc --noEmit` → 0 errors. `bun run lint` → 0 errors/warnings. dev.log: no
compile errors for quotations/invoices/line-items-editor (a transient
customers/* module-not-found belonged to another in-flight 13-* agent task; its
files now exist and the project-wide tsc pass confirms). No dev server or
browser used per task instructions.
