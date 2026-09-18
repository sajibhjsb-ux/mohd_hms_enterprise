"use client";

// MOHD.HMS ENTERPRISE — centralized KPI → feature-page navigation config.
//
// Single source of truth for dashboard KPI drill-down. Each entry maps one
// dashboard KPI to the feature page that represents the SAME underlying data,
// with the destination filter expressed in that page's canonical vocabulary.
// The dashboard renders cards from this config; destination pages validate the
// query params (useModuleQuery). Nothing here invents routes — every module
// below exists in the registry (components/hms/registry.tsx).
//
// Count consistency (KPI number == destination view):
//   openComplaints   = complaints with status NEW | ASSIGNED | IN_PROGRESS
//                      → complaints "Active" tab (same three statuses).
//   urgentComplaints = URGENT priority ∩ active statuses
//                      → complaints "Active" tab + priority=URGENT filter.
//   activeWOs        = work orders PENDING | ACCEPTED | IN_PROGRESS | ON_HOLD
//                      → work-orders "Active" tab.
//   pendingWOs       = work orders PENDING | ACCEPTED
//                      → work-orders "Pending" tab.
//   overduePm        = PM tasks (SCHEDULED | IN_PROGRESS | OVERDUE) past due
//                      → pm tasks tab + overdue filter (same predicate).
//   equipmentDown    = equipment UNDER_MAINTENANCE
//                      → equipment status filter.
//   lowStock         = inventory items stockQty ≤ minStockQty, ACTIVE
//                      → inventory "Low stock only" filter.
//   financial        = invoice/expense aggregates → invoices list filters
//                      (aggregates vs. list rows differences are documented
//                      in the KPI report — e.g. collected includes partial
//                      payments on PARTIALLY_PAID invoices).
//   expenses         = expense ledger → finance "Expenses" tab
//                      (#/finance/expenses — existing route).

import { navigateTo } from "@/lib/hms/router";
import type { Permission } from "@/lib/hms/constants";
import { PERMISSIONS } from "@/lib/hms/constants";
import type { SessionUser } from "@/components/hms/session";
import { hasPerm } from "@/components/hms/session";

export type KpiNavTarget = {
  /** Destination module key (registry). */
  module: string;
  /** Hash segments (e.g. ["expenses"] → #/finance/expenses). */
  seg?: string[];
  /** Canonical filter params applied by the destination page. */
  query?: Record<string, string>;
  /** Permission required to FOLLOW the link (card stays non-clickable without it). */
  permission?: Permission;
};

/** Dashboard KPI id (API payload key / card) → navigation target. */
export const KPI_NAV: Record<string, KpiNavTarget> = {
  openComplaints: { module: "complaints", query: { status: "active" }, permission: PERMISSIONS.complaints_read },
  urgentComplaints: { module: "complaints", query: { status: "active", priority: "URGENT" }, permission: PERMISSIONS.complaints_read },
  activeWOs: { module: "work-orders", query: { status: "active" }, permission: PERMISSIONS.work_orders_read },
  pendingWOs: { module: "work-orders", query: { status: "pending" }, permission: PERMISSIONS.work_orders_read },
  myWorkOrders: { module: "work-orders", query: { status: "active" }, permission: PERMISSIONS.work_orders_read },
  overduePm: { module: "pm", query: { view: "tasks", status: "overdue" }, permission: PERMISSIONS.pm_read },
  myPmTasks: { module: "pm", query: { view: "tasks", status: "active" }, permission: PERMISSIONS.pm_read },
  equipmentDown: { module: "equipment", query: { status: "UNDER_MAINTENANCE" }, permission: PERMISSIONS.equipment_read },
  lowStock: { module: "inventory", query: { view: "items", stock: "low" }, permission: PERMISSIONS.inventory_read },
  invoiced: { module: "invoices", permission: PERMISSIONS.invoices_read },
  collected: { module: "invoices", query: { status: "PAID" }, permission: PERMISSIONS.invoices_read },
  outstanding: { module: "invoices", query: { status: "outstanding" }, permission: PERMISSIONS.invoices_read },
  expenses: { module: "finance", seg: ["expenses"], permission: PERMISSIONS.finance_read },
};

/** Resolved hash href for a KPI, or undefined when the user lacks permission. */
export function kpiHref(kpi: string, user: SessionUser | null): string | undefined {
  const t = KPI_NAV[kpi];
  if (!t) return undefined;
  if (t.permission && !hasPerm(user, t.permission)) return undefined;
  return buildHref(t);
}

/** Build the hash href for a target (pure; no navigation). */
export function buildHref(t: KpiNavTarget): string {
  const seg = (t.seg ?? []).filter(Boolean).map(encodeURIComponent).join("/");
  const qs = t.query ? new URLSearchParams(t.query).toString() : "";
  return `#/${t.module}${seg ? `/${seg}` : ""}${qs ? `?${qs}` : ""}`;
}

/** Programmatic navigation for KPI targets (banners, buttons). */
export function kpiNavigate(kpi: string, user: SessionUser | null): void {
  const t = KPI_NAV[kpi];
  if (!t) return;
  if (t.permission && !hasPerm(user, t.permission)) return;
  navigateTo(t.module, t.seg ?? [], t.query);
}
