"use client";

// MOHD.HMS ENTERPRISE — hash router for dedicated full pages.
//
// The application is a single-route SPA ("/" per platform architecture); every
// business form, detail and management view is a DEDICATED PAGE addressed by a
// hash route that stays in sync with the ui-store. This gives us, without new
// Next.js routes:
//   • visible URL per page          → #/complaints, #/complaints/new,
//                                     #/complaints/{id}, #/complaints/{id}/edit
//   • browser Back / Forward        → native history + hashchange
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

/** Suffix views addressed as #/module/{id}/{view}. */
export const SUFFIX_VIEWS = new Set(["edit", "assign", "adjust", "payment", "label", "complete"]);

export type ModulePageInfo = { view: "list" | "new" | "detail" | (string & {}); id?: string };

/** Interpret raw hash segments for a module. */
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

/** Canonical hash href for a module page. */
export function hrefFor(module: string, seg: string[] = []): string {
  const clean = seg.filter((s) => s !== "").map(encodeURIComponent);
  return `#/${module}${clean.length ? `/${clean.join("/")}` : ""}`;
}

/** Parse a location.hash into a route target (null when absent/unparsable). */
export function parseHash(hash: string): { module: string; seg: string[] } | null {
  const h = hash.replace(/^#\/?/, "").trim();
  if (!h) return null;
  const parts = h.split("/").map(decodeURIComponent).filter((s) => s !== "");
  if (parts.length === 0) return null;
  const [module, ...seg] = parts;
  if (!/^[a-z][a-z0-9-]*$/i.test(module)) return null;
  return { module, seg };
}

/** Navigate by assigning location.hash — pushes a history entry (Back works). */
export function navigateTo(module: string, seg: string[] = []): void {
  if (typeof window === "undefined") return;
  const next = hrefFor(module, seg);
  if (window.location.hash === next) {
    // Same URL. Still re-run the route handler so the dirty-form guard can
    // (re)open when the user insists on leaving a dirty page.
    if (useUi.getState().pageDirty) dispatchRoute();
    return;
  }
  window.location.hash = next;
}

/** Re-run hashchange handlers for the current URL. */
export function dispatchRoute(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } catch {
    window.dispatchEvent(new Event("hashchange"));
  }
}

/** Replace the hash without adding a history entry or firing hashchange. */
export function replaceHash(href: string): void {
  if (typeof window === "undefined") return;
  try {
    window.history.replaceState(null, "", href.startsWith("#") ? href : `#${href}`);
  } catch {
    // Older browsers / sandboxed iframes — safe to ignore.
  }
}

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
};
