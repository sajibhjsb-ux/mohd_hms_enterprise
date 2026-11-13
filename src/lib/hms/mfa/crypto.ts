import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;

function key(): Buffer {
  const encoded = process.env.MFA_ENCRYPTION_KEY;
  if (!encoded) throw new Error("MFA_ENCRYPTION_KEY is not set");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must be 32 base64-encoded bytes");
  return decoded;
}

export function encryptSecret(plain: string, userId: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(userId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(stored: string, userId: string): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(userId, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
