// MOHD.HMS ENTERPRISE — Complaint Work Catalogue shared helper (§12/§13).
// Configurable master data: a catalogue (service category code) carries its own
// dynamic issue list. Default catalogues are bootstrapped ONCE when the tables
// are empty so complaint entry always has a taxonomy; management users can then
// add/edit/deactivate catalogues and catalogue-specific issues via the API.

import "server-only";
import { db } from "@/lib/db";

/** Bootstrap catalogues (additive, idempotent — only inserted when empty). */
export const DEFAULT_CATALOGUES = [
  { code: "MECH", name: "Mechanical", issues: ["Pump failure", "Motor burnout", "Bearing failure", "Shaft misalignment", "Seal leakage", "Excessive vibration"] },
  { code: "ELEC", name: "Electrical", issues: ["Circuit breaker trip", "Power outage", "Wiring fault", "Lighting failure", "Motor starter fault", "Socket / outlet fault"] },
  { code: "HVAC", name: "HVAC / Air Conditioning", issues: ["Not cooling", "Not heating", "Refrigerant leak", "Compressor fault", "Water leakage", "Fan coil unit fault", "Thermostat fault"] },
  { code: "PLUMB", name: "Plumbing", issues: ["Pipe leak", "Blocked drain", "Overflow", "Low water pressure", "Sanitary / toilet fault", "Valve fault"] },
  { code: "STRUCT", name: "Building & Structure", issues: ["Ceiling leak", "Wall crack", "Door fault", "Window fault", "Roof leak", "Dampness / mould"] },
  { code: "FIRE", name: "Fire Safety", issues: ["Fire alarm fault", "Extinguisher missing or expired", "Smoke detector fault", "Sprinkler fault", "Emergency light fault"] },
  { code: "SECUR", name: "Security", issues: ["Door latch fault", "Intercom fault", "CCTV fault", "Access control fault", "Grille fault"] },
  { code: "GEN", name: "General", issues: ["Other / not listed"] },
] as const;

/** Insert the default catalogue set only when the catalogue table is empty. */
export async function ensureDefaultCatalogues(): Promise<void> {
  try {
    const count = await db.workCatalogue.count();
    if (count > 0) return;
    await db.$transaction(async (tx) => {
      for (const [i, c] of DEFAULT_CATALOGUES.entries()) {
        await tx.workCatalogue.create({
          data: {
            code: c.code,
            name: c.name,
            sortOrder: i,
            issues: { create: c.issues.map((name, j) => ({ name, sortOrder: j })) },
          },
        });
      }
    });
  } catch (err) {
    // Best-effort bootstrap — a concurrent insert or transient DB error must
    // never fail complaint entry; the next call retries.
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "catalogue.bootstrap.failed", err: String(err) }));
  }
}