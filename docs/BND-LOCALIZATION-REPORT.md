# MOHD.HMS ENTERPRISE
# BRUNEI LOCALIZATION & BND CURRENCY REPORT

## COUNTRY

Brunei Darussalam (fixed — does not follow browser location)

## CURRENCY

BND — Brunei Dollar (primary and authoritative business currency)

## CURRENCY FORMAT

`BND 1,250.00` — currency code prefix, thousands grouping, fixed 2 decimal places.
Compact symbol `B$` is reserved (constant available); the ambiguous bare `$` is never used.

## TIMEZONE

Asia/Brunei — pinned in the centralized `fmtDate`/`fmtDateTime` formatters (documents now render e.g. "18 Sept 2026" deterministically regardless of device timezone).

## CURRENCY AUDIT

Locations checked (grep sweep across `src/**` for `RM`, `MYR`, `en-MY`, `$`, `USD`, `EUR`, `GBP`, `toLocaleString`, `Intl.NumberFormat`, `toFixed`, `ringgit`, `+60`, `company.my`):

| Surface | Before | After |
|---|---|---|
| Central formatter `src/lib/hms/format.ts` | `money()` used `toLocaleString("en-MY", { currency: "MYR" })` → "RM 1,250.00" | `formatCurrency()`/`money()` → "BND 1,250.00" (deterministic, locale-independent) |
| Dashboard KPI cards (4 financial) | RM | BND (via central formatter) |
| Finance module (stat cards, ledger, receivables, chart axis) | RM + hardcoded `RM${v}k` axis | BND + `BND ${v}k` axis |
| Invoices (list, detail document, payment page, new form) | RM labels/labels | BND + "Currency: BND" on document |
| Quotations (list, detail document, new form) | RM labels | BND + "Currency: BND" on document |
| Purchases (new PO form, line totals) | "Unit cost RM" | "Unit cost (BND)" |
| Inventory (new/edit forms) | "Unit cost (RM)" | "Unit cost (BND)" |
| Work Orders (labour rate, materials — new + detail) | "Rate (RM/h)", "Cost RM", "in ringgit" | "Rate (BND/h)", "Cost (BND)", "in BND" |
| Expenses (form + validation message) | "Amount (RM)" | "Amount (BND)" |
| Technicians / Employees (hourly rate, monthly salary) | "(MYR)" | "(BND)" |
| Line-items editor (shared by invoices/quotations) | "Price RM" | "Price (BND)" |
| Server notifications + customer emails (8 strings) | "RM xxx.xx" | "BND xxx.xx" (via shared `formatCurrency`) |
| Reports screen + print header | no currency declared | "Currency: BND (Brunei Darussalam)" |
| CSV export | raw cents, no currency | "Currency: BND" header line + money columns as 2dp decimals |
| Settings → Company | phone placeholder "+60 …", currency "MYR" | "+673 …", "BND", new Country field |
| Customer forms (new/edit/detail) | no country, "+60" placeholders, "Kuala Lumpur" | Country field default "Brunei Darussalam", "+673 7123456", "Bandar Seri Begawan" |
| Vehicle odometer | `toLocaleString("en-MY")` | `toLocaleString("en-BN")` |

USD references found: **0**. EUR/GBP references found: **0**. Remaining bare-`$` currency displays: **0** (all `${` matches are TS template syntax, not currency).

## DATABASE

PostgreSQL:
- Sandbox datastore runs Prisma with the SQLite provider (container limitation). The Prisma schema is provider-portable; PostgreSQL migration requires no model changes.

Currency fields:
- **All monetary values are stored as exact integer cents** (`totalCents`, `paidCents`, `balanceCents`, `unitPriceCents`, `unitCostCents`, `amountCents`, `salaryCents`, `labourRateCents`, `discountCents`, `shippingCents`, `taxCents`, `subtotalCents`).
- Integer-cents is stricter than the spec's NUMERIC/DECIMAL floor: money is never held in a binary floating-point type, and all arithmetic is integer-based. Quantities (Float) are non-monetary.
- Existing rows were **not** converted or rewritten (§27). Formatted strings ("BND x") are never stored in numeric fields.
- Multi-currency (§19/§20): deliberately **not** built (BND-only business). `formatCurrency(amount, code)` and integer-cents storage mean a future `currencyCode` column requires no destructive redesign. No automatic conversion exists.

Financial precision: 2 decimal places end-to-end; input conversion uses the centralized `toCents()` — string-parsed, **round-half-up at 2 dp**.

Existing data: audited before changes; only additive `country` columns were added (backfilled with default "Brunei Darussalam"); no amount was altered.

## MODULES VERIFIED (real browser, admin + customer roles)

Dashboard: PASS — Total Invoiced BND 5,851.38 / Collected BND 5,252.83 / Outstanding BND 648.55 / Expenses BND 1,231.25 (values match DB aggregates exactly).
Quotations: PASS — list + document "Currency: BND", all amounts BND.
Invoices: PASS — list + document + payments table all BND.
Finance: PASS — Income/Expenses/Net profit/Receivables BND; chart axis "BND 0/2k/3k…"; ledger rows BND.
Purchases: PASS — "Unit cost in BND", line totals BND 0.00 placeholders.
Inventory: PASS — "Unit cost (BND)" in new/edit forms.
Work Orders: PASS — labour "0h × BND 0.00/h", materials BND.
Customer Portal: PASS — customer-scoped invoices all BND (isolation re-verified: cross-tenant invoice → 404).
Reports: PASS — print header "Currency: BND (Brunei Darussalam)"; CSV export carries the same line + 2dp money columns.
PDF: PASS — Invoice PDF and Quotation PDF generated via print media; both show "Currency: BND" and BND amounts only.

## TESTING

Desktop: PASS — admin (dashboard KPIs, finance, invoices list/detail/payment, quotations, purchases, inventory, work orders, expenses, settings) and customer portal; every financial surface shows BND.
Mobile: PASS — 375×720 dashboard + invoices; no horizontal overflow (`scrollWidth == clientWidth`), BND rendering intact.
PDF: PASS — `/tmp/invoice-bnd.pdf`, `/tmp/quotation-bnd.pdf` (print-media renders; "Currency: BND" line + BND-only amounts).
Print: PASS — same page-level print document as PDF (shared `DocumentPreview` component).
Database: PASS — integer-cents storage verified by direct queries; UI values reconcile with SQL aggregates to the cent.
Redis: PASS (N/A-safe) — **no Redis client exists in the codebase**; the only cache is a 60-second in-process TTL map over the DB-backed `Setting` table. Clearing it cannot lose invoices/quotations/payments. PostgreSQL (SQLite-file in sandbox) remains the sole source of truth.

### Calculation & rounding tests (backend-authoritative, via live API)

§42: quotation 10 × BND 25.00 → server computed `subtotalCents: 25000` = **BND 250.00** (test row deleted after verification).
§43 rounding policy (round-half-up at 2 dp, string-parsed `toCents` — no binary float):

| Input | Stored cents | Displayed |
|---|---|---|
| 0.01 | 1 | BND 0.01 |
| 10.55 | 1055 | BND 10.55 |
| 100.005 | 10001 | BND 100.01 |
| 999.999 | 100000 | BND 1000.00 |

All 14 server routes that convert user amounts (`purchases`, `quotations`, `invoices`, `payments`, `expenses`, `inventory`, `employees`) now use the centralized `toCents()` instead of `Math.round(x * 100)`.

### Live payment test (§36)

Payment of BND 50.00 on INV-2026-0009 → balance BND 300.00 → **BND 250.00**, status PARTIALLY_PAID; notification + customer email rows read "Payment of **BND 50.00** received…". (A historical "RM 760.00" notification row predates this change and is preserved as history per §27.)

## ISSUES FOUND

| ID | Module | Issue | Root Cause | Fix | Retest |
|----|--------|-------|------------|-----|--------|
| B1 | Global | Currency displayed as "RM" everywhere | Central `money()` used `en-MY`/`MYR` locale | Rewrote formatter to deterministic `BND` prefix format; single choke point fixed 25 files | PASS |
| B2 | Notifications/Emails (server) | 8 hard-coded "RM xxx.xx" strings | Manual `RM ${(cents/100).toFixed(2)}` formatting in 3 API/workflow files | Replaced with shared `formatCurrency()` import | PASS (DB-verified) |
| B3 | Finance chart | Y-axis ticks "RM2k" | Hardcoded tickFormatter | `BND ${…}` + axis width | PASS |
| B4 | All API routes | `Math.round(x * 100)` float-drift on amounts (e.g. 100.005 → 100.00) | Binary float multiplication | 14 routes migrated to centralized string-parsed `toCents()` (half-up) | PASS (§43 table) |
| B5 | Customers/Reports/Settings UI | "+60"/"Kuala Lumpur"/"MYR"/".my" placeholders | Malaysian defaults baked into forms | Replaced with Brunei defaults (+673, Bandar Seri Begawan, BND, .bn) | PASS |
| B6 | Localization | No country/timezone/phone configuration anywhere | — | `LOCALIZATION` constants (constants.ts) + Settings → Localization tab + `country` columns (Customer/Supplier/Employee, additive, backfilled) + Asia/Brunei pinned in date formatters | PASS |
| B7 | Dev runtime | Customers API returned 500 "Unknown field `country`" after schema push | Next.js dev server held a pre-migration Prisma client in its cache | Regenerated client, cleared `.next`, restarted server | PASS (0 × 5xx after restart) |

## FINAL STATUS

**PASS**

- BND is the default, authoritative, and only business currency; no USD, no ambiguous `$`.
- One centralized formatter (`formatCurrency`/`money`/`toCents` in `src/lib/hms/format.ts`); no manual currency formatting in components.
- Backend is authoritative for all financial totals; storage is exact integer cents (never float, never formatted strings).
- Brunei Darussalam / BN / BND / B$ / en-BN / Asia/Brunei / +673 applied as centralized application settings (Settings → Localization).
- PostgreSQL remains authoritative (SQLite provider in sandbox — model layer is PostgreSQL-ready); Redis is absent and cannot become a source of financial truth.
- Real-browser (desktop + 375px mobile), API, PDF/print and database verification completed as documented above.
