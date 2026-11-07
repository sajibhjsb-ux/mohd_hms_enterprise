# Mobile UI Fix Plan

Status: **implemented and verified in the working tree** (not deployed).
Companion evidence: [mobile-ui-audit.md](./mobile-ui-audit.md).

## 1. Goal

Stop mobile zoom / horizontal panning on narrow screens without breaking
pinch-to-zoom, accessibility, the full brand lockup, or intentional
table/sheet scrolling.

Non-goals:

- Do not add `user-scalable=no` or `maximum-scale=1`.
- Do not hide overflow globally (`overflow-x: hidden` on `html`/`body`).
- Do not redesign the KPI grid or tables.
- Do not change the existing viewport metadata, which was already correct.

## 2. Work items

| # | Issue | Action | File | Status |
|---|-------|--------|------|--------|
| 1 | PM KPI cards force document width 432–468 px at 320–390 px | Allow the nested KPI grid item and `PctCard` card to shrink; truncate the title | `src/components/hms/modules/pm/dashboard-tab.tsx` | Done |
| 2 | Profile “Active sessions” row is 394 px wide | Wrap the row; use a short mobile button label and the full label from `sm` | `src/components/hms/modules/profile/security-sessions.tsx` | Done |
| 3 | Header is 3 px too wide at 320 px | Use 10 px bar padding and no brand margin below 360 px; restore current values from 360 px | `src/components/hms/shell/header.tsx` | Done |
| 4 | Notifications dropdown is 352 px on a 320 px screen | Cap it at `calc(100vw - 1rem)` below `sm` | `src/components/hms/shell/header.tsx` | Done |
| 5 | Hidden Recharts tooltips expand the layout after reflow | Hide inactive tooltip wrappers only | `src/app/globals.css` | Done |
| 6 | Double-tap zoom on controls | `touch-action: manipulation` on `html` | `src/app/globals.css` | Done |

Deliberately skipped: a global overflow clip, viewport scale restrictions, and
a new responsive KPI layout. The smallest fix that removes the real overflow
was preferred.

## 3. Implementation steps performed

1. Reproduced each issue with Playwright at 320/360/375/390 px and recorded
   `documentElement.scrollWidth` vs `clientWidth`.
2. Traced the offenders with `getBoundingClientRect()` + ancestor overflow
   checks rather than guessing from screenshots.
3. Applied the six changes above.
4. Re-ran the full route matrix and all mobile overlays.
5. Stress-tested chart pages with the change-password dialog (the reflow that
   exposed the hidden-tooltip bug).
6. Ran `npm run build` and targeted ESLint on the changed TS files.

## 4. Verification checklist

- [x] 29 routes at 320 px: no horizontal document overflow
- [x] 29 routes at 360 px: no horizontal document overflow
- [x] 29 routes at 375 px: no horizontal document overflow
- [x] 29 routes at 390 px: no horizontal document overflow
- [x] 29 routes at 430 px: no horizontal document overflow
- [x] Stable-load re-check at 320 px and 375 px (2.2 s per route)
- [x] Desktop spot check at 768/1024/1280 px (dashboard, PM, profile, settings)
- [x] Notifications, presence, profile menu, More sheet, change-password at 320 px
- [x] Dashboard/finance/hr/irms/reports with a dialog reflow at 320 px
- [x] `<html>` computed `touch-action: manipulation`
- [x] `npm run build` passes
- [x] Targeted ESLint on changed TS files passes
- [ ] Physical iOS Safari check
- [ ] Physical Android Chrome check
- [ ] Deployed release smoke test

`npm run lint` as a whole still reports the pre-existing
`react-hooks/set-state-in-effect` error in
`src/components/hms/modules/pm/task-detail.tsx:822` and an unused-disable
warning in `src/lib/hms/push/fcm.ts:183`. Neither file was changed by this
work; fix them separately if the full lint gate is required.

## 5. Test commands

```bash
# Source-level dev server (localhost:3000 is the deployed release)
./node_modules/.bin/next dev -p 3050

# Verification scripts used during the audit (temporary, not committed)
node /tmp/opencode/hms-audit/late-audit.js
node /tmp/opencode/hms-audit/overlays.js
node /tmp/opencode/hms-audit/stress.js

# Changed-file lint + production build
npx eslint src/components/hms/modules/pm/dashboard-tab.tsx \
  src/components/hms/modules/profile/security-sessions.tsx \
  src/components/hms/shell/header.tsx
npm run build
```

Playwright must be run with the locally extracted Chromium library path:

```bash
LD_LIBRARY_PATH=/tmp/opencode/pw-deps/root/usr/lib/x86_64-linux-gnu \
  node /tmp/opencode/hms-audit/overlays.js
```

## 6. Deploy

1. Rebuild and deploy the app using the normal release process.
2. Confirm `localhost:3000` (or the deployed origin) serves the new build.
3. On a real phone at 320–390 px wide:
   - open dashboard, PM dashboard, and profile;
   - rotate to landscape and back;
   - open notifications, the profile menu, the More sheet, and change-password;
   - double-tap a button (must not zoom), then pinch (must still zoom).
4. Check that PM KPI titles/details truncate instead of widening the page, and
   that the session button wraps below “Active sessions” on narrow screens.

## 7. Rollback

Revert the changes to these five files; no database, environment, or
configuration change is involved:

- `src/app/globals.css`
- `src/components/hms/modules/pm/dashboard-tab.tsx`
- `src/components/hms/modules/profile/security-sessions.tsx`
- `src/components/hms/shell/header.tsx`
- `docs/mobile-ui-audit.md`, `docs/mobile-ui-fix-plan.md` (documentation only)

## 8. Follow-up (optional)

- Add one Playwright regression check that asserts
  `scrollWidth === clientWidth` at 320 px for dashboard, PM, and profile, and
  with the change-password dialog open. There is no Playwright test harness in
  the repo today, so this was not added.
- If Recharts changes the inline `visibility: hidden` formatting, re-test the
  hidden-tooltip rule; it is the only selector-based guard in this fix.
- Add a real-device viewport check to the release checklist so future modules
  cannot reintroduce a min-content blowout unnoticed.
