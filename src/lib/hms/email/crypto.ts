// MOHD.HMS ENTERPRISE — SMTP secret encryption (§4 SECURITY OF EMAIL CONFIGURATION).
// The SMTP password is stored AES-256-GCM encrypted, keyed by a server-only secret
// (dedicated EMAIL_CRYPTO_SECRET when provided, otherwise the existing OTP hash
// secret / NextAuth secret — the SAME pattern every other server secret uses).
//
//   • Plaintext is never stored in the database.
//   • Plaintext is never logged, never audited, never returned by any API.
//   • The frontend only ever learns WHETHER a password is stored (hasPassword).
//   • Ciphertext format: v1:<iv-b64>:<tag-b64>:<data-b64> (authenticated).

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const VERSION = "v1";

function secretKey(): Buffer {
  const secret =
    process.env.EMAIL_CRYPTO_SECRET ||
    process.env.OTP_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "mohd-hms-email-dev-secret";
  // Derive a stable 32-byte key from the server secret (scrypt-equivalent via
  // salted SHA-256 is sufficient here because the input is already high-entropy
  // and the ciphertext never leaves the server).
  return createHash("sha256").update(`mohd-hms-email:${secret}`).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored: string): string | null {
  try {
    const [v, ivB64, tagB64, dataB64] = stored.split(":");
    if (v !== VERSION || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    // Wrong secret / tampered ciphertext — treat as "no usable password".
    return null;
  }
}

/** Mask a secret for logs/audit — only a length hint, never any content. */
export function maskSecretHint(stored: string): string {
  return stored ? `set(${stored.length} chars encrypted)` : "not set";
}
