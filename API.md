# API — FacilityPro (MOHD.HMS ENTERPRISE)

Actual API route groups observed in `src/app/api/v1/`. Exact request/response
bodies must be read from the corresponding route files; this document lists
route groups and purpose only and does not fabricate endpoints.

Route groups (Next.js App Router, `src/app/api/v1/`):

| Route group | Purpose | Auth | Roles |
|-------------|---------|------|-------|
| `/complaints` | List/create complaints; BEFORE evidence upload | Session | Customer/Admin/Supervisor |
| `/complaints/[id]` | Complaint detail; transition (status change) | Session | RBAC |
| `/complaints/[id]/media` | Complaint media (BEFORE) upload/list | Session | RBAC |
| `/complaints/[id]/media/[mediaId]` | Single media item | Session | RBAC |
| `/complaints/_lib.ts` | Shared complaints helpers | — | — |
| `/work-orders/[id]` | Work Order detail; transition | Session | RBAC |
| `/work-orders/[id]/photos` | Work Order DURING/AFTER evidence photos | Session | Technician |
| `/work-orders/[id]/materials` | Work Order material lines | Session | RBAC |
| `/work-orders/[id]/materials/[lineId]/transition` | Material line transition | Session | RBAC |
| `/notifications` | In-app notifications; mark read (PATCH) | Session | RBAC |
| `/users` | Users (RBAC: 7 roles / 47 permissions) | Session | Admin/Super Admin |
| `/technicians` / `[id]` | Technicians | Session | RBAC |
| `/dashboard` | Dashboard aggregates/counts | Session | RBAC |
| `/files` | Files / MinIO browser | Session | RBAC |
| `/invoices` | Invoices | Session | RBAC |
| `/reports` | Reports | Session | RBAC |
| `/pm/findings` | PM findings | Session | RBAC |
| `/pm/tasks/[id]/photos` | PM task evidence photos | Session | Technician |
| `/pm/tasks/[id]/reschedule` | PM task reschedule | Session | RBAC |
| `/profile/phone-requests` | Profile phone change requests | Session | User |
| `/push/devices` / `[id]` / `admin/devices` / `status` | Push device registration/status | Session | RBAC |
| `/whatsapp/conversations/[id]` | WhatsApp conversation | Webhook/session | — |
| `/email/inbound/webhook/route.ts` | Inbound email webhook | Webhook secret | — |
| `/api/health/ready` | Health check (used by deploy worker) | — | — |

Authentication: DB-backed session token (HttpOnly cookie); 7 roles / 47
permissions (RBAC); server-authoritative. Super Admin excluded from complaint-
workflow notifications.

Error handling: route files return structured error responses; business rules
enforced in backend (`src/lib/hms/`); no frontend-only security.

Health: `GET /api/health/ready` → 200 when the backend can perform its
function (DB, Redis, MinIO reachable). Used by the deploy worker post-swap.
