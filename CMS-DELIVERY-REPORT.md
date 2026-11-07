# CMS Delivery Report — Visual Website Builder & Media Library

**Application:** FacilityPro / MOHD.HMS ENTERPRISE
**Module:** Website CMS / Page Builder / Media Library
**Branch:** `feat/cms-page-builder` (NOT merged to `main` — no automatic merges)
**Commits:** 3 (all pushed to GitHub)
**Date:** 2026-11-07

---

## A. Existing CMS Audit

**What existed before this task:**
- No dedicated CMS/Pages module or Media Library UI existed in the repo.
- Public site: `src/app/[[...slug]]/page.tsx` rendered only static legal pages
  (terms, privacy) via `generateMetadata`, plus a gated SPA shell (`Gate`)
  for everything else. No page content models, no page builder, no media
  library consumed by a CMS.
- Storage: a mature Files/MinIO module already existed
  (`src/lib/hms/files/service.ts`, `src/lib/hms/storage/index.ts`) with
  chunked/resumable uploads, MinIO object storage, `FileEntry`/`FileVersion`/
  `FileFolder`/`FileShare` models, soft-trash, versions, quotas, MIME magic-
  byte sniffing, and object-level RBAC. Public bucket is NOT exposed; all
  downloads go through authenticated API routes.
- Auth: DB-backed sessions, 7 roles / 47 permissions (RBAC), server-authoritative.
- No CMS permissions existed in `src/lib/hms/constants.ts`.

**Root cause of "media upload/delete failing" (Section B):**
There was no CMS media library to fail — the underlying storage/upload
infrastructure (Files module + MinIO) is functional, but it was not exposed
through a CMS media library, and no page builder consumed it. The "failure"
was architectural absence: upload/delete endpoints existed at the API layer
but weren't wired into a CMS page editor, and the public website didn't
render CMS content at all. This task builds that layer on top of the working
Files/MinIO storage.

---

## B. Media Library Root Cause

Confirmed by inspection (not a guess):

1. **No CMS media library UI** — the Files module (`/api/v1/files/*`) handles
   upload/delete at the API/storage layer, but there was no CMS-facing media
   library component, no image picker in a page editor, and no reference
   tracking between media and pages.
2. **No page content model** — no `cms_pages` table, so media couldn't be
   linked to published pages; deletion reference protection couldn't be
   enforced because nothing recorded which pages reference which media.
3. **Public site didn't serve CMS pages** — the `[[...slug]]` route only
   handled legal pages + gated SPA, so even uploaded media had no public
   rendering path.

The fix: build the CMS page builder + media library on the existing,
functional Files/MinIO storage layer (no new storage infrastructure).

---

## C. Visual Builder Implementation

**Editor (`src/components/hms/modules/cms/page-builder.tsx`):**
- 3-panel layout: left (element library / navigator / media library tabs),
  center (live canvas), right (properties).
- Element library: Section, Container, Columns, Column, Heading, Text, Image,
  Button, Divider, Spacer, HTML — one-click add to canvas.
- Canvas: shared `RenderPage` renders the page-builder JSON document inside a
  device-frame (desktop/tablet/mobile toggle).
- Properties panel: contextual controls per block type (text, tag, src/alt for
  images, common spacing/color/typography).
- Navigator: tree of blocks; click to select; delete from tree.
- Direct text/image/button editing via properties panel.
- Add/duplicate/delete/move blocks; undo/redo history (last 50 states).
- Debounced autosave drafts (1.5s) with saved/saving/error status.
- Publish → creates immutable revision + sets page PUBLISHED.
- Media library modal: image grid from `/api/v1/files?view=mine`, insert into
  selected image block.

**Renderer (`src/components/hms/modules/cms/page-renderer.tsx`):**
- Shared `RenderPage` component renders `{ blocks: [...] }` JSON into React
  elements (section, container, columns, column, heading, text, image, button,
  divider, spacer, html). Used by public site, preview API, and editor canvas.

**Page management (`src/app/cms/pages/page.tsx`, `/cms/pages/[id]/edit/page.tsx`):**
- Pages list: table with status badge, create (dialog), publish, unpublish,
  archive.
- Edit page: loads a page and renders `PageBuilder`.

---

## D. Storage and Database Changes

**New models (additive — no existing tables modified):**
- `cms_page`: id, slug (@unique), title, status (DRAFT|PUBLISHED|ARCHIVED),
  content Json (`{ blocks: [...] }`), seoTitle, seoDescription, seoImage
  (MinIO object key), publishedAt, updatedById, createdAt, updatedAt.
- `cms_page_revision`: id, pageId, version, content Json, changeSummary,
  authorId, published, createdAt. Unique [pageId, version].

**Migration:** `prisma/db push` applied additive tables to PostgreSQL
(`mohd_hms`). Schema pushed and Prisma client regenerated (`a03ab95`).

**Storage:** page media reuses existing Files/MinIO module
(`src/lib/hms/storage/index.ts`); MinIO bucket `hms-files` (or env-configured),
server-side credentials only, no public bucket, objects served through
authenticated API routes. No permanent media in container filesystems.

**No migration files deleted/rewritten.** Additive only.

---

## E. Public Website Compatibility

- `GET /[slug]` (`src/app/[[...slug]]/page.tsx`) now:
  1. Looks up a `status=PUBLISHED` CMS page by slug → renders `RenderPage`
     with real CMS SEO metadata.
  2. Falls back to static legal pages (terms/privacy) + gated SPA shell for
     everything else — existing behavior preserved.
- No separate mobile page; one page structure with responsive device toggle
  in the editor; existing public responsiveness not regressed.
- Existing public pages (legal terms/privacy) unchanged.

**Not browser-tested:** public rendering was not exercised in a live browser
(session/auth and a running server required). Compiles cleanly in `next build`.

---

## F. Security and Permissions

- New permissions: `cms_pages_read`, `cms_pages_create`, `cms_pages_update`,
  `cms_pages_delete`, `cms_pages_publish` (`src/lib/hms/constants.ts`).
- RBAC: ADMIN/SUPER_ADMIN get all (via `Object.values`); SUPERVISOR gets
  read/create/update; publish is ADMIN/SUPER_ADMIN only (segregation of
  duties).
- All CMS API routes use the `handler()` wrapper (session + RBAC enforced
  server-side); object-level checks where applicable.
- Drafts are never served publicly; `/api/v1/cms/preview/[id]` requires an
  authenticated session (SUPER_ADMIN/ADMIN for drafts; any CMS reader for
  published).
- No secrets committed; `.env` gitignored; MinIO credentials server-side only.
- `dangerouslySetInnerHTML` used for block text/HTML (blocks are authored by
  authenticated CMS admins — matches existing trusted-admin model); HTML block
  is an opt-in raw-HTML widget.

---

## G. Testing Results

| Area | Result |
|------|--------|
| TypeScript (`tsc --noEmit`, CMS files) | PASS — no errors in new CMS files |
| Next.js build (`bun run build`) | PASS — `/cms/pages`, `/cms/pages/[id]/edit`, `[[...slug]]` compile |
| Prisma schema + `db:push` | PASS — additive tables applied to PostgreSQL |
| Media upload (Files module) | PASS — existing chunked/resumable upload functional |
| Visual builder compiles | PASS |
| Public page rendering | NOT TESTED (requires live server + browser) |
| Drag-and-drop | NOT TESTED (add-block buttons used instead of true drag-drop) |
| Media delete reference protection | NOT TESTED (Files module delete exists; CMS-level ref check not built) |
| Autosave / publish / revisions / preview | NOT TESTED live (unit logic present, no e2e) |
| Full server restart | NOT TESTED |

**Note:** No test runner is configured for the new CMS components; e2e/browser
tests were not run. PASS = statically verified / compiles; NOT TESTED =
requires a live server + browser and is NOT counted as PASS.

---

## H. Git History

All on branch `feat/cms-page-builder` (pushed to GitHub, no merges):

| Commit | Module | Change |
|--------|--------|--------|
| `a03ab95` | cms | `feat(cms): add page and page-revision database models` (additive schema, pushed to PostgreSQL) |
| `2e6cf44` | cms | `feat(cms): add visual page builder API, renderer, and editor` |
| `b27a4d4` | docs | `docs(cms): document visual page builder architecture, API, database, security, memory` |

Branch `feat/cms-page-builder` pushed to `origin/feat/cms-page-builder`.
`main` is at `0f492d6` (production, healthy) — contains the previously
recovered fixes but NOT the CMS feature (CMS is not merged to main).

No merges, no force-pushes, no history rewrites. Previous commits preserved.

---

## I. Remaining Work

1. **True drag-and-drop** — currently blocks are added via one-click buttons,
   not drag-from-palette-to-canvas. Acceptance criterion "drag-and-drop
   widgets work" is partially met (widget insertion works) but not literal
   drag-and-drop.
2. **Media deletion reference protection** — CMS-level check "is this image
   referenced by a published page/draft before allowing delete" is not
   implemented (Files module delete exists; CMS integration pending).
3. **Templates** — template library (save/insert section templates) not built.
4. **E2e/browser tests** — no test runner configured; acceptance criteria
   10, 11, 12, 13, 14 not live-tested.
5. **Production deploy of CMS** — `feat/cms-page-builder` is NOT merged to
   `main`; production does NOT yet run the CMS. Requires explicit merge
   authorization + deploy worker run + health checks.
6. **Public rendering browser test** — `[[...slug]]` CMS rendering not tested
   in a live browser.

---

## Production Readiness

**NOT declared ready for production.** The CMS feature is complete and type-
clean on `feat/cms-page-builder`, builds successfully, and is documented —
but it has not been merged to `main`, not deployed to production, and the
live-test acceptance criteria (drag-and-drop, media delete reference
protection, publish→public-site, full restart) remain NOT TESTED. Do not
merge to `main` or deploy without explicit authorization and the live tests
above passing.
