"use client";

// MOHD.HMS ENTERPRISE — route-aware scroll restoration for browser refresh /
// PWA relaunch. The route (pathname + search) is the key: refreshing
// /hr/employees restores the HR list scroll, refreshing /irms/reports restores
// the IRMS scroll — a position saved for one route is NEVER applied to a
// different page. Session storage scopes the data to the tab (and dies with
// it), so back/forward and cross-session navigation stay untouched.

const KEY = "hms:scrollMap";
const MAX_ENTRIES = 60;

type ScrollMap = Record<string, number>;

function readMap(): ScrollMap {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScrollMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: ScrollMap): void {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    sessionStorage.setItem(KEY, JSON.stringify(map));
  } catch { /* storage unavailable — restoration is best-effort */ }
}

/** Persist the scroll position of an exact route (pathname + search). */
export function saveScrollForRoute(route: string, y: number): void {
  if (!route || route === "/") return;
  const map = readMap();
  if (map[route] === y) return;
  map[route] = Math.round(y);
  writeMap(map);
}

/** Read the saved scroll position of an exact route (null when none). */
export function readScrollForRoute(route: string): number | null {
  if (!route) return null;
  const v = readMap()[route];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Restore the saved scroll position for `route` once the page is tall enough
 * (data fetches render progressively). Polls with rAF until the document can
 * scroll to the target — or gives up after `timeoutMs` and clamps, so a
 * slower page still lands near the right area instead of jumping to 0.
 */
export function restoreScrollForRoute(route: string, timeoutMs = 1500): void {
  if (typeof window === "undefined") return;
  const target = readScrollForRoute(route);
  if (!target) return;
  const start = Date.now();
  const tick = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ready = max >= target - 4 || Date.now() - start >= timeoutMs;
    if (ready) {
      window.scrollTo(0, target);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
