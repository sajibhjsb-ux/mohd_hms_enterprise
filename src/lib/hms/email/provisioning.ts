// MOHD.HMS ENTERPRISE — CENTRAL EMAIL PROVISIONING SERVICE (email provisioning
// spec §24). ONE authoritative backend service that:
//   • detects staff eligibility from a role change (CUSTOMER → staff, §2),
//   • generates the deterministic corporate address (first.last@mohdhms.com, §4),
//   • handles duplicate names with a deterministic collision suffix (§5),
//   • provisions the mailbox in the application's REAL mail architecture (§9),
//   • keeps the lifecycle states PENDING/PROVISIONING/ACTIVE/FAILED/DISABLED (§10),
//   • is IDEMPOTENT — repeated events/retries never create duplicate mailboxes (§11),
//   • synchronizes ROLE-BASED shared mailbox access from an admin-managed mapping (§15/§32),
//   • handles role changes after staff creation WITHOUT a second mailbox (§3/§18),
//   • on staff → CUSTOMER downgrade disables + revokes access but retains data (§19/§20),
//   • audits every step (§28) and notifies the employee (§30) via the existing
//     NotificationService.
//
// PROVIDER REALITY (§9 — never fake success): the configured provider is the
// corporate SMTP relay (Mailflare endpoint in production) — SMTP defines no
// mailbox-creation API, so the REAL mailbox is provisioned in the application's
// own mail architecture (the Mailbox model + members — the exact store the
// Email client reads and sends through). The external relay limitation is
// logged once per mailbox (PROVIDER_LIMITATION note in the audit metadata) and
// "ACTIVE" honestly means: the mailbox EXISTS in the mail architecture, is
// active, and can send through the configured corporate relay.
//
// This module runs inside the existing outbox workflow engine (§25/§26) — the
// role-change transaction is never blocked on provisioning.

import "server-only";
import { db } from "@/lib/db";
import { Errors } from "@/lib/hms/api";
import { audit, notify } from "@/lib/hms/services";
import { registerWorkflow, type WorkflowResult } from "@/lib/hms/workflows/engine";
import { EVENT_TYPES } from "@/lib/hms/workflows/types";
import { ROLES, ALL_ROLES } from "@/lib/hms/constants";
import { sanitizeProviderError } from "./provider";

// ─── Constants ───────────────────────────────────────────────────────────────

const CORP_DOMAIN = "mohdhms.com";
const PROVISIONING_SETTING_KEY = "email_role_mailbox_map";
const MAX_LOCAL_PART = 60;

/** Every non-CUSTOMER application role is a staff role (§2 — approved roles). */
export function isStaffRole(role: string): boolean {
  return role !== "CUSTOMER" && Object.values(ROLES).includes(role as (typeof ROLES)[keyof typeof ROLES]);
}

/**
 * Default ROLE → shared mailbox access mapping (spec §15 example policy).
 * Administrator-managed via the Email Configuration module (§32) — stored as
 * JSON in the existing Setting store under PROVISIONING_SETTING_KEY. Addresses
 * must reference SHARED mailboxes that exist in the mail architecture.
 */
export const DEFAULT_ROLE_MAILBOX_MAP: Record<string, string[]> = {
  SUPER_ADMIN: ["admin@mohdhms.com", "info@mohdhms.com", "operations@mohdhms.com"],
  ADMIN: ["admin@mohdhms.com", "info@mohdhms.com", "operations@mohdhms.com"],
  SUPERVISOR: ["operations@mohdhms.com", "service@mohdhms.com", "projects@mohdhms.com"],
  TECHNICIAN: ["operations@mohdhms.com", "service@mohdhms.com"],
  FINANCE: ["finance@mohdhms.com", "accounts@mohdhms.com", "billing@mohdhms.com"],
  HR: ["hr@mohdhms.com", "careers@mohdhms.com"],
  // Future approved roles — active as soon as such roles/positions exist.
  PROCUREMENT: ["procurement@mohdhms.com", "purchasing@mohdhms.com"],
  OPERATIONS: ["operations@mohdhms.com", "facility@mohdhms.com", "technicians@mohdhms.com"],
  PROJECTS: ["projects@mohdhms.com"],
  INSPECTION: ["inspection@mohdhms.com", "irms@mohdhms.com"],
};

/**
 * The canonical SHARED mailboxes every mapping entry points at. Created once,
 * idempotently, by the email bootstrap (real SHARED rows in the mail
 * architecture — §15/§16: they are shared team mailboxes, NOT aliases).
 */
export const CANONICAL_SHARED_MAILBOXES: { email: string; displayName: string; description: string }[] = [
  { email: "admin@mohdhms.com", displayName: "MOHD.HMS Administration", description: "Corporate administration mailbox" },
  { email: "info@mohdhms.com", displayName: "MOHD.HMS Info", description: "General corporate inquiries" },
  { email: "operations@mohdhms.com", displayName: "MOHD.HMS Operations", description: "Field operations coordination" },
  { email: "service@mohdhms.com", displayName: "MOHD.HMS Service", description: "Service desk / maintenance requests" },
  { email: "facility@mohdhms.com", displayName: "MOHD.HMS Facility", description: "Facility management mailbox" },
  { email: "technicians@mohdhms.com", displayName: "MOHD.HMS Technicians", description: "Technician team distribution mailbox" },
  { email: "projects@mohdhms.com", displayName: "MOHD.HMS Projects", description: "Project coordination" },
  { email: "finance@mohdhms.com", displayName: "MOHD.HMS Finance", description: "Finance department mailbox" },
  { email: "accounts@mohdhms.com", displayName: "MOHD.HMS Accounts", description: "Accounts payable / receivable" },
  { email: "billing@mohdhms.com", displayName: "MOHD.HMS Billing", description: "Customer billing inquiries" },
  { email: "hr@mohdhms.com", displayName: "MOHD.HMS Human Resources", description: "HR department mailbox" },
  { email: "careers@mohdhms.com", displayName: "MOHD.HMS Careers", description: "Recruitment / careers mailbox" },
  { email: "procurement@mohdhms.com", displayName: "MOHD.HMS Procurement", description: "Procurement mailbox" },
  { email: "purchasing@mohdhms.com", displayName: "MOHD.HMS Purchasing", description: "Purchasing mailbox" },
  { email: "inspection@mohdhms.com", displayName: "MOHD.HMS Inspection", description: "Inspection team mailbox" },
  { email: "irms@mohdhms.com", displayName: "MOHD.HMS IRMS", description: "IRMS inspection reports mailbox" },
];

// ─── Corporate address generation (§4/§5/§6 — deterministic + collision-safe) ─

/** Normalize one name fragment: lowercase, strip diacritics/punctuation, keep [a-z0-9]. */
function normalizeFragment(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining marks (diacritics)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 30);
}

/**
 * Deterministic base generation: "John Doe" → john.doe; "Ahmed Rahman" →
 * ahmed.rahman. Whitespace, punctuation, special characters and repeated
 * separators collapse (§4). Falls back to the login address local-part when
 * the display name carries no usable characters — never raw/unsafe input.
 */
export function generateCorporateLocalPart(name: string, loginEmail: string): string {
  const parts = (name || "")
    .split(/[^\p{L}\p{N}]+/u)
    .map((p) => normalizeFragment(p))
    .filter(Boolean);
  const base = parts.slice(0, 3).join(".");
  if (base) return base.slice(0, MAX_LOCAL_PART);
  const fallback = normalizeFragment(loginEmail.split("@")[0] ?? "");
  return (fallback || "staff.user").slice(0, MAX_LOCAL_PART);
}

/**
 * Allocate a unique corporate address (§5/§6). Collision policy: the first
 * free `first.last@mohdhms.com`, then `first.last.2`, `first.last.3`, … —
 * deterministic, never overwrites another employee's mailbox.
 */
export async function allocateCorporateAddress(name: string, loginEmail: string, selfUserId: string): Promise<string> {
  const base = generateCorporateLocalPart(name, loginEmail);
  for (let i = 1; i <= 50; i++) {
    const local = i === 1 ? base : `${base}.${i}`;
    const candidate = `${local}@${CORP_DOMAIN}`;
    const taken = await db.mailbox.findUnique({ where: { email: candidate }, select: { id: true, ownerUserId: true } });
    if (!taken) return candidate;
    // §6(3): an existing mailbox already owned by this user is THEIRS — reuse.
    if (taken.ownerUserId === selfUserId) return candidate;
    // §6(4): owned by someone else / shared → next suffix (never overwrite).
  }
  throw Errors.conflict("Unable to allocate a unique corporate email address after 50 attempts. Contact the administrator.");
}

// ─── Role → shared mailbox mapping (§15/§32 — admin-managed configuration) ───

type RoleMailboxMap = Record<string, string[]>;

function isValidRoleKey(role: string): boolean {
  return /^[A-Z][A-Z0-9_]{1,39}$/.test(role);
}

export async function getRoleMailboxMap(): Promise<RoleMailboxMap> {
  const row = await db.setting.findUnique({ where: { key: PROVISIONING_SETTING_KEY } }).catch(() => null);
  if (!row?.value) return DEFAULT_ROLE_MAILBOX_MAP;
  try {
    const parsed = JSON.parse(row.value) as RoleMailboxMap;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_ROLE_MAILBOX_MAP;
    // Merge with defaults so newly added canonical entries appear for admins
    // while customized values survive (admin edits are never overwritten).
    return { ...DEFAULT_ROLE_MAILBOX_MAP, ...parsed };
  } catch {
    return DEFAULT_ROLE_MAILBOX_MAP;
  }
}

/** Validate + persist the mapping; returns the effective map. (§32 admin-managed.) */
export async function setRoleMailboxMap(input: unknown): Promise<RoleMailboxMap> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Errors.badRequest("Mapping must be an object of role → shared mailbox address list.");
  }
  const raw = input as Record<string, unknown>;
  const shared = await db.mailbox.findMany({ where: { kind: "SHARED" }, select: { email: true } });
  const sharedSet = new Set(shared.map((s) => s.email));
  const cleaned: RoleMailboxMap = {};
  for (const [role, value] of Object.entries(raw)) {
    if (!isValidRoleKey(role)) throw Errors.badRequest(`"${role.slice(0, 40)}" is not a valid role key.`);
    if (value === null || value === undefined) continue;
    if (!Array.isArray(value)) throw Errors.badRequest(`Mailbox access for ${role} must be a list of addresses.`);
    const addresses: string[] = [];
    for (const entry of value) {
      const addr = String(entry ?? "").trim().toLowerCase();
      if (!addr) continue;
      if (!sharedSet.has(addr)) {
        throw Errors.badRequest(`"${addr}" is not an existing SHARED mailbox. Create it in the mail architecture first (mapping targets must be real shared mailboxes, not aliases).`);
      }
      if (!addresses.includes(addr)) addresses.push(addr);
    }
    if (addresses.length > 0) cleaned[role] = addresses;
  }
  const effective: RoleMailboxMap = { ...DEFAULT_ROLE_MAILBOX_MAP, ...cleaned };
  await db.setting.upsert({
    where: { key: PROVISIONING_SETTING_KEY },
    update: { value: JSON.stringify(cleaned) },
    create: { key: PROVISIONING_SETTING_KEY, value: JSON.stringify(cleaned) },
  });
  return effective;
}

// ─── Shared mailbox bootstrap (§15 — the mapping needs real targets) ─────────

/** Idempotently create the canonical SHARED mailboxes (never overwrites edits). */
export async function ensureSharedMailboxes(): Promise<number> {
  let created = 0;
  for (const seed of CANONICAL_SHARED_MAILBOXES) {
    const exists = await db.mailbox.findUnique({ where: { email: seed.email }, select: { id: true } });
    if (exists) continue;
    await db.mailbox.create({
      data: { email: seed.email, kind: "SHARED", displayName: seed.displayName, description: seed.description, isActive: true },
    });
    created++;
  }
  return created;
}

// ─── Shared access synchronization (§15/§17/§18/§21 — mapping-driven diffs) ──

/**
 * Apply ONLY the differences the current role mapping requires (§18):
 *  • grant membership on every shared mailbox the role maps to (missing → add),
 *  • revoke membership on mapping-governed shared mailboxes the role no longer
 *    maps to — access the ADMINISTRATOR granted outside the mapping is never
 *    touched (§21 — "apply only the differences required by the role mapping").
 * Personal (owner) access is never touched here.
 * Returns { granted, revoked } with the affected addresses (audited, §28).
 */
export async function syncSharedAccess(userId: string, role: string, actor: { id: string | null; email: string }): Promise<{ granted: string[]; revoked: string[] }> {
  const map = await getRoleMailboxMap();
  const targetAddresses = new Set((map[role] ?? []).map((a) => a.toLowerCase()));
  const governedAddresses = new Set(Object.values(map).flat().map((a) => a.toLowerCase()));

  const governedMailboxes = await db.mailbox.findMany({
    where: { kind: "SHARED", email: { in: [...governedAddresses] } },
    select: { id: true, email: true },
  });
  const governedById = new Map(governedMailboxes.map((m) => [m.id, m.email]));

  const memberships = await db.mailboxMember.findMany({
    where: { userId, mailbox: { kind: "SHARED" } },
    select: { id: true, mailboxId: true, mailbox: { select: { email: true } } },
  });

  const granted: string[] = [];
  const revoked: string[] = [];

  // Grant missing target memberships (only ACTIVE shared mailboxes).
  for (const address of targetAddresses) {
    const mailbox = await db.mailbox.findUnique({ where: { email: address }, select: { id: true, email: true, isActive: true } });
    if (!mailbox) continue; // mapping references a mailbox that was deleted — skipped safely
    const existing = memberships.find((m) => m.mailboxId === mailbox.id);
    if (!existing) {
      await db.mailboxMember.create({ data: { mailboxId: mailbox.id, userId, canSend: true } });
      granted.push(mailbox.email);
    }
  }

  // Revoke mapping-governed memberships the role no longer maps to.
  for (const membership of memberships) {
    const address = governedById.get(membership.mailboxId) ?? membership.mailbox.email.toLowerCase();
    if (!governedAddresses.has(address)) continue; // outside the mapping universe — admin-managed, preserved
    if (!targetAddresses.has(address)) {
      await db.mailboxMember.delete({ where: { id: membership.id } });
      revoked.push(address);
    }
  }

  if (granted.length > 0) {
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "SHARED_MAILBOX_ACCESS_GRANTED", resourceType: "USER", resourceId: userId,
      metadata: { role, mailboxes: granted },
    });
  }
  if (revoked.length > 0) {
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "SHARED_MAILBOX_ACCESS_REVOKED", resourceType: "USER", resourceId: userId,
      metadata: { role, mailboxes: revoked },
    });
  }
  return { granted, revoked };
}

// ─── Provisioning state machine (§10/§11/§27) ────────────────────────────────

export type ProvisioningOutcome = {
  status: "ACTIVE" | "FAILED" | "DISABLED" | "PENDING";
  corporateEmail: string;
  mailboxId: string | null;
  created: boolean; // a NEW mailbox row was created by this run
  granted: string[];
  revoked: string[];
  providerNote: string;
};

/**
 * Ensure the user has an ACTIVE corporate mailbox + role-based shared access.
 * IDEMPOTENT (§11): an existing owned mailbox is always REUSED — repeated
 * calls, event retries or double submissions never create a second mailbox
 * (the Mailbox.email unique constraint is the final guard, §6).
 */
export async function provisionForUser(userId: string, opts: { previousRole?: string; newRole?: string; actorId?: string | null; actorEmail?: string } = { }): Promise<ProvisioningOutcome> {
  const actor = { id: opts.actorId ?? null, email: opts.actorEmail ?? "system@workflow" };
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true, status: true },
  });
  if (!user) throw Errors.notFound("User not found.");
  if (!isStaffRole(user.role)) throw Errors.badRequest("Only staff roles receive a corporate mailbox.");
  if (user.status !== "ACTIVE") throw Errors.badRequest("Disabled users cannot be provisioned.");

  const role = user.role;
  const roleChanged = (opts.previousRole ?? role) !== role;

  // 1) Find or allocate the lifecycle record + address.
  let record = await db.mailboxProvisioning.findUnique({ where: { userId }, include: { mailbox: { select: { id: true, email: true, isActive: true } } } });
  if (!record) {
    const corporateEmail = await allocateCorporateAddress(user.name, user.email, userId);
    record = await db.mailboxProvisioning.create({
      data: {
        userId, corporateEmail, status: "PROVISIONING",
        previousRole: opts.previousRole ?? "", newRole: role,
        triggeredById: actor.id,
      },
      include: { mailbox: { select: { id: true, email: true, isActive: true } } },
    });
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "EMAIL_PROVISIONING_STARTED", resourceType: "USER", resourceId: userId,
      metadata: {
        corporateEmail, previousRole: opts.previousRole ?? "", newRole: role,
        eligibility: isStaffRole(opts.previousRole ?? "") ? "ROLE_CHANGE" : "ADMIN_ACTION",
        provider: "INTERNAL_MAIL_ARCHITECTURE",
      },
    });
  }

  // 2) Reuse the existing mailbox when one is already attached (§11) — by
  //    lifecycle record, or by ownership scan for pre-existing personal mailboxes.
  let mailbox = record.mailbox;
  if (!mailbox) {
    mailbox = await db.mailbox.findFirst({ where: { kind: "PERSONAL", ownerUserId: userId }, select: { id: true, email: true, isActive: true } });
  }
  let created = false;
  if (!mailbox) {
    // 3) Create the REAL mailbox in the application mail architecture (§9).
    const displayName = user.name || user.email;
    mailbox = await db.mailbox.create({
      data: {
        email: record.corporateEmail,
        kind: "PERSONAL",
        ownerUserId: userId,
        displayName,
        description: "Corporate mailbox — provisioned automatically on staff promotion.",
        isActive: true,
        members: { create: { userId, canSend: true } },
      },
      select: { id: true, email: true, isActive: true },
    });
    created = true;
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "CORPORATE_MAILBOX_CREATED", resourceType: "MAILBOX", resourceId: mailbox.id,
      metadata: {
        corporateEmail: mailbox.email, userId, role,
        provider: "INTERNAL_MAIL_ARCHITECTURE",
        providerNote: "SMTP relay (Mailflare) exposes no mailbox-creation API; mailbox provisioned in the application mail architecture — outbound delivery via the configured corporate relay.",
      },
    });
    // Keep the allocation record's address authoritative if it raced.
    if (record.corporateEmail !== mailbox.email) {
      await db.mailboxProvisioning.update({ where: { id: record.id }, data: { corporateEmail: mailbox.email } });
    }
  }

  await db.mailboxProvisioning.update({
    where: { id: record.id },
    data: {
      mailboxId: mailbox.id,
      status: "ACTIVE",
      lastError: "",
      newRole: role,
      ...(roleChanged ? { previousRole: opts.previousRole ?? "" } : {}),
      provisionedAt: record.provisionedAt ?? new Date(),
      disabledAt: null,
      attempts: { increment: 1 },
    },
  });

  // 4) Re-enable the mailbox itself when it was previously disabled (§19 restore).
  if (!mailbox.isActive) {
    await db.mailbox.update({ where: { id: mailbox.id }, data: { isActive: true } });
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "CORPORATE_MAILBOX_ENABLED", resourceType: "MAILBOX", resourceId: mailbox.id,
      metadata: { corporateEmail: mailbox.email, userId, reason: "STAFF_RE_PROMOTION" },
    });
  }

  // 5) Role-based shared access (§15/§17).
  const { granted } = await syncSharedAccess(userId, role, actor);

  // 6) Notify the employee (§30) — no credentials exist for internal mailboxes;
  //    access is through the user's existing application session (§12/§13).
  if (created) {
    await notify({
      userId,
      title: "Your MOHD.HMS corporate email has been created",
      message: `Corporate email: ${mailbox.email}. It is already available in the Email module — open Email to start using it. For questions contact support@mohdhms.com.`,
      type: "INFO", resourceType: "USER", resourceId: userId,
      channels: ["IN_APP", "EMAIL"],
    });
  } else if (granted.length > 0) {
    await notify({
      userId,
      title: "Your corporate email access was updated",
      message: `You now have access to: ${granted.join(", ")}. Open the Email module to use the new shared mailbox${granted.length > 1 ? "es" : ""}.`,
      type: "INFO", resourceType: "USER", resourceId: userId,
    });
  }

  return {
    status: "ACTIVE", corporateEmail: mailbox.email, mailboxId: mailbox.id, created,
    granted, revoked: [],
    providerNote: created
      ? "Mailbox provisioned in the application mail architecture (SMTP relay exposes no mailbox-creation API); outbound delivery uses the configured corporate relay."
      : "Existing mailbox reused (idempotent provisioning — no duplicate created).",
  };
}

/** Staff → CUSTOMER downgrade (§19/§20): disable + revoke, NEVER delete. */
export async function downgradeToCustomer(userId: string, opts: { previousRole?: string; actorId?: string | null; actorEmail?: string } = {}): Promise<ProvisioningOutcome> {
  const actor = { id: opts.actorId ?? null, email: opts.actorEmail ?? "system@workflow" };
  const record = await db.mailboxProvisioning.findUnique({ where: { userId }, include: { mailbox: { select: { id: true, email: true, isActive: true } } } });
  let corporateEmail = record?.corporateEmail ?? "";
  let mailboxId = record?.mailboxId ?? null;

  // Also catch a personal mailbox that exists without a lifecycle record.
  if (!record?.mailbox) {
    const owned = await db.mailbox.findFirst({ where: { kind: "PERSONAL", ownerUserId: userId }, select: { id: true, email: true, isActive: true } });
    if (owned) { corporateEmail = owned.email; mailboxId = owned.id; }
  }

  const revoked: string[] = [];
  if (mailboxId) {
    // 1) Suspend the mailbox (data + history fully retained — §19/§20).
    await db.mailbox.update({ where: { id: mailboxId }, data: { isActive: false } });
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "CORPORATE_MAILBOX_DISABLED", resourceType: "MAILBOX", resourceId: mailboxId,
      metadata: { corporateEmail, userId, previousRole: opts.previousRole ?? "", reason: "STAFF_TO_CUSTOMER_DOWNGRADE", dataRetained: true },
    });
    // 2) Revoke mapping-governed shared access (§21).
    const map = await getRoleMailboxMap();
    const governedAddresses = new Set(Object.values(map).flat().map((a) => a.toLowerCase()));
    const memberships = await db.mailboxMember.findMany({
      where: { userId, mailbox: { kind: "SHARED", email: { in: [...governedAddresses] } } },
      select: { id: true, mailbox: { select: { email: true } } },
    });
    for (const membership of memberships) {
      await db.mailboxMember.delete({ where: { id: membership.id } });
      revoked.push(membership.mailbox.email);
    }
    if (revoked.length > 0) {
      await audit({
        actorId: actor.id, actorEmail: actor.email,
        action: "SHARED_MAILBOX_ACCESS_REVOKED", resourceType: "USER", resourceId: userId,
        metadata: { role: "CUSTOMER", mailboxes: revoked, reason: "STAFF_TO_CUSTOMER_DOWNGRADE" },
      });
    }
  }

  if (record) {
    await db.mailboxProvisioning.update({
      where: { id: record.id },
      data: { status: "DISABLED", previousRole: opts.previousRole ?? "", newRole: "CUSTOMER", disabledAt: new Date(), lastError: "", mailboxId },
    });
  }

  await notify({
    userId,
    title: "Corporate mailbox suspended",
    message: "Your account is no longer a staff role. Your corporate mailbox has been suspended and staff shared-mailbox access revoked. Your mailbox content is retained and will be restored if you become staff again.",
    type: "WARNING", resourceType: "USER", resourceId: userId,
  });

  return { status: "DISABLED", corporateEmail, mailboxId, created: false, granted: [], revoked, providerNote: "Mailbox disabled (data retained); shared access revoked." };
}

/** Administrator retry (§27): re-run a PENDING/FAILED provisioning — idempotent. */
export async function retryProvisioning(userId: string, actor: { id: string; email: string }): Promise<ProvisioningOutcome> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, email: true } });
  if (!user) throw Errors.notFound("User not found.");
  const record = await db.mailboxProvisioning.findUnique({ where: { userId }, select: { status: true, id: true } });
  if (!record && !isStaffRole(user.role)) throw Errors.badRequest("This user has never held a staff role — there is nothing to provision.");
  if (record) {
    await db.mailboxProvisioning.update({
      where: { id: record.id },
      data: { status: "PROVISIONING", lastError: "", triggeredById: actor.id, attempts: { increment: 1 } },
    });
    await audit({
      actorId: actor.id, actorEmail: actor.email,
      action: "PROVISIONING_RETRIED", resourceType: "USER", resourceId: userId,
      metadata: { fromStatus: record.status, role: user.role },
    });
  }
  if (!isStaffRole(user.role)) throw Errors.badRequest("Only staff roles can have an active corporate mailbox.");
  return provisionForUser(userId, { actorId: actor.id, actorEmail: actor.email });
}

/** Administrator manual provisioning (§29) — for pre-existing staff accounts. */
export async function adminProvision(userId: string, actor: { id: string; email: string }): Promise<ProvisioningOutcome> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw Errors.notFound("User not found.");
  if (!isStaffRole(user.role)) throw Errors.badRequest("Corporate mailboxes are provisioned for staff roles only.");
  const result = await provisionForUser(userId, { actorId: actor.id, actorEmail: actor.email, previousRole: "CUSTOMER" });
  return result;
}

/** Administrator disable (§29) — same safe lifecycle as a downgrade. */
export async function adminDisable(userId: string, actor: { id: string; email: string }): Promise<ProvisioningOutcome> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw Errors.notFound("User not found.");
  if (isStaffRole(user.role)) {
    throw Errors.badRequest("This user is an active staff member — downgrade their role before disabling the corporate mailbox.");
  }
  return downgradeToCustomer(userId, { previousRole: "CUSTOMER", actorId: actor.id, actorEmail: actor.email });
}

/** Administrator re-enable (§29). */
export async function adminEnable(userId: string, actor: { id: string; email: string }): Promise<ProvisioningOutcome> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw Errors.notFound("User not found.");
  if (!isStaffRole(user.role)) throw Errors.badRequest("Only staff roles can have an active corporate mailbox.");
  return provisionForUser(userId, { actorId: actor.id, actorEmail: actor.email });
}

// ─── Status projection for admin UI (§29) ────────────────────────────────────

export type ProvisioningStatus = {
  userId: string;
  userRole: string;
  corporateEmail: string;
  mailboxId: string | null;
  mailboxActive: boolean;
  status: string; // NOT_REQUIRED | PENDING | PROVISIONING | ACTIVE | FAILED | DISABLED
  attempts: number;
  lastError: string;
  provisionedAt: string | null;
  disabledAt: string | null;
  sharedAccess: { mailboxId: string; email: string; displayName: string; canSend: boolean; managedByRole: boolean }[];
};

export async function getStatusForUser(userId: string): Promise<ProvisioningStatus> {
  const [user, record] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } }),
    db.mailboxProvisioning.findUnique({
      where: { userId },
      include: { mailbox: { select: { id: true, email: true, isActive: true } } },
    }),
  ]);
  if (!user) throw Errors.notFound("User not found.");

  let corporateEmail = record?.corporateEmail ?? "";
  let mailboxId = record?.mailboxId ?? record?.mailbox?.id ?? null;
  let mailboxActive = record?.mailbox?.isActive ?? false;
  if (!mailboxId) {
    const owned = await db.mailbox.findFirst({ where: { kind: "PERSONAL", ownerUserId: userId }, select: { id: true, email: true, isActive: true } });
    if (owned) { corporateEmail = corporateEmail || owned.email; mailboxId = owned.id; mailboxActive = owned.isActive; }
  }

  const memberships = await db.mailboxMember.findMany({
    where: { userId, mailbox: { kind: "SHARED" } },
    select: { mailboxId: true, canSend: true, mailbox: { select: { email: true, displayName: true } } },
    orderBy: { mailbox: { email: "asc" } },
  });
  const map = await getRoleMailboxMap();
  const mappedForRole = new Set((map[user.role] ?? []).map((a) => a.toLowerCase()));

  let status = record?.status ?? "NOT_REQUIRED";
  if (!record && mailboxId && isStaffRole(user.role) && mailboxActive) status = "ACTIVE";
  if (!record && mailboxId && !mailboxActive) status = "DISABLED";

  return {
    userId,
    userRole: user.role,
    corporateEmail,
    mailboxId,
    mailboxActive,
    status,
    attempts: record?.attempts ?? 0,
    lastError: record?.lastError ?? "",
    provisionedAt: record?.provisionedAt?.toISOString() ?? null,
    disabledAt: record?.disabledAt?.toISOString() ?? null,
    sharedAccess: memberships.map((m) => ({
      mailboxId: m.mailboxId,
      email: m.mailbox.email,
      displayName: m.mailbox.displayName,
      canSend: m.canSend,
      managedByRole: mappedForRole.has(m.mailbox.email.toLowerCase()),
    })),
  };
}

// ─── Outbox workflow wiring (§25/§26 — existing event architecture) ─────────

type RoleChangedPayload = { previousRole?: string; newRole?: string; targetEmail?: string; targetName?: string };

async function handleRoleChanged(ctx: { resourceId: string; payload: RoleChangedPayload }): Promise<WorkflowResult> {
  const userId = ctx.resourceId;
  const previousRole = String(ctx.payload.previousRole ?? "");
  const newRole = String(ctx.payload.newRole ?? "");
  if (!userId || !previousRole || !newRole) return { result: "SKIPPED", detail: "USER_ROLE_CHANGED payload missing userId/roles" };
  if (previousRole === newRole) return { result: "SKIPPED", detail: "roles identical" };

  const wasStaff = isStaffRole(previousRole);
  const isStaff = isStaffRole(newRole);

  // §3/§18: staff → staff NEVER creates a second mailbox — the existing one is
  // reused (provisionForUser is idempotent) and only shared access is re-synced.
  if (isStaff) {
    const outcome = await provisionForUser(userId, { previousRole, newRole });
    return { result: "SUCCESS", detail: `corporate=${outcome.corporateEmail} created=${outcome.created} granted=[${outcome.granted.join(", ")}]` };
  }

  // §19: staff → CUSTOMER — disable + revoke, retain data.
  if (wasStaff) {
    const outcome = await downgradeToCustomer(userId, { previousRole, actorEmail: "system@workflow" });
    return { result: "SUCCESS", detail: `mailbox=${outcome.corporateEmail || "none"} disabled revoked=[${outcome.revoked.join(", ")}]` };
  }

  return { result: "SKIPPED", detail: "CUSTOMER → CUSTOMER transition (no provisioning)" };
}

/** Register the provisioning workflow on the outbox engine (idempotent call). */
export function registerProvisioningWorkflow(): void {
  registerWorkflow(EVENT_TYPES.USER_ROLE_CHANGED, "EMAIL_PROVISIONING", async (ctx): Promise<WorkflowResult> => {
    try {
      return await handleRoleChanged(ctx);
    } catch (e) {
      // §27 — record a safe failure and surface it for the admin [Retry] action.
      const message = sanitizeProviderError(e instanceof Error ? e.message : String(e));
      const userId = ctx.resourceId;
      if (userId) {
        const role = await db.user.findUnique({ where: { id: userId }, select: { role: true } }).catch(() => null);
        if (role && isStaffRole(role.role)) {
          const corporateEmail = (await db.mailboxProvisioning.findUnique({ where: { userId }, select: { corporateEmail: true } }))?.corporateEmail
            ?? `${generateCorporateLocalPart("", "")}@${CORP_DOMAIN}`;
          await db.mailboxProvisioning.upsert({
            where: { userId },
            update: { status: "FAILED", lastError: message },
            create: { userId, corporateEmail, status: "FAILED", previousRole: String(ctx.payload.previousRole ?? ""), newRole: String(ctx.payload.newRole ?? ""), lastError: message },
          });
        }
      }
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "email-provisioning-failed", userId, err: message }));
      return { result: "FAILED", detail: message };
    }
  });
}

/** Which roles exist in the mapping UI (existing roles + custom mapping keys). */
export async function listMappingRoles(): Promise<string[]> {
  const map = await getRoleMailboxMap();
  const keys = new Set<string>([...ALL_ROLES.map((r) => String(r)), ...Object.keys(map)]);
  return [...keys].sort();
}
