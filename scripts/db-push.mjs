#!/usr/bin/env node
// Guard for `prisma db push` — a schema change must never silently drop data.
// `prisma db push --accept-data-loss` (or --force-reset) is BLOCKED unless the
// operator explicitly opts in with FORCE_DATA_LOSS=1. The plain push (schema
// sync without destructive changes) runs normally.

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dangerous = args.includes("--accept-data-loss") || args.includes("--force-reset");
const force = process.env.FORCE_DATA_LOSS === "1";

if (dangerous && !force) {
  console.error("[db:push] Refusing to run with --accept-data-loss / --force-reset without FORCE_DATA_LOSS=1.");
  console.error("[db:push] On a developer DB where data loss is acceptable, re-run with: FORCE_DATA_LOSS=1 bun run db:push -- --accept-data-loss");
  process.exit(1);
}

const res = spawnSync("npx", ["prisma", "db", "push", ...args], { stdio: "inherit" });
process.exit(res.status ?? 1);