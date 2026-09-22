// MOHD.HMS ENTERPRISE — shared server-side search-term utilities.
// Used by the list APIs that back Global Search (complaints / work orders /
// customers / equipment). Keeps the existing Prisma `contains` architecture;
// only normalizes the term and makes it case-insensitive.

/** Normalize a search term: trim, collapse repeated internal whitespace,
 *  cap length. Identifiers like "WO-2026-00452" are preserved as-is
 *  (only whitespace is touched — never punctuation or dashes). */
export function normalizeSearchTerm(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 100);
}

/**
 * Case-insensitive `contains` filter for the ACTIVE datasource dialect.
 *
 * - SQLite (sandbox/default): Prisma translates `contains` to LIKE, which is
 *   already case-insensitive for ASCII — and Prisma REJECTS `mode:
 *   "insensitive"` on the SQLite connector, so it must NOT be added there.
 * - PostgreSQL (production): `contains` is case-sensitive unless
 *   `mode: "insensitive"` is passed, so we add it.
 *
 * One helper so every list API stays consistent and the production flip
 * (schema provider + DATABASE_URL) needs no per-route changes.
 */
export function ciContains(term: string): { contains: string; mode?: "insensitive" } {
  if (process.env.DATABASE_URL?.startsWith("postgres")) {
    return { contains: term, mode: "insensitive" };
  }
  return { contains: term };
}
