// MOHD.HMS ENTERPRISE — Presence visibility policy (STEP 18 privacy).
//
// SINGLE SOURCE OF TRUTH for "which online users may a given role see".
// This module is intentionally PURE (no imports, no framework code) so it runs
// unchanged in BOTH runtimes that must agree:
//   • the Next.js app  — REST presence route + header rendering
//     (imported via `@/lib/hms/realtime/presence`)
//   • the socket.io mini-service — WebSocket fan-out
//     (imported via a relative path from mini-services/realtime-service)
//
// The BACKEND is authoritative: the mini-service and the REST route filter
// BEFORE returning anything, and the UI merely renders what it was given.
//
// Matrix (default policy):
//   SUPER_ADMIN | ADMIN   → all online users + total unique-user count
//   SUPERVISOR            → online TECHNICIAN users only + technician count
//   TECHNICIAN | CUSTOMER → own presence only, no global count
//   FINANCE | HR | others → own presence only, no global count
//
// The viewer's role ALWAYS comes from the server-verified session — never from
// a client-supplied value, query parameter or request body.

export type PresenceVisibility = "all" | "technicians" | "self";

/** One unique online user (canonical presence entry from the mini-service). */
export type PresenceEntry = {
  userId: string;
  name: string;
  role: string;
  /** Live socket count for this user — only ever exposed in "all"/"technicians". */
  sockets: number;
  since: number;
  lastSeenAt?: number;
};

/** The exactly-authorized projection for one viewer. */
export type PresenceScope = {
  visibility: PresenceVisibility;
  presence: PresenceEntry[];
  /** Unique-user count this viewer may see; null = no global count permitted. */
  count: number | null;
};

/** Resolve a role to its presence visibility class. Fail-closed to "self". */
export function presenceVisibility(role: string | null | undefined): PresenceVisibility {
  if (role === "SUPER_ADMIN" || role === "ADMIN") return "all";
  if (role === "SUPERVISOR") return "technicians";
  return "self";
}

/** Roles that receive the full online-user list + total unique-user count. */
export const ALL_VISIBILITY_ROLES = ["SUPER_ADMIN", "ADMIN"] as const;
/** Roles that receive the technician-only list + technician count. */
export const TECHNICIAN_VISIBILITY_ROLES = ["SUPERVISOR"] as const;

/**
 * socket.io rooms that must receive a given visibility class's projection.
 * Self-only roles have NO broadcast audience — their own status is derived
 * from their own socket connection, so nothing is pushed to them.
 */
export function presenceAudienceRooms(visibility: PresenceVisibility): string[] {
  if (visibility === "all") return ALL_VISIBILITY_ROLES.map((r) => `role:${r}`);
  if (visibility === "technicians") return TECHNICIAN_VISIBILITY_ROLES.map((r) => `role:${r}`);
  return [];
}

/**
 * Filter the canonical presence snapshot for a viewer. `viewerRole` is the
 * server-resolved role; `viewerUserId` is the authenticated user id (only used
 * for the self-only projection). This is the single enforcement point — reuse
 * it for both the WebSocket reply and the REST response.
 */
export function scopePresence(
  viewerRole: string | null | undefined,
  viewerUserId: string,
  all: PresenceEntry[],
): PresenceScope {
  const visibility = presenceVisibility(viewerRole);
  if (visibility === "all") return { visibility, presence: all, count: all.length };
  if (visibility === "technicians") {
    const presence = all.filter((e) => e.role === "TECHNICIAN");
    return { visibility, presence, count: presence.length };
  }
  return { visibility, presence: all.filter((e) => e.userId === viewerUserId), count: null };
}
