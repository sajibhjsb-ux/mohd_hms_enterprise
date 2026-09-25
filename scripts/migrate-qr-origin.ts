// QR spec §36 — CONTROLLED migration of the public verification origin.
//
// Older deployments seeded Settings → public_url with a legacy origin
// (https://www.mohdhms.com, localhost, or a private LAN address). QR URLs are
// NEVER stored in the database — they are derived at render time from this one
// setting — so migrating the origin instantly canonicalises every QR the
// system will generate from now on, while previously printed QRs keep
// resolving (any host that reaches the app can verify a token, and the
// middleware 308-redirects legacy verification hosts to the canonical one).
//
// Idempotent: run any number of times. It only rewrites the public_url setting
// when it currently holds a legacy/non-canonical origin, and prints exactly
// what it changed. Never touches tokens, signatures or business data.
//
// Usage: bun scripts/migrate-qr-origin.ts [canonical-origin]
//   default canonical origin: https://app.mohdhms.com

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const CANONICAL = (process.argv[2] || "https://app.mohdhms.com").replace(/\/+$/, "");

/** Origins that must never appear inside a production QR code (QR spec §2). */
function isLegacyOrigin(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return true; // malformed → replace
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") return true; // QR spec §9 — https only
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return true;
  if (/^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith(".local")) return true;
  if (host === "www.mohdhms.com") return true; // marketing origin ≠ verification origin
  return false;
}

async function main() {
  const row = await db.setting.findUnique({ where: { key: "public_url" } });
  const current = row?.value?.trim() ?? "";

  console.log(`[qr-origin] canonical target : ${CANONICAL}`);
  console.log(`[qr-origin] current setting  : ${current || "(unset)"}`);

  if (current && !isLegacyOrigin(current)) {
    console.log("[qr-origin] setting already canonical — nothing to do.");
    return;
  }

  await db.setting.upsert({
    where: { key: "public_url" },
    create: { key: "public_url", value: CANONICAL },
    update: { value: CANONICAL },
  });
  console.log(`[qr-origin] MIGRATED public_url: ${current || "(unset)"} → ${CANONICAL}`);
  console.log("[qr-origin] All newly generated/regenerated QR codes now encode the canonical origin.");
  console.log("[qr-origin] Previously printed codes still verify — /verify/{token} resolves on any host that reaches the app.");
}

main()
  .catch((err) => {
    console.error("[qr-origin] migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
