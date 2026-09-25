// MOHD.HMS ENTERPRISE — scanned QR value resolution.
//
// SINGLE source of truth for turning a camera-scanned string into an action,
// reusing the application's EXISTING QR formats and destinations (no second
// QR system):
//
//   1. PUBLIC verification QRs → `${origin}/verify/{token}` — what EVERY
//      QR code now encodes (equipment labels, invoices, quotations, work
//      orders, inspection reports… QR spec §2/§12). Resolved through the
//      public verification API; equipment results carry an internal openPath
//      which is then routed through the existing equipment token lookup.
//   2. Legacy equipment QR labels → `${origin}/?resource=equipment:{qrToken}`
//      (old printed labels — kept verifiable, QR spec §36 compatibility).
//      Resolved through the existing token lookup endpoint + the equipment
//      module's deep-link navigation.
//   3. IRMS report QR codes → `${origin}/irms/reports/{id}` (as encoded by
//      /api/v1/irms/reports/[id]/qr). Routes through the existing SPA router
//      (RESOURCE_ROUTES.INSPECTION_REPORT mapping).
//   4. Any other same-origin in-app module URL (complaints, invoices, work
//      orders…) → the module's existing dedicated page. RBAC is honoured
//      twice: here as a UX hint (module must be visible to THIS user) and
//      authoritatively by the backend API on the destination page.
//   5. Bare `equipment:{token}` strings and bare equipment tokens (cuid-shaped)
//      → the equipment token flow (same convention as the shell QR dialog).
//
// Security posture (spec §18–§21): external URLs are NEVER opened; unknown
// payloads are never sent to the backend; modules the signed-in user cannot
// see are refused here instead of silently redirecting; destination pages
// still enforce real authorization server-side.

export type QrResolution =
  /** Navigate to an existing in-app module page (already RBAC-checked as a hint). */
  | { kind: "route"; module: string; seg: string[]; query: Record<string, string> }
  /** Resolve an equipment qrToken through the existing lookup endpoint. */
  | { kind: "equipment-token"; token: string }
  /** PUBLIC verification QR (/verify/{token}) — resolve through the public
   *  verification API, then open the record when it exposes an internal path. */
  | { kind: "verification"; token: string }
  /** Do nothing — show "Unsupported QR Code" (or the permission variant). */
  | { kind: "unsupported"; reason: "empty" | "external" | "unknown" | "permission" | "self" };

/** Equipment deep-link query parameter used by every printed equipment QR label. */
const RESOURCE_PARAM = "resource";

/** A bare equipment token candidate: Prisma cuid()s are alphanumeric ≥ 20 chars. */
const BARE_TOKEN_RE = /^[a-z0-9]{16,}$/i;

function parseSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/**
 * Resolve a scanned QR payload against the user's module visibility.
 * `allModules` — every module key that exists in the registry (destinations).
 * `visibleModules` — the modules THIS signed-in user may reach (shell's
 * RBAC-filtered list). The scanner itself is never a destination.
 */
export function resolveQrValue(raw: string, allModules: string[], visibleModules: string[]): QrResolution {
  const value = (raw ?? "").trim();
  if (!value) return { kind: "unsupported", reason: "empty" };

  // ── Absolute URLs ────────────────────────────────────────────────────────
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { kind: "unsupported", reason: "unknown" };
    }

    // The equipment deep link (?resource=equipment:{token}) is the app's OWN
    // QR format (printed labels encode the configured public_url, which may
    // legitimately differ from the current origin — www vs apex, staging…).
    // The extracted token is ONLY ever sent to the existing RBAC-enforced
    // lookup endpoint — the URL's host is never navigated to, so a hostile
    // QR cannot redirect or leak anything (the lookup runs with the
    // scanner's own session and 404s for anything unauthorized).
    const resource = url.searchParams.get(RESOURCE_PARAM);
    if (resource) {
      const [type, ...rest] = resource.split(":");
      const token = rest.join(":").trim();
      if (type?.toLowerCase() === "equipment" && token) return { kind: "equipment-token", token };
      // Only the equipment deep-link format exists in this application.
      return { kind: "unsupported", reason: "unknown" };
    }

    // PUBLIC verification URL — the canonical format every QR code now
    // encodes (QR spec §2). The path must be exactly /verify/{token}; only
    // the opaque token is ever sent to the app's own public verification
    // endpoint (same-origin API call — the scanned host is never contacted).
    const segs0 = parseSegments(url.pathname);
    if (segs0.length === 2 && segs0[0] === "verify" && /^[A-Za-z0-9_-]{8,80}$/.test(segs0[1])) {
      return { kind: "verification", token: segs0[1] };
    }

    // Everything else: same-origin only. External QR codes are never opened
    // (no arbitrary redirections).
    if (url.origin !== window.location.origin) return { kind: "unsupported", reason: "external" };

    const segs = parseSegments(url.pathname);
    if (segs.length === 0) return { kind: "unsupported", reason: "unknown" }; // bare origin QR
    const moduleKey = segs[0];
    if (moduleKey === "scan") return { kind: "unsupported", reason: "self" };
    if (!allModules.includes(moduleKey)) return { kind: "unsupported", reason: "unknown" };
    if (!visibleModules.includes(moduleKey)) return { kind: "unsupported", reason: "permission" };
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      if (k !== RESOURCE_PARAM && v !== "") query[k] = v;
    });
    return { kind: "route", module: moduleKey, seg: segs.slice(1), query };
  }

  // ── Non-URL payloads ─────────────────────────────────────────────────────
  // `equipment:{token}` — the same string the shell QR dialog accepts.
  const colon = value.indexOf(":");
  if (colon > 0) {
    const type = value.slice(0, colon).trim().toLowerCase();
    const token = value.slice(colon + 1).trim();
    if (type === "equipment" && token) return { kind: "equipment-token", token };
    // Other namespaced payloads are not an existing QR format — refuse.
    return { kind: "unsupported", reason: "unknown" };
  }

  // Bare token (typed-entry convention of the existing QR dialog) — only
  // plausible equipment tokens (cuid-shaped) are looked up; arbitrary text,
  // IDs with dashes, and human sentences are refused as unsupported.
  if (BARE_TOKEN_RE.test(value)) return { kind: "equipment-token", token: value };

  return { kind: "unsupported", reason: "unknown" };
}
