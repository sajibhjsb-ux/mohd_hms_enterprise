// MOHD.HMS ENTERPRISE — AI credential encryption (central AI config spec §3/§5/§30).
// The provider API key entered by the administrator in Settings → AI is stored
// AES-256-GCM encrypted, keyed by a server-only secret (dedicated
// AI_SETTINGS_ENCRYPTION_KEY when provided, otherwise the SAME secret chain
// every other server secret in this project uses — see email/crypto.ts).
//
//   • Plaintext is never stored in the database.
//   • Plaintext is never logged, never audited, never returned by any API.
//   • The frontend only ever learns WHETHER a key is stored + a last-4 hint.
//   • Ciphertext format: v1:<iv-b64>:<tag-b64>:<data-b64> (authenticated).
//   • The encryption master secret is never stored in the database and never
//     committed to Git (.env is gitignored).

import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const VERSION = "v1";

function secretKey(): Buffer {
  const secret =
    process.env.AI_SETTINGS_ENCRYPTION_KEY ||
    process.env.EMAIL_CRYPTO_SECRET ||
    process.env.OTP_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "mohd-hms-ai-dev-secret";
  // Derive a stable 32-byte key from the server secret (same approach as
  // email/crypto.ts — the input is high-entropy and the ciphertext never
  // leaves the server).
  return createHash("sha256").update(`mohd-hms-ai:${secret}`).digest();
}

export function encryptAiSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptAiSecret(stored: string): string | null {
  if (!stored) return null;
  try {
    const [v, ivB64, tagB64, dataB64] = stored.split(":");
    if (v !== VERSION || !ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    // Wrong secret / tampered ciphertext — treat as "no usable credential".
    return null;
  }
}

/** Mask for audit/log lines — only a length hint, never any content. */
export function maskAiSecretHint(last4: string): string {
  return last4 ? `set(••••${last4})` : "not set";
}
