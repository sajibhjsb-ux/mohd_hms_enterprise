"use client";

// MOHD.HMS ENTERPRISE — module registry (single source of truth for navigation).
// Role gating here is a UX hint; the backend API enforces real authorization.

import type { ComponentType, LazyExoticComponent } from "react";
import type { Permission } from "@/lib/hms/constants";
import {
  LayoutDashboard, Users, Building2, UserCog, HardHat, AlertTriangle, ClipboardList,
  Wrench, CalendarClock, Boxes, ShoppingCart, FileText, Receipt, Wallet, IdCard,
  SearchCheck, BarChart3, Settings, History, Truck, QrCode, CircleUserRound,
  ScrollText, ShieldCheck, MessageCircle, ScanLine,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ModuleDef = {
  key: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  roles?: string[];
  permissions?: Permission[];
  /** Reachable page but hidden from floating/mobile navigation (e.g. profile,
   *  which is entered from the header account menu). Routing still resolves. */
  navHidden?: boolean;
  component: ComponentType;
};

import { DashboardModule } from "./modules/dashboard";
import { CustomersModule } from "./modules/customers";
import { UsersModule } from "./modules/users";
import { EmployeesModule } from "./modules/employees";
import { TechniciansModule } from "./modules/technicians";
import { ComplaintsModule } from "./modules/complaints";
import { WorkOrdersModule } from "./modules/work-orders";
import { EquipmentModule } from "./modules/equipment";
import { PmModule } from "./modules/pm";
import { InventoryModule } from "./modules/inventory";
import { PurchasesModule } from "./modules/purchases";
import { QuotationsModule } from "./modules/quotations";
import { InvoicesModule } from "./modules/invoices";
import { FinanceModule } from "./modules/finance";
import { HrModule } from "./modules/hr";
import { WhatsAppModule } from "./modules/whatsapp";
import { IrmsModule } from "./modules/irms";
import { ReportsModule } from "./modules/reports";
import { VehiclesModule } from "./modules/vehicles";
import { SettingsModule } from "./modules/settings";
import { AuditModule } from "./modules/audit";
import { ProfileModule } from "./modules/profile";
import { TermsModule, PrivacyModule } from "./legal/legal-module";
import { ScanModule } from "./modules/scan";

export const MODULES: ModuleDef[] = [
  // NOTE: the mobile bottom navigation layout (Dashboard · Complaints · QR
  // center · Invoices · More + RBAC fallbacks) is owned by shell/mobile-nav.tsx
  // — this registry stays the single catalog of module definitions.
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, component: DashboardModule },
  { key: "complaints", label: "Complaints", shortLabel: "Complaints", icon: AlertTriangle, permissions: ["complaints.read"], component: ComplaintsModule },
  { key: "work-orders", label: "Work Orders", shortLabel: "Work", icon: ClipboardList, permissions: ["work_orders.read"], component: WorkOrdersModule },
  { key: "equipment", label: "Equipment", icon: QrCode, permissions: ["equipment.read"], component: EquipmentModule },
  { key: "pm", label: "Preventive Maintenance", shortLabel: "PM", icon: CalendarClock, permissions: ["pm.read"], component: PmModule },
  { key: "customers", label: "Customers", icon: Building2, permissions: ["customers.read"], component: CustomersModule },
  { key: "users", label: "Users", icon: Users, permissions: ["users.read"], component: UsersModule },
  { key: "employees", label: "Employees", icon: IdCard, permissions: ["employees.read"], component: EmployeesModule },
  { key: "technicians", label: "Technicians", icon: HardHat, permissions: ["users.read"], component: TechniciansModule },
  { key: "inventory", label: "Inventory", icon: Boxes, permissions: ["inventory.read"], component: InventoryModule },
  { key: "purchases", label: "Purchases", icon: ShoppingCart, permissions: ["purchases.read"], component: PurchasesModule },
  { key: "quotations", label: "Quotations", icon: FileText, permissions: ["quotations.read"], component: QuotationsModule },
  { key: "invoices", label: "Invoices", icon: Receipt, permissions: ["invoices.read"], component: InvoicesModule },
  { key: "finance", label: "Finance", icon: Wallet, permissions: ["finance.read", "invoices.read"], component: FinanceModule },
  { key: "hr", label: "HR", icon: UserCog, permissions: ["hr.read", "employees.read"], component: HrModule },
  { key: "whatsapp", label: "WhatsApp", shortLabel: "Chat", icon: MessageCircle, permissions: ["whatsapp.view"], component: WhatsAppModule },
  { key: "irms", label: "IRMS Inspections", shortLabel: "IRMS", icon: SearchCheck, permissions: ["irms.read", "irms.portal"], component: IrmsModule },
  { key: "vehicles", label: "Vehicles", icon: Truck, permissions: ["vehicles.read"], component: VehiclesModule },
  { key: "reports", label: "Reports", icon: BarChart3, permissions: ["reports.read"], component: ReportsModule },
  { key: "audit", label: "Audit Logs", shortLabel: "Audit", icon: History, roles: ["SUPER_ADMIN", "ADMIN"], permissions: ["audit.read"], component: AuditModule },
  { key: "settings", label: "Settings", icon: Settings, roles: ["SUPER_ADMIN", "ADMIN"], permissions: ["settings.read"], component: SettingsModule },
  // QR Scanner — the REAL camera scanner (route /scan), opened from the mobile
  // bottom-nav center button. Hidden from module navigation lists (it has its
  // own dedicated entry point); reachable by every signed-in user — scanning
  // itself needs no permission because each destination enforces RBAC on
  // arrival (resolve.ts refuses modules this user cannot reach).
  { key: "scan", label: "Scan QR Code", shortLabel: "Scan", icon: ScanLine, navHidden: true, component: ScanModule },
  // Customer profile — entered from the header account menu (spec §34), not
  // from the module nav. Views: /profile (view), /profile/edit, /profile/complete.
  { key: "profile", label: "My Profile", shortLabel: "Profile", icon: CircleUserRound, roles: ["CUSTOMER"], navHidden: true, component: ProfileModule },
  // Legal pages — the CANONICAL Terms & Conditions / Privacy Policy (spec §2/§3).
  // Entered from the footer, the auth screens, the profile page and document
  // references; hidden from the module nav on purpose (spec §27). Logged-out
  // visitors see the same document via the Gate's public legal view.
  { key: "terms", label: "Terms & Conditions", shortLabel: "Terms", icon: ScrollText, navHidden: true, component: TermsModule },
  { key: "privacy", label: "Privacy Policy", shortLabel: "Privacy", icon: ShieldCheck, navHidden: true, component: PrivacyModule },
];
