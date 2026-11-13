// scripts/mfa-seed.ts
// bun --conditions=react-server scripts/mfa-seed.ts
import { ensureMfaPolicies, getMfaPolicyMap } from "@/lib/hms/mfa/policy";

async function main() {
  await ensureMfaPolicies();
  console.log(JSON.stringify(await getMfaPolicyMap(), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
