// MOHD.HMS ENTERPRISE — In-memory sliding-window rate limiter.
// (Cache/ephemeral layer only — permanent data lives in the database.)

import "server-only";

type Bucket = { hits: number[] };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs);
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    const retryAfter = Math.ceil((windowMs - (now - bucket.hits[0])) / 1000);
    return { allowed: false, retryAfterSec: retryAfter };
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  // opportunistic cleanup
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (b.hits.every((t) => now - t > windowMs)) buckets.delete(k);
    }
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}
