# mohd_hms_enterprise

**MOHD.HMS ENTERPRISE — Smart Facility Maintenance Management**

A production-ready enterprise platform that manages complaints, work orders,
preventive maintenance, equipment, customers, employees, technicians,
inventory, purchasing, vehicles, quotations, invoices, payments, finance,
HR, IRMS inspections, reporting and audit — in one secure, role-based system.

## Tech Stack

- **Framework**: Next.js 16 (App Router) + TypeScript 5 + React 19
- **UI**: Tailwind CSS 4 + shadcn/ui + Lucide icons, Poppins typography
- **Database**: Prisma ORM (SQLite) — 42 models with append-only stock ledger
- **Auth**: DB-backed session tokens (HttpOnly cookie) + 7 roles / 47 permissions (RBAC)
- **Routing**: hash-router SPA shell with dedicated full-page CRUD (no popup forms)
- **Drafts**: localStorage + server-side draft backup (`Draft` table) with unsaved-changes guard

## Features

- 20 modules: Dashboard, Complaints, Work Orders, Equipment, PM, Customers,
  Users, Employees, Technicians, Inventory, Purchases, Vehicles, Quotations,
  Invoices, Finance, HR, IRMS, Reports, Audit, Settings
- Full workflow transitions (complaint lifecycle, PO approvals, quotation →
  invoice conversion, PM task generation & completion)
- QR labels with scan-to-open deep links per equipment unit
- Server-authoritative RBAC + customer-portal data scoping
- Notification center, global search (⌘K), CSV export, audit logging

## Getting Started

```bash
bun install          # or npm install
bun run db:push      # create the SQLite database from prisma/schema.prisma
bun run db:seed      # load demo data (optional)
bun run dev          # start the dev server
```

Open the app and sign in with a seeded demo account (see `prisma/seed.ts`).

## Notes

- `.env` and `*.db` are gitignored — create your own `.env` with
  `DATABASE_URL=file:./db/custom.db` and run the seed.
- All business forms/details are dedicated pages; dialogs are limited to
  confirmations and utility overlays by design.
