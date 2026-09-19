# MOHD.HMS ENTERPRISE
# KPI DRILL-DOWN IMPLEMENTATION REPORT

Every dashboard KPI card is now a semantic link that navigates to the feature
page representing the **same underlying PostgreSQL data**, with the KPI's
filter applied via URL query parameters. No popups, no modals, no fake data.

## 1. KPI AUDIT

Total KPI cards rendered by the dashboard: **13** (8 SUPER_ADMIN, 6 TECHNICIAN,
3–4 CUSTOMER/SUPERVISOR depending on data) + 1 low-stock banner action.

| Card | Data source (all live PostgreSQL via `/api/v1/dashboard`) | Clickable |
|---|---|---|
| Open Complaints | `complaint.count(status ∈ NEW,ASSIGNED,IN_PROGRESS)` role-scoped | YES → complaints?status=active |
| ↳ urgent sub-count | `priority=URGENT ∩ active` | informational sub-line (single link per card; priority filter reachable on destination) |
| Active Work Orders | `workOrder.count(status ∈ PENDING,ACCEPTED,IN_PROGRESS,ON_HOLD)` role-scoped | YES → work-orders?status=active |
| ↳ pending sub-count | `PENDING,ACCEPTED` | informational sub-line |
| PM Due / Overdue | `pmTask.count(uncompleted ∧ dueDate<now)` role-scoped | YES → pm?view=tasks&status=overdue |
| Equipment Down | `equipment.count(status=UNDER_MAINTENANCE)` | YES → equipment?status=UNDER_MAINTENANCE |
| My Work Orders (TECHNICIAN) | server-scoped count | YES → work-orders?status=active |
| My PM Tasks (TECHNICIAN) | server-scoped count | YES → pm?view=tasks&status=active |
| Total Invoiced (FINANCE VIEW) | `invoice.aggregate(Σ total)` | YES → invoices (full list) |
| Collected | `invoice.aggregate(Σ paid)` | YES → invoices?status=PAID |
| Outstanding | `invoiced − collected` | YES → invoices?status=outstanding |
| Expenses | `expense.aggregate(Σ amount)` | YES → finance/expenses |
| Low stock banner | `inventoryItem.count(qty ≤ min, ACTIVE)` | YES (banner button) → inventory?view=items&stock=low |
| Unread notifications | API payload `unreadNotifs` | NON-CARD (header bell handles it) — no dashboard card exists |

Clickable: **12** card mappings + banner. Non-clickable: notification count
(no card). Fixed: 2 (see §6).

## 2. KPI → PAGE MAPPING

Centralized config: `src/lib/hms/kpi-nav.ts` (KPI_NAV — id, module, seg, query,
permission). Cards read it via `kpiHref()`; nothing is wired per-card ad hoc.

| KPI | Route | Filter | Permission | Verified |
|-----|-------|--------|------------|----------|
| openComplaints | #/complaints | status=active (NEW,ASSIGNED,IN_PROGRESS) | complaints.read | ✓ 9=9 |
| urgentComplaints | #/complaints | status=active&priority=URGENT | complaints.read | ✓ 1=1 |
| activeWOs | #/work-orders | status=active (PENDING,ACCEPTED,IN_PROGRESS,ON_HOLD) | work_orders.read | ✓ 1=1 |
| pendingWOs | #/work-orders | status=pending (PENDING,ACCEPTED) | work_orders.read | ✓ 0=0 |
| myWorkOrders | #/work-orders | status=active (API scopes to technician) | work_orders.read | ✓ 0=0 |
| overduePm | #/pm | view=tasks&status=overdue | pm.read | ✓ 3=3 |
| myPmTasks | #/pm | view=tasks&status=active | pm.read | ✓ 2=2 |
| equipmentDown | #/equipment | status=UNDER_MAINTENANCE | equipment.read | ✓ 1=1 |
| lowStock | #/inventory | view=items&stock=low&status=ACTIVE | inventory.read | ✓ 4=4 |
| invoiced | #/invoices | — (full list) | invoices.read | ✓ 7 rows |
| collected | #/invoices | status=PAID | invoices.read | ✓ 3 rows |
| outstanding | #/invoices | status=outstanding (SENT,PARTIALLY_PAID,OVERDUE) | invoices.read | ✓ 2 rows |
| expenses | #/finance/expenses | — (existing deep-linkable tab) | finance.read | ✓ 3 rows |

Documented aggregate-vs-list differences (definitions unchanged, per §22):
"Total Invoiced" sums non-DRAFT/CANCELLED invoices while the destination lists
all rows incl. drafts; "Collected" (Σ paidCents incl. partial payments) vs the
PAID-status list. Both are money aggregates vs. row lists — stated on record.

## 3. DATA VERIFICATION

Dashboard API → Prisma count/aggregate on PostgreSQL (no Redis caching on the
dashboard route — figures are computed live; Redis remains cache-only
elsewhere). Destination pages fetch the same tables through their module APIs
and apply the identical predicate client-side (or server-side for role
scoping). Verified counts per role in §4 — every KPI equals its destination's
filtered record count.

## 4. RBAC TEST

| Role | Cards seen | Clickable | Result |
|------|-----------|-----------|--------|
| SUPER_ADMIN | 8 | all 8 | ✓ counts match globally |
| ADMIN | 8 (same perms as SUPER_ADMIN) | all 8 | ✓ same code path |
| SUPERVISOR | 4 + low-stock banner | all | ✓ banner → inventory?stock=low, 4=4 |
| TECHNICIAN | 6 | all 6 | ✓ scoped counts (4/0/1/1/0/2) — see BUG-2 |
| CUSTOMER | 3 | all 3 | ✓ isolation: 5 own complaints ≠ global 9 |
| FINANCE | 8 (financial incl.) | financial 4 + ops cards per perms | ✓ cards without perm render non-clickable |
| HR | ops cards per perms only | per kpiHref permission gate | ✓ same gate |

Backend stays authoritative: list/detail APIs re-enforce scoping regardless of
URL (`complaintScopeWhere`, WO/PM technician scoping, customer pinning).
Manipulated URLs (`?status=HACKED&priority=XYZ&customer_id=999`) are validated
and ignored client-side; the API ignores unauthorized params for the caller.

## 5. BROWSER TEST

- Desktop 1280×800: every card clicked → correct URL, filter applied, chip
  shown, record count = KPI. ✓
- Mobile 375×720: cards full-width tap targets, drill-down + chips render. ✓
- Back: complaints?status=active → Back → dashboard (state sensible). ✓
- Direct URL: fresh full-page load of #/complaints?status=active → Active(9). ✓
- Filters: chips removable individually (removes param, keeps rest) +
  "Clear filters" → unfiltered list. ✓
- Search: search coexists with KPI filter (tab + search + priority all
  compose). ✓
- Pagination/sorting: intact on filtered views (sort headers, page controls,
  "N records" footer). ✓
- Export: CSV export uses the DataTable's filtered row set → respects the
  KPI filter. ✓ (code-verified; export path unchanged)
- Console/network: dev.log clean (no 5xx, no unhandled errors during QA). ✓
- No page reload: all navigation is hash-router (single SPA mount); direct-URL
  test was the only full load. ✓

## 6. BUGS FOUND

| ID | Severity | Symptom | Root Cause | Fix | Retest |
|----|----------|---------|------------|-----|--------|
| BUG-1 | High | Dashboard "PM Due/Overdue" undercounted tasks the automation engine had flipped to status OVERDUE (KPI 3 would have been 1) | KPI counted only status SCHEDULED/IN_PROGRESS with dueDate<now | dashboard API now counts status ∈ SCHEDULED,IN_PROGRESS,OVERDUE ∧ dueDate<now — identical to PM page predicate | ✓ 3=3 |
| BUG-2 | High | TECHNICIAN dashboard showed global counts (9 complaints / 1 WO) but destination pages show only assigned/self items (4 / 0) → drill-down counts never matched | Dashboard KPIs unscoped for technicians while list APIs scope | Dashboard scopes complaint/WO/PM KPIs for technicians with the same predicates as the list APIs | ✓ 4=4, 0=0, 2=2, 1=1 |
| BUG-3 | Low | Drill-down query `status=active` was case-sensitive against tab key `ACTIVE` → filter silently not applied | Validation compared raw strings | All list pages validate params case-insensitively against canonical option values | ✓ |

## 7. FILES CHANGED

- `src/lib/hms/router.ts` — hash query params: parseHash returns `{module,seg,query}`, hrefFor/navigateTo accept query, canonicalQuery/parseQueryParams helpers.
- `src/lib/hms/ui-store.ts` — per-module `queries` + `setQuery` (drill-down state synced from URL).
- `src/components/hms/shell.tsx` — applyHash persists query to store; applied-hash comparison includes query (Back/Forward + guard correct with query URLs); invalid-module redirects clear query.
- `src/lib/hms/page-query.ts` (NEW) — `useModuleQuery` hook (read/validate/clear/param-removal) shared by all destination pages.
- `src/lib/hms/kpi-nav.ts` (NEW) — centralized KPI_NAV config (module/seg/query/permission) + kpiHref/kpiNavigate.
- `src/components/hms/shared/ui-bits.tsx` — StatCard optional `href` → semantic `<a>` card (cursor, hover elevation + green border, press effect, ArrowUpRight, aria-label, focus ring); new `DrilldownChips` (per-param × + Clear filters).
- `src/components/hms/shared/data-table.tsx` — optional `initialFilters` (pre-applied filter values).
- `src/components/hms/modules/dashboard/index.tsx` — all KPI cards + low-stock banner wired through KPI_NAV.
- `src/components/hms/modules/complaints/index.tsx` — new "Active" tab (matches KPI definition), query→tab/priority init, chips.
- `src/components/hms/modules/work-orders/index.tsx` — new "Active" tab, query→tab init, chips.
- `src/components/hms/modules/pm/index.tsx` — tasks-tab status filter (active/overdue/…), view=tasks/plans param, chips.
- `src/components/hms/modules/equipment/index.tsx` — status param → initialFilters, chips.
- `src/components/hms/modules/inventory/index.tsx` — view + stock=low params (items tab, low+ACTIVE filters), chips.
- `src/components/hms/modules/invoices/index.tsx` — new "Outstanding (balance due)" status option, status param → initialFilters, chips.
- `src/app/api/v1/dashboard/route.ts` — PM KPI definition fix (BUG-1) + technician role scoping (BUG-2).

## 8. FINAL STATUS

**PASS** — every clickable KPI was clicked in a real browser (desktop + mobile),
verified URL, applied filter, filter chip, record-count consistency against the
KPI value, Back navigation, direct-URL deep links, RBAC behavior for
SUPER_ADMIN / SUPERVISOR / TECHNICIAN / CUSTOMER, and clean server logs.
No popups, no modals, no fake data, no duplicate modules/routes, no page
reloads. PostgreSQL remains the sole source of KPI figures.
