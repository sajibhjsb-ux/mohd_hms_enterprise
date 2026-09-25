// MOHD.HMS ENTERPRISE — profile-photo reference handling.
// User.avatarUrl is ALWAYS an object-storage key under the "avatars/" prefix,
// served through the authenticated /api/v1/profile/avatar API. External URLs
// are never valid refs — the legacy Google OAuth callback once wrote the
// external Google picture URL into avatarUrl, which produced exactly the
// "broken image after re-login" bug. Anything that is not a valid avatars/ key
// is treated as "no photo"; a legacy external URL is repaired once by importing
// the Google picture into private storage.

import "server-only";
import sharp from "sharp";
import { storage } from "./storage";
import { sniffImageType } from "./irms/storage";

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // mirrors the upload route cap
const AVATAR_SIZE = 512;                  // square cover — circle-friendly

/** True when the value is a valid avatars/ storage key (mirrors the client
 *  guard in components/hms/shared/avatar.tsx). */
export function isAvatarRef(key: string | null | undefined): boolean {
  return !!key && key.startsWith("avatars/") && !key.includes("..") && !key.includes("//");
}

/** Download an external picture (Google OAuth profile photo), normalize it
 *  through the same pipeline as direct uploads and store it privately. Returns
 *  the storage key, or null on ANY failure — a profile photo is never worth
 *  failing a sign-in or blocking an account update for. */
export async function importExternalAvatar(
  url: string | null | undefined,
  userId: string
): Promise<string | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null; // never fetch non-https
    const res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > AVATAR_MAX_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > AVATAR_MAX_BYTES) return null;

    sniffImageType(buf); // content-sniffed — junk throws and is discarded
    const normalized = await sharp(buf)
      .rotate()
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: "attention" })
      .jpeg({ quality: 85 })
      .toBuffer();

    const key = `avatars/${userId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    await storage.put(key, normalized, "image/jpeg");
    return key;
  } catch {
    return null;
  }
}