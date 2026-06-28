/**
 * Per-IP rate limiter for `POST /api/jobs` (route layer, backend — BE).
 *
 * Basic abuse guard (architecture §9, product-flow §2.7/§5h): a process-global
 * token bucket per client IP. Non-blocking — on an empty bucket it returns a
 * `retryAfter` hint so the route answers `429` immediately (it never awaits a
 * refill the way the per-provider limiter does). In-memory + per-process, so it
 * resets on cold start (the accepted MVP trade-off, same as the state store).
 *
 * Config: `JOBS_RATE_LIMIT_PER_MIN` (default 30) — generous for the single-user
 * app while still throttling a runaway client / script.
 */

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();

function perMinute(): number {
  const raw = process.env.JOBS_RATE_LIMIT_PER_MIN;
  if (raw === undefined || raw.trim() === "") return 30;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Try to consume one token for `key` (the client IP). O(1), non-blocking. The
 * bucket capacity equals the per-minute allowance and refills continuously.
 */
export function checkJobRateLimit(key: string): RateLimitResult {
  const capacity = perMinute();
  const refillPerMs = capacity / 60_000;
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefill = now;
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true };
  }

  const deficitMs = (1 - bucket.tokens) / refillPerMs;
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(deficitMs / 1000)) };
}

/** Derive a best-effort client IP from proxy headers (Vercel sets these). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real && real.trim() !== "") return real.trim();
  return "unknown";
}

/** Test/maintenance hook: clear all buckets. */
export function resetJobRateLimit(): void {
  buckets.clear();
}
