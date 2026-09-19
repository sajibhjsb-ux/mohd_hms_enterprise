// MOHD.HMS ENTERPRISE — WhatsApp secret encryption (AES-256-GCM).
// Mirrors src/lib/hms/email/crypto.ts exactly but keyed independently so a
// leak of one subsystem's key material never exposes the other's secrets.
// Stored format: v1:<iv-b64>:<tag-b64>:<data-b64>. Server-side ONLY.

import crypto from "crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const secret =
    process.env.WHATSAPP_CRYPTO_SECRET ||
    process.env.OTP_HASH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "mohd-hms-dev-only-whatsapp-secret";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Masked hint for safe display (never the secret itself). */
export function maskSecretHint(stored: string): string {
  const plain = decryptSecret(stored);
  if (!plain) return "";
  if (plain.length <= 6) return "••••••";
  return `${plain.slice(0, 3)}••••${plain.slice(-2)}`;
}
