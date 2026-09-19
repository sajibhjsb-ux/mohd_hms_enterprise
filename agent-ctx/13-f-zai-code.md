# Task ID: 13-f — Employees + Technicians → dedicated pages (no popup CRUD)

Agent: Z.ai Code (subagent, Task 13-f)
Date: 2026 build session (post 13-a/13-b infrastructure)

## Scope
Converted EMPLOYEES and TECHNICIANS modules to the hash-routed dedicated-page
architecture per the 13-a/13-b contract. Export names `EmployeesModule` /
`TechniciansModule` unchanged (registry untouched).

## Files written
| File | Change |
|---|---|
| `src/components/hms/modules/employees/shared.tsx` | NEW — `EmployeeRow`, `FormState`, `EMPTY_FORM`, `formFromRow`, `payloadFor` (ringgit→cents), `extractFieldErrors`, `FieldError`, `SalaryField` (cents preview). Shared by new/edit pages + list. |
| `src/components/hms/modules/employees/department-field.tsx` | NEW — `useDepartments()` hook (GET /api/v1/hr/departments, degrades to `available=false`) + `DepartmentField` component (the shared `departmentSelect(value, onChange, idPrefix, disabled?)` helper from the old dialogs). |
| `src/components/hms/modules/employees/new-page.tsx` | NEW — dedicated New Employee page. PageShell (backLabel "Back to Employees", backHref "#/employees", crumbs Employees / New Employee). Same fields as the old create dialog; POST /api/v1/employees via `payloadFor`; RBAC `employees.create` → PageShell+EmptyState; success → `setPageDirty(false)` + `navigateTo("employees")`. |
| `src/components/hms/modules/employees/edit-page.tsx` | NEW — dedicated Edit Employee page. Status Select (ACTIVE/ON_LEAVE/TERMINATED), "employee number cannot be changed." in description; PATCH /api/v1/employees/{id}; RBAC `employees.update` → EmptyState; crumbs Employees / {employeeNo or name} / Edit. |
| `src/components/hms/modules/employees/index.tsx` | REWRITTEN — module router (`[]` list, `["new"]` new page, `[id]` detail→edit fallback, `[id,"edit"]` edit) + list page. Row click → edit page (via detail fallback); Edit pencil → `[id,"edit"]`; New Employee button + EmptyState action → `["new"]`. Terminate kept as AlertDialog (confirm only). Create/Edit dialogs deleted. |
| `src/components/hms/modules/technicians/edit-page.tsx` | NEW — dedicated Edit Skills & Rate page. Exports `TechRow` type + `parseSkills` (shared with list). Skills Input with live chip preview, specialty Input, hourly rate with cents preview + manual NaN/negative validation (toast, no request). PATCH /api/v1/technicians/{id} {skills, specialty, hourlyRate}. RBAC `users.update` → EmptyState. |
| `src/components/hms/modules/technicians/index.tsx` | REWRITTEN — module router (`[id]`→edit fallback, `[id,"edit"]` edit) + card grid. Card name click and Edit pencil → `[id,"edit"]`. Inline duty-status Select KEPT (quick action, PATCH {status} only). Editor dialog deleted. |

## Dirty-state pattern
No draft hooks existed for these forms (plain useState) — per spec, pages
register `pageDirty` via a `useEffect` comparing the form (JSON-stringify)
against the initial snapshot, and the effect cleanup clears `pageDirty` on
unmount. On successful submit, `setPageDirty(false)` is called BEFORE
`navigateTo(...)` so the central guard never blocks the post-save redirect.

## Documented decisions / deviations
1. **Employees edit prefill uses direct fetch, not list-scan.** Spec said
   "load list and find by id **if direct fetch isn't available**". Direct
   fetch IS available: `GET /api/v1/employees/{id}` returns the same contract
   as list items (plus a `user` include). Used it (no new API added), so the
   edit page cannot break when the roster exceeds pageSize=200.
2. **Technicians edit prefill follows the spec literally**: list-based —
   `GET /api/v1/technicians?pageSize=200`, find by id — because the module UI
   is typed against the list contract. `GET /api/v1/technicians/{id}` also
   exists; noted in code comments that its response shape differs from the
   list contract (workload counters via `_count`), so the spec-mandated list
   prefill was kept. Documented in file header.
3. **Duty-status Select stays inline on technician cards** (spec: quick
   action, not a form) — PATCHes `{ status }` only, unchanged.
4. **Terminate stays an AlertDialog** in the employees list row actions
   (spec: confirms may remain dialogs). No page added for it.
5. **`detail` view falls back to the edit page** for both modules (no
   separate detail pages exist) — matches the router contract
   "detail(→edit fallback)". Employees row click therefore opens the edit
   page, as specified.
6. **`useDepartments` uses a `.then()` + `alive`-flag effect** (same pattern
   as complaints new-page) to satisfy the `react-hooks/set-state-in-effect`
   lint rule; behavior identical to the old `loadDepartments`.
7. Non-privileged users: card/table click still navigates and the target
   page self-guards with an RBAC EmptyState (page-level guard, same as
   complaints assign page).

## Verification
- `bunx tsc --noEmit`: **0 errors in employees/technicians files**. (Repo-wide
  run showed transient `TS2307` errors only in `customers/` and `users/`
  modules — parallel agents' in-progress files, not this task's scope.)
- `bun run lint`: **exit 0** (full run clean after the set-state-in-effect fix).
- Dev server not run / no browser QA (per task instructions). No new APIs,
  no schema changes, no changes to shell/router/ui-store.
