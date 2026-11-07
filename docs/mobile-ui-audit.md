# Mobile UI Zoom & Layout Audit

Audit of the reported mobile zoom / horizontal-shift behaviour in the
MOHD.HMS Enterprise web app, with the fixes applied in the working tree.

## 1. Summary

The viewport meta was **already correct** and is not the cause. The zoom was
caused by a small number of components whose minimum content width exceeded
the phone viewport. On mobile Chrome the layout viewport then expands to the
widest content (`window.innerWidth == scrollWidth`), which reads to the user
as the page "zooming out" or being pannable sideways. Double-tap zoom was a
second, independent trigger.

| # | Root cause | Seen at | Result before | Result after |
|---|-----------|---------|---------------|--------------|
| 1 | PM KPI percentage cards (`PctCard`) had `min-width: auto`; the nowrap detail line forced a 266 px card inside a 138–173 px grid track | 320–390 px | 432 / 453 / 460 / 468 px document width | viewport width |
| 2 | Profile → Active sessions header kept the full `Sign Out All Other Sessions` label on one row | 320–390 px | 394 px document width | viewport width |
| 3 | Header brand + action group exceeded the 320 px bar by 3 px | 320 px | 323 px document width | viewport width |
| 4 | Notifications dropdown was fixed at `22rem` (352 px) | 320 px | 352 px popper, document wider | 304 px popper |
| 5 | Hidden Recharts tooltips keep their last measured size and position; after a reflow (e.g. opening a dialog) one sat at 161–339 px | 320 px | 339 px document width | 320 px |
| 6 | Browser double-tap zoom on controls | all touch widths | double-tap zoom | `touch-action: manipulation` (pinch still works) |

No `user-scalable=no`, `maximum-scale=1`, or global `overflow-x: hidden`
workaround was added.

## 2. Environment and method

- Repo: `/home/hasan/mohd_hms_enterprise`
- Stack: Next.js 16 App Router, React 19, Tailwind v4, shadcn/Radix.
- Test server: `next dev -p 3050` from this working tree.
  `localhost:3000` serves the deployed release build, so it was **not** used
  to validate source changes.
- Browser: Playwright Chromium, mobile emulation (`isMobile`, `hasTouch`,
  `devicePixelRatio: 1`), widths **320, 360, 375, 390, 430** and spot checks
  at 768/1024/1280. Chromium shared libraries were loaded from a local deb
  extraction; no root access was available.
- Auth: seeded `admin@mohdhms.com`.
- Routes covered: all 29 registered modules/routes — dashboard, complaints,
  work-orders, checklists, equipment, pm, customers, users, employees,
  technicians, inventory, purchases, quotations, invoices, finance, hr, email,
  whatsapp, irms, files, vehicles, reports, audit, settings, scan, profile,
  search, terms, privacy.
- Overlays covered at 320 px: notifications, online-presence dropdown, profile
  menu, mobile More sheet, change-password dialog.
- Repeatable audit scripts and screenshots:
  `/tmp/opencode/hms-audit/` (`blame.js`, `late-audit.js`, `overlays.js`,
  `stress.js`, `final-audit-mobile.js`, `final-390-pm.png`,
  `final-390-profile.png`). These are temporary and not committed.

Limitations: no physical iOS/Android device was available. Results are
Chromium emulation only; iOS Safari should still be checked on hardware.
Headless Chromium also shows classic scrollbars, which can add a temporary
19 px measurement when a Radix overlay locks the body. Tests marked clean
were run with `--hide-scrollbars` or verified against a stable body width;
real phones use overlay scrollbars.

## 3. What was already correct

- `src/app/layout.tsx` exports `width: "device-width"`, `initialScale: 1`,
  `viewportFit: "cover"`; no `maximum-scale` or `user-scalable`. Served HTML
  contains exactly one viewport meta.
- `public/offline.html` has the same correct viewport.
- `src/app/manifest.ts` uses `display: "standalone"` and
  `orientation: "portrait-primary"`.
- Inputs/textarea use `text-base` on mobile (`md:text-sm`), so iOS does not
  auto-zoom on focus.
- Dialogs use `max-w-[calc(100%-2rem)]`; sheets use `w-3/4`; the mobile bottom
  navigation reserves its height with `--hms-mobile-nav-h`; safe-area insets
  are applied to the header, bottom nav, and page padding.
- Data tables intentionally scroll inside `overflow-x-auto hms-scroll`
  containers. They do not widen the document and were left unchanged.
- There are no custom pinch/zoom/double-tap JavaScript handlers. The only
  wheel handler is horizontal navigation in `floating-nav.tsx`.

## 4. Detailed findings and fixes

### 4.1 PM KPI cards widened the page (worst finding)

`PmDashboard` renders a two-column KPI grid. The compliance/completion
`PctCard`s sat in a nested grid item with no shrink allowance, and their
nowrap detail line made the card's min-content width 266 px. At 320 px the
right card ended at x=432; at 390 px at x=467.

Fix in `src/components/hms/modules/pm/dashboard-tab.tsx`:

- nested KPI grid item: `grid gap-3` → `grid gap-3 min-w-0` (line 154)
- `PctCard` root: `shadow-sm` → `shadow-sm min-w-0` (line 266)
- title row: allow shrink + ellipsis (`flex min-w-0 items-center gap-1.5`,
  `truncate` on the title, line 273)

The card now shrinks to its grid track and the detail/title truncate instead
of expanding the document.

### 4.2 Profile active-sessions row

The row `flex items-center justify-between` combined a 100 px title with a
245 px nowrap button inside 238 px of card content, producing 394 px document
width at 320–390 px.

Fix in `src/components/hms/modules/profile/security-sessions.tsx`:

- row: `flex flex-wrap ...` (line 186) so the button wraps below the title
- mobile label: `Sign out others (n)`; full
  `Sign Out All Other Sessions (n)` from `sm:` up (lines 196–197)

### 4.3 Header overflow at 320 px

The full brand lockup (intentionally never hidden/truncated) plus the right
action group exceeded the 320 px bar by 3 px (323 px document width on every
route). Fixed by reducing only the narrowest padding and brand margin:

`src/components/hms/shell/header.tsx`:

- bar padding: `px-3` → `px-2.5 min-[360px]:px-4` (line 126)
- brand margin: `mr-1` → `mr-0 min-[360px]:mr-1` (line 157)

The 360 px+ appearance is unchanged.

### 4.4 Notifications dropdown wider than the viewport

`DropdownMenuContent` was `w-[22rem]` (352 px), wider than a 320 px screen;
Radix collision handling cannot fit it. Now
`w-[22rem] max-w-[calc(100vw-1rem)] sm:w-[26rem] sm:max-w-none`
(line 513): 304 px at 320, 352 px from 390 up, 416 px from `sm` up.

### 4.5 Hidden Recharts tooltips widened the layout

Recharts keeps a hidden tooltip wrapper in the DOM with its last measured size
and position. After a reflow (opening the change-password dialog was the
reliable repro) one wrapper occupied x=161–339 at 320 px, expanding the
layout viewport to 339 px. This affected every page with a chart after the
reflow, not only the dashboard.

Fix in `src/app/globals.css` (lines 127–130):

```css
.recharts-tooltip-wrapper[style*="visibility: hidden"] {
  display: none;
}
```

Active tooltips are untouched: hovering a chart after the fix still produced a
visible tooltip (measured 134 px wide, x=83–217 at 320 px).

### 4.6 Double-tap zoom

Added `html { touch-action: manipulation; }` in the existing
`@layer base` block (`src/app/globals.css:123`). This removes double-tap zoom
on controls while preserving pinch-to-zoom and scrolling. It is **not** a
replacement for fixing the overflows above; both were needed.

## 5. Verification results

- All 29 routes, widths **320 / 360 / 375 / 390 / 430**: `scrollWidth ==
  clientWidth`; no document-level horizontal overflow.
- Stable-load check at 320 px and 375 px with 2.2 s per route: no overflow.
- Desktop spot checks at **768 / 1024 / 1280** for dashboard, PM, profile and
  settings: no overflow.
- Overlays at 320 px: notifications, presence, profile menu, More sheet,
  change-password — all `320 / 320`.
- Chart pages stressed with the change-password dialog at 320 px: dashboard,
  finance, hr, irms, reports — all `320 / 320`.
- Computed `touch-action` on `<html>`: `manipulation`.
- `npm run build`: passes (route manifest generated).
- Targeted `eslint` on the changed TS files: clean.
- `npm run lint` still fails on a pre-existing, unrelated issue:
  `src/components/hms/modules/pm/task-detail.tsx:822`
  (`react-hooks/set-state-in-effect`), plus an unused-disable warning in
  `src/lib/hms/push/fcm.ts:183`. These were present before this work and were
  not modified.

## 6. Files changed

| File | Change |
|------|--------|
| `src/app/globals.css` | `touch-action: manipulation`; hide inactive Recharts tooltips |
| `src/components/hms/modules/pm/dashboard-tab.tsx` | KPI shrink fixes, title ellipsis |
| `src/components/hms/modules/profile/security-sessions.tsx` | wrapping session header + mobile label |
| `src/components/hms/shell/header.tsx` | 320 px padding/margin; responsive notification width |

Not changed: viewport metadata, input font sizes, manifest, safe-area handling,
table scroll containers, and the pre-existing unrelated working-tree changes.

## 7. Deployment note

The fixes are in the **working tree** and were validated on the temporary dev
server (`3050`). `localhost:3000` is the deployed release and will keep the old
layout until the app is built and deployed. After deployment, repeat the
320 px smoke test on a real phone (portrait and landscape) before closing the
issue.
