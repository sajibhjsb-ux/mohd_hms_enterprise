// One-shot: configure the EmailConfig singleton row for the Resend provider
// against the LIVE postgres datastore, without Prisma (the repo's datasource is
// sqlite-flavored until the deploy pipeline flips it).
//
// Mirrors src/lib/hms/email/config.ts updateEmailConfig semantics + crypto.ts
// key derivation. The live app derives its key from the same env (no
// EMAIL_CRYPTO_SECRET / OTP_HASH_SECRET / NEXTAUTH_SECRET set anywhere →
// documented fallback), so ciphertext written here decrypts in the running app.
//
// Usage (env): RESEND_API_KEY=<key> [FROM_NAME=...] [FROM_EMAIL=...] [TEST_RECIPIENT=...]
//   bun scripts/configure-resend.ts            # write the row (upsert, singleton id)
//   bun scripts/configure-resend.ts --verify   # decrypt row from DB + hit Resend /domains
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { execFileSync } from "child_process";

const PSQL = ["exec", "hms-postgres", "psql", "-U", "mohd", "-d", "mohd_hms", "-v", "ON_ERROR_STOP=1"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function secretKey(): Buffer {
  const secret =
    process.env.EMAIL_CRYPTO_SECRET ||
    process.env.OTP_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "mohd-hms-email-dev-secret";
  return createHash("sha256").update(`mohd-hms-email:${secret}`).digest();
}

function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptSecret(stored: string): string | null {
  try {
    const [v, ivB64, tagB64, dataB64] = stored.split(":");
    if (v !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** SQL single-quote escape (values are base64/emails, but stay defensive). */
function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function psql(sql: string): string {
  return execFileSync("docker", [...PSQL, "-t", "-A", "-c", sql], { encoding: "utf8" }).trim();
}

async function verifyStored(): Promise<void> {
  const row = psql(
    `SELECT provider || '|' || "smtpSecretEnc" || '|' || "fromEmail" FROM "EmailConfig" WHERE id = 'singleton'`
  );
  const [provider, enc, fromEmail] = row.split("|");
  if (provider !== "RESEND") {
    console.error(`VERIFY FAILED — provider is ${provider || "(none)"}, expected RESEND.`);
    process.exitCode = 1;
    return;
  }
  if (!enc) {
    console.error("VERIFY FAILED — no stored secret.");
    process.exitCode = 1;
    return;
  }
  const key = decryptSecret(enc);
  if (!key) {
    console.error("VERIFY FAILED — stored secret does not decrypt with this runtime's key.");
    process.exitCode = 1;
    return;
  }
  const res = await fetch("https://api.resend.com/domains", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`VERIFY FAILED — Resend rejected the decrypted key (HTTP ${res.status} ${res.statusText}).`);
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { data?: { name: string; status: string; capabilities?: { sending?: string } }[] };
  const ours = (body.data ?? []).find((d) => d.name === "mohdhms.com");
  if (!ours) {
    console.error("VERIFY FAILED — mohdhms.com not among the Resend domains for this key.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `VERIFY OK — provider=RESEND, from=${fromEmail}, key decrypts in this runtime; mohdhms.com status=${ours.status} sending=${ours.capabilities?.sending ?? "?"}`
  );
}

function main(): void {
  if (process.argv.includes("--verify")) {
    verifyStored();
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !/^re_/.test(apiKey)) {
    console.error("RESEND_API_KEY (re_...) is required to write the config.");
    process.exitCode = 1;
    return;
  }
  const fromName = (process.env.FROM_NAME || "MOHD.HMS Enterprise").trim().slice(0, 120);
  const fromEmail = (process.env.FROM_EMAIL || "noreply@mohdhms.com").trim();
  const testRecipient = (process.env.TEST_RECIPIENT || "").trim();

  if (!EMAIL_RE.test(fromEmail)) {
    console.error(`From email invalid: ${fromEmail}`);
    process.exitCode = 1;
    return;
  }
  if (testRecipient && !EMAIL_RE.test(testRecipient)) {
    console.error(`Test recipient invalid: ${testRecipient}`);
    process.exitCode = 1;
    return;
  }

  // Round-trip before we persist anything.
  const enc = encryptSecret(apiKey);
  if (decryptSecret(enc) !== apiKey) {
    console.error("Encryption round-trip failed — aborting.");
    process.exitCode = 1;
    return;
  }

  const testRecipCol = testRecipient
    ? `, "testRecipient" = ${sqlLit(testRecipient)}`
    : "";

  psql(`
    INSERT INTO "EmailConfig"
      (id, provider, "smtpSecretEnc", "fromName", "fromEmail", "replyTo",
       "configuredAt", "lastVerifyAt", "lastVerifyOk", "updatedAt"${testRecipient ? `, "testRecipient"` : ""})
    VALUES
      ('singleton', 'RESEND', ${sqlLit(enc)}, ${sqlLit(fromName)}, ${sqlLit(fromEmail)}, '',
       now(), NULL, NULL, now()${testRecipient ? `, ${sqlLit(testRecipient)}` : ""})
    ON CONFLICT (id) DO UPDATE SET
      provider = 'RESEND',
      "smtpSecretEnc" = EXCLUDED."smtpSecretEnc",
      "fromName" = EXCLUDED."fromName",
      "fromEmail" = EXCLUDED."fromEmail",
      "replyTo" = '',
      "configuredAt" = COALESCE("EmailConfig"."configuredAt", now()),
      "lastVerifyAt" = NULL,
      "lastVerifyOk" = NULL,
      "updatedAt" = now()
      ${testRecipCol}
  `);

  const after = psql(
    `SELECT provider || '|' || "fromName" || '|' || "fromEmail" || '|' || "configuredAt" || '|' || coalesce(length("smtpSecretEnc")::text, '0') FROM "EmailConfig" WHERE id = 'singleton'`
  );
  const [p, fn, fe, ca, len] = after.split("|");
  console.log(`WROTE row: provider=${p} from="${fn} <${fe}>" configuredAt=${ca} secret=${len}chars(encrypted)`);
}

try {
  main();
} catch (e) {
  console.error("Fatal:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
