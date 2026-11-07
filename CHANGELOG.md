# Changelog — FacilityPro (MOHD.HMS ENTERPRISE)

Historical entries preserved. New entries record date, commit, module, change,
migration, test status, deployment status. A feature is complete only when
committed, migrated, configured to survive restart, workers start correctly,
frontend+backend run the intended version, workflow passes e2e tests,
documentation updated, and behaviour correct after full server restart.

## History (from git)

| Date | Commit | Module | Change |
|------|--------|--------|--------|
| — | 0efb3bb | ai | Central multi-provider AI config + real Test Connection |
| — | 15133ae | ai | Refresh NVIDIA/Gemini catalogs; detect retired models (410) |
| — | f24b1d7 | whatsapp | Provision gateway config from OPENWA_*; gateway-reachable webhook URL |
| — | ddde457 | whatsapp | Stop client crash when a conversation has no contact |
| — | 3b87fd3 | whatsapp | Route inbound messages through centralized AIService; end repeating static menu |
| — | 07bd79c | checklist | Auto-generate and manage work-order checklists |
| — | d900697 | complaint | Lock complaint to work order; remove independent mark-completed |
| — | b302d60 | evidence | Three-stage BEFORE/DURING/AFTER photo/video evidence |
| — | 7a53add | pm | Resolve TypeScript errors blocking build |
| — | e918103 | evidence | Lock BEFORE evidence after complaint submission |
| — | 7a5e90f | push | Dedupe FCM/VAPID; SW-level dedup; prefer FCM; brand icons/test copy |
| — | 14fe478 | realtime | Role-scoped presence privacy test (REST + WS) |
| — | afc0694 | realtime | Role-scoped online presence (backend-enforced) |
| — | 4a08cee | realtime | Complete WS handshake; back off dispatcher; honest health |
| — | 028f262 | push | Global channel honest; bind FCM devices to sessions |
| — | 40992a2 | mobile | Eliminate narrow-screen overflow and double-tap zoom |
| — | dce8d6b | notifications | Deep-link clicks + mark-read PATCH (deploy/notification-navigation) |
| — | 1cc49c1 | mobile | Two-column record cards for all data tables (deploy/responsive-audit) |
| — | 1c07489 | notifications | Deep-link clicks and add mark-read PATCH |
| — | 8ac9c1e | mobile | Responsive shell, card table rows, tap targets, overflow containment |
| — | 33723d7 | baseline | Baseline production release (last_sha in deploy worker) |

## Recovery (this session)

| Date | Commit | Module | Change | Migration | Test | Deploy |
|------|--------|--------|--------|-----------|------|--------|
| 2026-11-07 | bafbefa | recovery | Persisted all previously-implemented production fixes (complaint lock, evidence, checklist, PM, UI, notifications, email, WhatsApp AI) as commit on `dev` (138 files) | None (schema unchanged) | Not yet (post-restart verify required) | NOT deployed — realigned to main |
| 2026-11-07 | 0f492d6 | deployment | Merged `dev` → `main` (explicitly authorized); deployed `0f492d6` to production (green slot :3001, healthy) via deploy worker + promote | Schema already in sync | Build passes; health T+0/15/30/60/120s PASS | DEPLOYED to production |
| 2026-11-07 | a03ab95 | cms | Added `cms_pages` + `cms_page_revisions` DB models for the visual page builder; Prisma client regenerated + schema pushed | Additive `cms_pages`/`cms_page_revisions` tables | tsc clean; `next build` passes | On `main` (schema baseline) |
| 2026-11-07 | 2e6cf44 | cms | Visual page builder: CMS API (pages CRUD, publish/unpublish with immutable revisions, revisions list/restore, preview), 3-panel editor (element library, navigator, canvas, properties), media-library image insertion, autosave drafts, undo/redo, responsive toggle; public `[[...slug]]` renders published pages; `cms_pages_*` RBAC permissions | None (uses existing cms_pages tables) | tsc clean; `next build` compiles `/cms/pages`, `/cms/pages/[id]/edit` | On `feat/cms-page-builder` (not merged to main) |
