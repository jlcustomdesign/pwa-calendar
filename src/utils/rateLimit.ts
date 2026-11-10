// ponytail: in-memory per-instance limiter — blunts brute force on one instance.
// Ceiling: counters reset on cold start / don't sync across Vercel instances.
// Upgrade path for strict limits: Vercel Firewall rate rules or @vercel/ratelimit + Upstash.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  if (buckets.size > 10_000) buckets.clear(); // prune against memory growth
  if (bucket.count <= limit) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
}
