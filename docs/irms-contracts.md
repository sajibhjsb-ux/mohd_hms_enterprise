# IRMS ENTERPRISE EXTENSION — IMPLEMENTATION CONTRACT (single source of truth)

Spec: upload/Pasted Content_1789733090944.txt (71 sections). This file binds backend (Task 20-a)
and frontend (Task 20-b) agents to ONE contract. Do not deviate; if something is impossible,
report it in worklog instead of silently changing the contract.

Existing infra to REUSE (do not duplicate):
- handler()/ok/okList/parseBody/listQuery/pagedMeta/Errors from src/lib/hms/api.ts
- audit()/notify()/notifyRole()/nextNumber() from src/lib/hms/services.ts
- emit() from src/lib/hms/workflows/bus.ts (supports tx), EVENT_TYPES in workflows/types.ts
- IRMS_STATUSES / IRMS_TRANSITIONS / IRMS_PHOTO_CATEGORIES / IRMS_PHOTO_PREFIX / IRMS_SIGNATURE_ROLES / PRIORITIES from src/lib/hms/constants.ts
- Permissions: irms.read (staff view), irms.create (create/edit-own/upload/AI), irms.manage (review/approve/archive/any-edit/bulk), irms.portal (customer). Role matrix already wired in constants.ts (TECHNICIAN has read+create; SUPERVISOR/ADMIN/SUPER_ADMIN read+create+manage; CUSTOMER portal only).
- PDF: src/lib/hms/pdf/engine.ts (PdfDoc), documents.ts registry (inspection-report def exists), route /api/v1/pdf/[type]/[id], frontend pdf-client.ts + shared/pdf-buttons.tsx (PdfButtons).
- Realtime: emit() → outbox → dispatcher (rooms resolved in realtime/dispatcher.ts, already wired for IRMS events incl. customer-visible approvals) → socket.io → useRealtimeEvent(module matrix "irms").
- Money: BND money()/formatCurrency() (format.ts). Dates: fmtDate/fmtDateTime (Asia/Brunei). humanize()/STATUS_TONE for badges.
- UI: ui-bits.tsx (StatCard w/ href, StatusBadge, PageHeader, LoadingState, EmptyState, ErrorState, DrilldownChips), PageShell (page-shell.tsx), useDraft (hooks/use-draft.ts), useSession, useModuleQuery, navigateTo/hrefFor (router.ts), api client (api-client.ts), useToast, shadcn components in src/components/ui, lucide icons, @dnd-kit/core+sortable (installed), recharts (installed), sharp (installed), qrcode (installed).

## Status workflow (§29)
DRAFT →(submit)→ SUBMITTED →(review)→ IN_REVIEW →(manager_approve)→ MANAGER_APPROVAL
  →(client_request)→ CLIENT_REVIEW →(client_approve)→ APPROVED →(archive)→ ARCHIVED
  reject: from SUBMITTED/IN_REVIEW/MANAGER_APPROVAL/CLIENT_REVIEW → REJECTED; reopen: REJECTED → DRAFT
  approve also allowed directly from MANAGER_APPROVAL (client review skipped) and from CLIENT_REVIEW (by staff).
CLIENT_REVIEW customer confirm/reject via portal routes.

## Storage layout (filesystem, NOT in PostgreSQL)
Base dir: `path.join(process.cwd(), "uploads", "irms")`. Photos: `{reportId}/{photoId}-{variant}.{ext}`
variant ∈ original|display|thumb. Signatures: `{reportId}/signatures/{signatureId}.png`.
Store RELATIVE paths (from uploads/irms) in DB columns storagePath/displayPath/thumbPath.
MIME whitelist: image/jpeg, image/png, image/webp. Max upload size 15MB per file.
sharp processing: rotate() (EXIF orientation) → display = max edge 1600px jpeg q82; thumb = max edge 320px jpeg q78.
Original stored EXACTLY as uploaded (non-destructive, §14/§16). Never delete originals when annotating.
photoNo numbering: per category prefix (B/A/P/D/I/C/F/E) + 3-digit sequence in sortOrder order, regenerated
after every upload/delete/category-change/reorder (e.g. B001, B002…).

## API CONTRACT — all routes under src/app/api/v1/irms/** (handler()-wrapped, zod, audit, emit)

Auth vocabulary: STAFF_READ=irms.read; CREATE=irms.create; MANAGE=irms.manage; PORTAL=irms.portal.
"Editable report" = status ∈ {DRAFT, REJECTED}. "Owner" = report.inspector.userId === user.id.
"Review-active" = status ∈ {SUBMITTED, IN_REVIEW, MANAGER_APPROVAL, CLIENT_REVIEW}.
Overdue predicate (§35): inspectionDate < today(start of day, server) AND status ∈ {DRAFT,SUBMITTED,IN_REVIEW,MANAGER_APPROVAL,CLIENT_REVIEW}.

### 1. GET /api/v1/irms/reports  (STAFF_READ)
Query: page, pageSize, search (code|title|project.name), status (comma-separated list), projectId,
inspectorId, type, priority, overdue="1", mine="1" (inspector.user.id === caller), from, to (YYYY-MM-DD on inspectionDate).
Include: project{id,code,name,customerId,customer{companyName}}, equipment{id,name,assetTag},
inspector{id,employeeNo,user{id,name}}, workOrder{id,code}, _count{photos,findings}.
Return okList(items, { ...pagedMeta, stats: {total, drafts, pendingReview(SUBMITTED+IN_REVIEW+MANAGER_APPROVAL+CLIENT_REVIEW), approved, rejected, archived, overdue, activeProjects} }).

### 2. POST /api/v1/irms/reports  (CREATE)
zod body: { projectId (must exist), equipmentId?, workOrderId?, title (1..200), type ∈ ROUTINE|SAFETY|EQUIPMENT|PROJECT|OTHER,
priority ∈ PRIORITIES, inspectionDate ISO date, inspectorId? (only MANAGE may assign someone else),
summary?, overallCondition?, recommendations?, customerVisible?, jobOrderNo?, building?, floor?, room?,
taskDescription?, scope?, notes?, correctiveActions?, rootCause?, safetyNotes?, materials?,
labourHours (0..9999), completionPercent (0..100), findings?: [{finding (1..2000), severity, recommendation?}] }.
inspectorId defaults to caller's own TechnicianProfile; if caller has none and none provided → 400 with clear message.
code=nextNumber("INS"), status=DRAFT. audit INSPECTION_CREATED (resourceType INSPECTION_REPORT).
emit IRMS_REPORT_UPDATED. Return ok(report id + code).

### 3. GET /api/v1/irms/reports/[id]  (STAFF_READ)
Full detail: report (all fields) + project(+customer) + equipment + workOrder{id,code,title,customerId} +
inspector{id,employeeNo,user{name}} + findings + photos (ordered category-canonical→sortOrder; include exif+annotation for staff)
+ signatures + approvals (desc, latest first) + revisions (id, version, note, createdByName, createdAt — no snapshot blob).
photos item: {id, category, photoNo, sortOrder, caption, swRef, room, building, width, height, sizeBytes,
mimeType, cameraModel, takenAt, rotation, annotation, urls:{thumb,display,original}} — urls are RELATIVE api paths
`/api/v1/irms/photos/{id}/file?variant=thumb|display|original`.

### 4. PATCH /api/v1/irms/reports/[id]  (CREATE owner | MANAGE any) — editable reports only → else 422
Partial body = POST body minus required fields; findings present ⇒ full replace (deleteMany+createMany in $transaction).
audit INSPECTION_UPDATED; emit IRMS_REPORT_UPDATED.

### 5. DELETE /api/v1/irms/reports/[id]  (MANAGE | owner) — DRAFT only → else 422. audit INSPECTION_DELETED.

### 6. POST /api/v1/irms/reports/[id]/transition  (body {action, comment?}) — see workflow matrix above.
Enforcement per action (server-side, roleCan + ownership):
- submit: owner|MANAGE, DRAFT→SUBMITTED; set submittedAt/By; auto-create revision snapshot (version=1, note "Submitted");
  notifyRole ADMIN + notify inspector (IN_APP); audit INSPECTION_SUBMITTED; emit INSPECTION_SUBMITTED.
- review: MANAGE, SUBMITTED→IN_REVIEW; reviewedAt/By; notify inspector; audit INSPECTION_REVIEWED; emit INSPECTION_REVIEWED.
- manager_approve: MANAGE, IN_REVIEW→MANAGER_APPROVAL; audit INSPECTION_REVIEWED (step MANAGER_APPROVAL); emit INSPECTION_REVIEWED.
- client_request: MANAGE, MANAGER_APPROVAL→CLIENT_REVIEW; force customerVisible=true; notify all portal users of project.customerId
  ("Client review requested for report {code}"); audit INSPECTION_REVIEWED (step CLIENT_REQUEST); emit INSPECTION_REVIEWED.
- client_approve: MANAGE or (PORTAL user whose user.customerId === project.customerId) from CLIENT_REVIEW → APPROVED;
  approvedAt/By; clientComment=comment if given; revision snapshot; audit INSPECTION_APPROVED; emit INSPECTION_APPROVED (+INSPECTION_COMPLETED for legacy listeners).
- approve: MANAGE, from MANAGER_APPROVAL|CLIENT_REVIEW → APPROVED; same side-effects as client_approve minus clientComment.
- reject: MANAGE (or PORTAL owner-customer while CLIENT_REVIEW, comment required) → REJECTED; rejectedAt/By;
  notify inspector; audit INSPECTION_REJECTED; emit INSPECTION_REJECTED.
- reopen: owner|MANAGE, REJECTED→DRAFT; audit INSPECTION_REOPENED; emit IRMS_REPORT_UPDATED.
- archive: MANAGE, APPROVED→ARCHIVED; archivedAt; audit INSPECTION_ARCHIVED; emit INSPECTION_ARCHIVED.
Every successful action writes InspectionApproval {step, fromStatus, toStatus, comment, userId, userName}.
Invalid transition → Errors.invalidTransition. Respond ok(updated report {id, code, status, revision}).

### 7. Revisions
POST /api/v1/irms/reports/[id]/revisions  (MANAGE) — manual snapshot {note} → version=report.revision+1; report.revision=version.
POST /api/v1/irms/reports/[id]/revisions/[revisionId]/restore  (MANAGE) — editable reports only; restore report fields
from snapshot JSON (fields only; photos/signatures/approvals untouched); audit INSPECTION_REVISION_RESTORED; emit IRMS_REPORT_UPDATED.
Snapshot shape: {report fields..., findings:[...]}.

### 8. Photos
GET /api/v1/irms/reports/[id]/photos (STAFF_READ) → okList(items same shape as detail photos).
POST /api/v1/irms/reports/[id]/photos — multipart formData: files (one or many), category.
  Auth: owner|MANAGE. Status rules: editable → owner|MANAGE; review-active → MANAGE only (evidence during review);
  APPROVED/ARCHIVED → 422. Validate MIME+extension+size; sharp process; create rows; regenerate photoNo for that category;
  audit INSPECTION_PHOTO_UPLOADED (metadata {count, category}); emit IRMS_PHOTOS_UPDATED. Return ok(items).
PATCH /api/v1/irms/photos/[id] — {caption?, swRef?, room?, building?, category?, rotation? (0|90|180|270),
  annotation? (JSON string, max 50_000 chars, shape [{type:"arrow"|"circle"|"rect"|"highlight"|"text", x,y,w,h, color?, text?}] normalized 0..1)}.
  Auth: owner|MANAGE and report not APPROVED/ARCHIVED. Category change regenerates numbering. audit INSPECTION_PHOTO_UPDATED; emit IRMS_PHOTOS_UPDATED.
DELETE /api/v1/irms/photos/[id] — same auth; delete files + row; regenerate numbering; audit INSPECTION_PHOTO_DELETED; emit IRMS_PHOTOS_UPDATED.
GET /api/v1/irms/photos/[id]/file?variant=thumb|display|original — auth: STAFF_READ, or PORTAL user when
  report is APPROVED (or ARCHIVED) AND customerVisible AND project.customerId === user.customerId.
  Stream file (fs.readFile) with correct Content-Type, Cache-Control: private, max-age=3600. 404 when file missing.
POST /api/v1/irms/reports/[id]/photos/reorder — {ids: [photoId...]} full desired global order (owner|MANAGE, editable or review-active+MANAGE);
  set sortOrder=index; regenerate all photoNo; audit INSPECTION_PHOTOS_REORDERED; emit IRMS_PHOTOS_UPDATED.
POST /api/v1/irms/reports/[id]/photos/bulk — {action: "delete"|"moveCategory"|"rotate"|"setRoom"|"setSwRef", photoIds[], value?};
  auth: owner|MANAGE with the same status rules as upload; server-side only; audit INSPECTION_PHOTOS_BULK {action, count}; emit IRMS_PHOTOS_UPDATED.

### 9. Signatures
GET /api/v1/irms/reports/[id]/signatures (STAFF_READ | portal-authorized) → okList(items {id, role, name, signedAt, revision, url}).
POST /api/v1/irms/reports/[id]/signatures — multipart {role, name, image (PNG blob/dataURL string)}.
  Auth: role INSPECTOR → owner|MANAGE; SUPERVISOR|MANAGER → MANAGE; CLIENT → PORTAL user of owning customer (CLIENT_REVIEW/APPROVED) | MANAGE.
  Save PNG file; keep history (never overwrite rows); set revision=report.revision; audit INSPECTION_SIGNED; emit IRMS_REPORT_UPDATED.
GET /api/v1/irms/signatures/[id]/file — same authorization as photos file route. Streams PNG.

### 10. GET /api/v1/irms/dashboard (STAFF_READ)
ok({ kpis: {total, drafts, submitted, inReview, managerApproval, clientReview, approved, rejected, archived,
overdue, activeProjects, avgCompletion (rounded int, avg completionPercent over non-DRAFT/ARCHIVED), photos,
mine (reports where inspector.user.id=caller)}, recent: [5 latest reports w/ list-include shape], byStatus: [{status,count}] })

### 11. GET /api/v1/irms/analytics?from&to (STAFF_READ; default last 12 months)
ok({ byStatus:[{status,count}], byType:[{type,count}], byProject:[{project, count}] top 10,
byInspector:[{inspector, count}] top 10, monthly:[{month:"YYYY-MM", created, approved}],
defectSeverity:[{severity,count}], avgApprovalHours (number|null, approvedAt-submittedAt average) })

### 12. GET /api/v1/irms/calendar?from&to (STAFF_READ; required from/to, max 62 days)
okList(items {id, code, title, status, priority, inspectionDate, project{name}, inspector{name}})

### 13. GET /api/v1/irms/meta (STAFF_READ)
ok({ projects:[{id,code,name,customerId,customer{companyName},siteLocation}] (500),
workOrders:[{id,code,title,customerId,description,priority,status,equipmentId,equipment{name,assetTag},
customer{companyName},technician{user{name}}}] (500, desc),
equipment:[{id,name,assetTag,serialNumber,manufacturer,model,category,customerId,status,location{name}}] (500),
customers:[{id,companyName}] (500),
inspectors:[{id,employeeNo,user{name}}] (active technicians) })

### 14. Customer portal (PORTAL permission; ALL routes force user.customerId scoping)
GET /api/v1/irms/portal — reports where project.customerId=user.customerId AND customerVisible AND
  status ∈ {CLIENT_REVIEW, APPROVED, ARCHIVED}; list shape without internal fields.
GET /api/v1/irms/portal/[id] — same scoping else 404 (existence hidden). Response strips: notes, rootCause,
safetyNotes, exif (photos), workOrderId/jobOrderNo internal bits, submittedById etc. Include photos(urls)+signatures+findings.
POST /api/v1/irms/portal/[id]/confirm — {decision: "confirm"|"reject", comment?} — customer-only;
  only when status=CLIENT_REVIEW; confirm → clientApprove path (clientComment=comment); reject → reject path;
  audit INSPECTION_CLIENT_CONFIRMED/REJECTED; emits per transition routes.
PDF for customers: extend existing /api/v1/pdf/inspection-report/[id] loader with customer scoping
  (customer sees only own-customer AND customerVisible AND status ∈ APPROVED|ARCHIVED; others → 404).

### 15. POST /api/v1/irms/ai/generate (CREATE | MANAGE)
Body {field ∈ remarks|correctiveAction|recommendation|summary|safetyNotes|rootCause, context}.
context: {title?, type?, overallCondition?, findings?: [{finding,severity,recommendation}], scope?, equipment?, project?, hint?}.
Server-only z-ai-web-dev-sdk (src/lib/hms/ai.ts helper, follows LLM skill docs; max ~180 words output, professional
inspection-report tone, no fabricated facts, disclaimer comment). Return ok({text}). NEVER auto-save; frontend previews first (§10).
Structured API error on failure (friendly message; SUPER_ADMIN gets detail via handler wrapper).

### 16. GET /api/v1/irms/reports/[id]/qr (STAFF_READ | portal-authorized) — PNG QR encoding absolute URL
`${origin}/#/irms/reports/{id}` (origin from request headers x-forwarded-proto/host, localhost fallback).
RBAC still applies on arrival (QR never bypasses auth, §34). Content-Type image/png.

### 17. PDF extension (Task 20-a owns these files)
- engine.ts: ADD methods (extend, do not break existing): `photoGrid(pages: {caption: string; number: string; bytes: Buffer|Uint8Array}[][])`
  — renders 3×3 grids, each inner array = one page of ≤9 cells (caption+number under each cell, contain-fit, no distortion);
  `qr(png: Buffer|Uint8Array, opts?: {caption?})` — embeds QR + caption; `signatureImage(items: {caption; name?; img?: Buffer|Uint8Array}[])`
  — signature lines with embedded signature PNG when present. Keep A4 portrait.
- documents.ts inspection-report def: extend renderer → job info kvGrid (JOB ORDER NO / WORK ORDER / WORK CATEGORY / START(completed) /
  BUILDING-UNIT / SITE / WORK DESCRIPTION from actual DB fields), work details (task description/scope/corrective/root cause/
  recommendation/safety notes/materials/labour hours/completion %), findings table (existing), PHOTO SECTIONS: canonical category
  order (BEFORE,AFTER,PROGRESS,DURING,INSPECTION,COMPLETION,DEFECT,EVIDENCE) — one heading per category with photos, 3×3 grid
  pages via photoGrid, categories NEVER mixed on one page, each category finishes before next starts, photos ordered by
  sortOrder using DISPLAY variant files read from disk (sequential processing, §52), missing file → placeholder cell text.
  SIGNATURES section via signatureImage (latest per role from InspectionSignature), APPROVAL HISTORY table (step/from→to/user/date),
  REVISION line (Rev N), QR via qr() at footer area of first page (encode same URL as endpoint 16 — pass origin into
  buildDocument; extend pdf route to forward request origin). Filename unchanged.
- pdf route /api/v1/pdf/[type]/[id]: forward `origin` (x-forwarded-proto + host) into buildDocument(def, id, user, branding, origin).
  Customer scoping for inspection-report (see 14).

## FRONTEND CONTRACT — src/components/hms/modules/irms/** (Task 20-b owns ALL files there)
Files: index.tsx (router), irms-dashboard.tsx, irms-reports-list.tsx, irms-report-builder.tsx,
irms-report-detail.tsx, irms-photo-manager.tsx, irms-signature-pad.tsx, irms-annotation.tsx,
irms-calendar.tsx, irms-analytics.tsx, irms-portal.tsx, irms-project-page.tsx (KEEP existing), project pages unchanged.
Module router switch (index.tsx):
- user.role === "CUSTOMER" → <IrmsPortalPage /> for every irms hash (customers get only portal views; deep link #/irms/reports/{id} → portal detail inside IrmsPortalPage via useUi pages["irms"]).
- seg=[] → IrmsDashboardPage
- pageFromSeg: view "detail" && id ∈ {reports, projects, calendar, analytics} → that section (single-segment quirk);
  view "reports" && id="new" → builder(new); view "reports" && id → detail(id); view "reports-edit" && id → builder(edit, id);
  view "projects" && id="new" → existing project new; view "projects-edit" && id → existing project edit;
  view "projects" && id → existing project detail; default → IrmsDashboardPage.
Query drill-down: reports list reads useModuleQuery("irms").params for initial filters; chip removal navigates via
navigateTo("irms", ["reports"], nextParams) — NOT useModuleQuery.apply (it drops segments). Support params: status (comma list),
overdue=1, projectId, mine, priority, type. Render DrilldownChips from active params.
Requirements (spec §6-§9, §53-§57): dedicated pages (NO giant modals); 5 tabs (DETAILS, WORK DETAILS, PHOTOS, SIGNATURES, APPROVAL)
in BOTH builder and detail; responsive 375px (touch targets ≥44px, no horizontal overflow); dirty-guard via useUi setPageDirty +
useDraft autosave ("irms.report.new"/"irms.report.edit") showing Saving…/Saved/Save failed states honestly; drag-and-drop reorder
via @dnd-kit sortable WITH keyboard alternative (up/down buttons per photo, §55); paste-upload (window paste listener);
camera capture (<input type=file accept="image/*" capture=environment>); upload progress via XHR/fetch per-file states
(uploading → success/error, retry + cancel); lightbox Dialog with prev/next; annotation editor overlay (shapes stored as JSON via
PATCH photo.annotation; renders scaled over image; original image never altered); multi-select + bulk toolbar; AI Generate →
Preview (Dialog) → Insert-only-on-confirm buttons on eligible text fields (§10); signature pad canvas (pointer events, mouse/touch/stylus,
clear/undo/save); PDF via existing PdfButtons type="inspection-report"; QR image shown on detail (endpoint 16) + print header; realtime
subscriptions via MODULE_EVENTS.irms + "irms-portal" matrices (list refetch + detail refetch + KPI refresh), respecting pageDirty guard.
Design system: green primary, Poppins, existing shadcn components, PageShell for pages, StatusBadge/PriorityBadge, humanize().
Mobile: bottom-sheet-ish layout for photo manager toolbar, tabs scrollable horizontally.
Loading/error/empty states MANDATORY on every data view. No fake success — toasts only after server 2xx (§67).

## QA divisions (after integration, main orchestrator runs browser QA)
- 20-a: curl E2E every endpoint (admin cookie), workflow transitions incl. 422 guards, customer isolation 404/403, photo upload via
  curl -F, file serving headers, AI endpoint, PDF bytes (%PDF magic, page count, filename), tsc --noEmit scoped clean, eslint scoped clean.
- 20-b: bunx tsc --noEmit scoped clean; eslint scoped clean; dev server renders every new page without console errors (agent-browser smoke).
- Orchestrator: full §61-§66 browser QA (all roles), realtime 2-session QA, mobile 375px, PDF QA (pdfinfo/pdftotext), §69 regression spot-checks.
