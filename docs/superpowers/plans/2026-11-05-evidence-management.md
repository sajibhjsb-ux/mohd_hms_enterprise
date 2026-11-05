# Work Order–Controlled Complaint Closure — Evidence Management (BEFORE/DURING/AFTER)

**Goal:** Wire the existing evidence infrastructure (Document model w/ `label` phase, complaint media route, MinIO storage, PhotoUploader camera, immutable delete) into a three-stage BEFORE/DURING/AFTER photo/video evidence system, with backend lifecycle enforcement.

**Root cause (systematic debugging):** All backend pieces exist. Gaps:
1. Complaint creation form (`new-page.tsx`) has no BEFORE evidence upload.
2. `PhotoUploader` is photo-only (no video staging/preview).
3. Complaint media POST has no lifecycle enforcement (BEFORE should lock after submission; DURING/AFTER require active WO).
4. WO AFTER-evidence mandatory check already exists in transition route (`completionEvidence` label "AFTER").

**Plan (minimal, spec-compliant):**
- T1: `PhotoUploader` — add video support (video staging, video preview, `accept="video/*"` button).
- T2: `complaints/new-page.tsx` — BEFORE evidence section: staged photos+videos, block "Create Complaint" while uploading, upload linked to new complaintId, read-only after submission.
- T3: `complaints/[id]/media/route.ts` — lifecycle enforcement: BEFORE only when complaint is NEW (no WO); DURING/AFTER require an active linked WO; reject otherwise.
- T4: Tests (rollback-transaction script) + typecheck/eslint + build + deploy to blue slot + push dev.

**Constraints:** Reuse existing infra; no new models/tables; no separate evidence app; MinIO for bytes, PostgreSQL for metadata; backend enforces all lifecycle rules; video fallback to file upload.
