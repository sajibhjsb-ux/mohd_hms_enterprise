# Task ID: 13-j — HR + IRMS → dedicated pages (no popup CRUD)

Agent: Z.ai Code (subagent, Task 13-j)
Date: 2026 build session (post 13-a/13-b infrastructure)

## Scope
Converted the HR and IRMS modules to the hash-routed dedicated-page
architecture per the 13-a/13-b contract and the complaints reference
implementation. Export names `HrModule` / `IrmsModule` unchanged (registry
untouched). No new APIs, no schema changes, no changes to
shell/router/ui-store/PageShell.

## Files written
| File | Change |
|---|---|
| `src/components/hms/modules/hr/index.tsx` | REWRITTEN — module router (`[]` list, `["attendance","new"|"id"]`, `["leave","new"]`, `["departments","new"]`) + list page. All 3 business dialogs (Mark Attendance ~L613, Leave Request ~L677, Department ~L740) deleted. Header buttons, attendance-tab button, EmptyState actions → `navigateTo("hr", …)`; attendance row Edit → `["attendance", a.id]`; departments card "+" → `["departments","new"]`. Leave inline Approve/Reject KEPT (PATCH, unchanged). |
| `src/components/hms/modules/hr/attendance-page.tsx` | NEW — dedicated Mark/Edit Attendance page. `attendanceId="new"` → create (defaults today); other id → prefill-edit: locates the record via GET /api/v1/hr/attendance as a recent-window range (366d back → 30d ahead — the record id carries no date; see deviation 1), not-found → honest EmptyState. Same prefill mapping as old `openMark`; same idempotent upsert POST (checkIn/checkOut null unless PRESENT/HALF_DAY); preserves the old "Attendance updated" vs "marked" toast nuance via a best-effort same-day lookup before POST. PageShell crumbs HR / Attendance / Mark|Edit Attendance; RBAC hr.manage guard. |
| `src/components/hms/modules/hr/leave-page.tsx` | NEW — dedicated New Leave Request page (`["leave","new"]`). `canFileForOthers` logic kept EXACTLY (`hr_manage || SUPER_ADMIN || ADMIN`); "Myself" (SELF) select option; POST /api/v1/hr/leave with `employeeId` only when canFileForOthers && selected; endDate<startDate validation (inline error + toast). Crumbs HR / Leave / New Leave Request. |
| `src/components/hms/modules/hr/department-page.tsx` | NEW — dedicated New Department page (`["departments","new"]`). Name required (inline), POST /api/v1/hr/departments `{name, description}`; "names must be unique" description kept. RBAC hr.manage guard. |
| `src/components/hms/modules/irms/index.tsx` | REWRITTEN — module router (`["projects","new"]`, `["edit"|"projects-edit"]+id` → project edit, `["reports","new"]`, `["detail"]`/`["reports"]+id` → report detail) + list page. All 3 business dialogs (Project create/edit ~L498, Report create ~L625, Report detail+print ~L802) deleted. Project row click + Pencil → `[p.id,"edit"]`; Trash2 → AlertDialog keeping BOTH old branch messages (has reports → "mark it COMPLETED instead?" soft path, confirm label "Mark COMPLETED"; else "This cannot be undone.", label "Delete project") — DELETE call/toasts unchanged. Report row click → `[r.id]`. New Project/Report + EmptyStates → navigateTo. Stats/tabs unchanged. |
| `src/components/hms/modules/irms/project-page.tsx` | NEW — BOTH project pages in one file with ZERO duplicated form logic: shared `ProjectFields` renderer + `buildPayload` + `useCustomerOptions` (degrades to null → select disabled "Unavailable", kept) + `ProjectPageScaffold` (PageShell + sticky mobile bar + SubmitErrorBanner). `IrmsProjectNewPage`: keeps `useDraft("irms.project.create")` + restore banner + autosave hint; POST; success → draft.reset → navigateTo("irms"). `IrmsProjectEditPage`: GET /api/v1/irms/projects/{id} (direct fetch exists), prefills incl. status select (edit-only), PATCH with `status`; success → navigateTo("irms") (projects have no detail page). RBAC irms.manage guards. |
| `src/components/hms/modules/irms/report-new-page.tsx` | NEW — dedicated New Inspection Report page (`["reports","new"]`). Keeps `useDraft("irms.report.create")` + restore banner; findings sub-rows (Textarea + severity Select + recommendation Input + Trash2 remove + "Add Finding") kept as component state exactly as before (never part of the draft); equipment refs degrade to null/"Unavailable" on 403 (KEPT); exact validation (project+title required; empty finding rows → toast "Some finding rows are empty"); POST with `findings[]`; success → draft.reset → `navigateTo("irms", [res.data.id])` report detail page. Projects fetched for the select (ErrorState+retry on failure). RBAC irms.manage guard. |
| `src/components/hms/modules/irms/report-detail-page.tsx` | NEW — dedicated report detail page. GET /api/v1/irms/reports/{id}; PageShell (backLabel "Back to IRMS", backHref "#/irms", crumbs IRMS / {title or code}); meta grid (Inspection Date/Inspector/Overall Condition/Project/Equipment/Findings count); findings table; Summary + Recommendations cards; print-only `#irms-print-doc` + `printCss` + `printTd/Th` styles moved to page level UNCHANGED; actions kept with exact visibility rules (Delete Draft: DRAFT+canManage; Print: always; Submit: DRAFT; Approve: SUBMITTED+canManage) in header AND contextual side cards; window.confirm → AlertDialog; DELETE → navigateTo("irms"); submit/approve → POST transition → detail refreshed via re-GET. `Meta` component moved here. |

## Dirty-state pattern
Mirrors 13-f: draft-backed pages (irms project create, irms report create) wire
`setPageDirty(draft.dirty)` (report page ORs findings-row dirtiness); non-draft
pages (hr attendance/leave/department, irms project edit) compare the form
against a JSON baseline snapshot and wire that. Cleanup clears `pageDirty` on
unmount; on successful submit `setPageDirty(false)` runs BEFORE
`navigateTo(...)` so the central guard never blocks the post-save redirect.
Error banners preserve all user entries on failed submits (contract kept).

## Documented decisions / deviations
1. **Attendance edit prefill = list-scan over a bounded recent window.** The
   record id carries no date and no single-record endpoint exists (spec:
   "fetch the attendance list … and find the record"). GET /api/v1/hr/attendance
   defaults to TODAY without params, so the page fetches the same endpoint as a
   range (from = today−366d, to = today+30d) and finds the id client-side.
   Covers every realistic edit target (the register is day-scoped); outside the
   window an honest "not found" EmptyState is shown. No new API.
2. **Mark Attendance create defaults the date to TODAY** (the old dialog
   prefilled the attendance tab's selected date, which cannot travel through
   the fixed segment contract `["attendance","new"]`). Cosmetic; user can change
   the date field.
3. **IRMS report findings are NOT added to the localStorage draft** — they were
   component state in the old dialog (the draft key only covered the main form),
   preserved as-is; the autosave hint notes findings are session-only. The
   report draft key (`irms.report.create`) and restore banner are kept.
4. **Report detail shows workflow actions both in the PageShell header and a
   contextual right-hand action card** (spec allowed "header/actions card");
   print buttons are `.no-print` so printing still yields only the document.
5. **`["projects", id, "edit"]` (3-seg) ALSO routes to the project edit page**
   (pageFromSeg → view "projects-edit") in addition to the canonical
   `[projectId, "edit"]` (view "edit") — deep links of both shapes work.
6. **HR/IRMS list buttons no longer disable on employee-list loading** — the
   dedicated pages load their own employees and self-guard (old header buttons
   referenced dialog-time state that no longer exists).
7. Non-privileged direct-URL access to any page self-guards with an RBAC
   EmptyState (page-level guard, same as complaints/13-f pattern).

## Verification
- `bunx tsc --noEmit`: **0 errors repo-wide** (final run).
- `bun run lint`: **exit 0, no output** (final run).
- No `window.confirm` and no business `Dialog` remain in hr/ or irms/ (grep
  verified; only AlertDialog for the two confirms).
- dev.log checked: no compile errors referencing modules/hr or modules/irms;
  hr/irms API endpoints returning 200. Remaining "Module not found" lines in
  dev.log belong to parallel agents' modules (customers/users/work-orders)
  mid-conversion, not this task's scope.
- Dev server not started / no browser QA (per task instructions).
