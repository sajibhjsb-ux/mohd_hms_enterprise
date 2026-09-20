"use client";

// MOHD.HMS ENTERPRISE — path router for dedicated full pages.
//
// The application is a single-route SPA served by a catch-all Next.js route
// (app/[[...slug]]); every business form, detail and management view is a
// DEDICATED PAGE addressed by a clean path URL that stays in sync with the
// ui-store. This gives us:
//   • visible URL per page          → /complaints, /complaints/new,
//                                     /complaints/{id}, /complaints/{id}/edit
//   • browser Back / Forward        → native history + popstate
//   • direct URLs (deep links)      → parsed on shell mount after auth
//
// Segment conventions:
//   []                    → list page
//   ["new"]               → create page
//   [id]                  → detail page
//   [id, "edit"|"assign"|"adjust"|"payment"|"label"|"complete"] → action pages
//   module-specific       → e.g. ["suppliers","new"], ["suppliers", id]
//                             (see pageFromSeg: non-suffix first segment = view name)

import { useUi } from "@/lib/hms/ui-store";

/** Suffix views addressed as /module/{id}/{view}. */
export const SUFFIX_VIEWS = new Set(["edit", "assign", "adjust", "payment", "label", "complete"]);

/** Custom event fired on the window after a path change (nav / Back / Forward). */
export const ROUTE_EVENT = "hms:route";

export type ModulePageInfo = { view: "list" | "new" | "detail" | (string & {}); id?: string };

/** Interpret raw path segments for a module. */
export function pageFromSeg(seg: string[]): ModulePageInfo {
  const [a, b, c] = seg;
  if (!a) return { view: "list" };
  if (a === "new") return { view: "new" };
  if (!b) return { view: "detail", id: a };
  if (SUFFIX_VIEWS.has(b)) return { view: b, id: a };
  if (c && SUFFIX_VIEWS.has(c)) return { view: `${a}-${c}`, id: b }; // e.g. projects/{id}/edit
  // Custom prefix view, e.g. ["suppliers", "new" | id] → view "suppliers", id.
  return { view: a, id: b };
}

/**
 * Canonical path href for a module page. `query` renders as URL query params
 * after the path (e.g. /complaints?status=active) — used for KPI drill-down.
 */
export function hrefFor(module: string, seg: string[] = [], query?: Record<string, string>): string {
  const clean = seg.filter((s) => s !== "").map(encodeURIComponent);
  const qs = canonicalQuery(query);
  return `/${module}${clean.length ? `/${clean.join("/")}` : ""}${qs ? `?${qs}` : ""}`;
}

/** Encode a query object into a canonical URLSearchParams string (stable order/encoding). */
export function canonicalQuery(query?: Record<string, string>): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  return sp.toString();
}

/** Parse "a=1&b=2" into a plain object (empty string values dropped). */
export function parseQueryParams(query: string): Record<string, string> {
  if (!query) return {};
  return Object.fromEntries(new URLSearchParams(query));
}

/** Parse a location pathname (or legacy "#/..." hash) into a route target
 *  (null when absent/unparsable). Query params after "?" are returned raw
 *  (path segments never contain "?"). */
export function parsePath(input: string): { module: string; seg: string[]; query: string } | null {
  let h = (input ?? "").trim();
  if (!h) return null;
  if (h.startsWith("#")) h = h.startsWith("#/") ? h.slice(2) : h.slice(1);
  else h = h.replace(/^\//, "");
  const [path, query = ""] = h.split("?");
  const parts = path.split("/").map(decodeURIComponent).filter((s) => s !== "");
  if (parts.length === 0) return null;
  const [module, ...seg] = parts;
  if (!/^[a-z][a-z0-9-]*$/i.test(module)) return null;
  return { module, seg, query };
}

const currentPath = () => window.location.pathname + window.location.search;

/** Navigate by pushing a history entry (Back works); re-runs route handlers. */
export function navigateTo(module: string, seg: string[] = [], query?: Record<string, string>): void {
  if (typeof window === "undefined") return;
  const next = hrefFor(module, seg, query);
  if (currentPath() === next) {
    // Same URL. Still re-run the route handler so the dirty-form guard can
    // (re)open when the user insists on leaving a dirty page.
    if (useUi.getState().pageDirty) dispatchRoute();
    return;
  }
  try {
    window.history.pushState(null, "", next);
  } catch {
    // sandboxed iframes / unusual contexts — fall back to direct assignment.
    window.location.pathname = next.split("?")[0];
    window.location.search = next.includes("?") ? next.slice(next.indexOf("?")) : "";
  }
  dispatchRoute();
}

/** Re-run route-change handlers for the current URL. */
export function dispatchRoute(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ROUTE_EVENT));
}

/** Replace the current path without adding a history entry or firing handlers. */
export function replacePath(path: string): void {
  if (typeof window === "undefined") return;
  try {
    window.history.replaceState(null, "", path);
  } catch {
    // Older browsers / sandboxed iframes — safe to ignore.
  }
}

/** Legacy aliases (hash-era names) so old callers keep working. */
export const parseHash = parsePath;
export const replaceHash = replacePath;

/** Notification resourceType → dedicated detail page route (server resource ids). */
export const RESOURCE_ROUTES: Record<string, { module: string; seg: (id: string) => string[] }> = {
  COMPLAINT: { module: "complaints", seg: (id) => [id] },
  WORK_ORDER: { module: "work-orders", seg: (id) => [id] },
  EQUIPMENT: { module: "equipment", seg: (id) => [id] },
  CUSTOMER: { module: "customers", seg: (id) => [id] },
  INVOICE: { module: "invoices", seg: (id) => [id] },
  QUOTATION: { module: "quotations", seg: (id) => [id] },
  PURCHASE_ORDER: { module: "purchases", seg: (id) => [id] },
  INVENTORY_ITEM: { module: "inventory", seg: (id) => [id] },
  INSPECTION_REPORT: { module: "irms", seg: (id) => ["reports", id] },
  // Files module — notification deep links (§27: clicks open the relevant
  // file/folder page). FOLDER routes into the owner's browser; share
  // notifications carry the same resource types (target resolved on arrival).
  FILE: { module: "files", seg: (id) => ["file", id] },
  FILE_FOLDER: { module: "files", seg: (id) => ["my", id] },
};