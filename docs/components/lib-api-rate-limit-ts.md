---
component: JobRateLimit
source: lib/api/rate-limit.ts
agent: backend
updated: 2026-06-28
---

# JobRateLimit

## Purpose
Per-IP abuse guard for `POST /api/jobs` — a process-global, non-blocking token bucket per client IP that lets the route answer `429` immediately when a client exceeds its per-minute allowance.

## Public Interface
- `function checkJobRateLimit(key: string): RateLimitResult` — try to consume one token for `key` (the client IP); O(1), non-blocking.
- `function clientIp(request: Request): string` — derive a best-effort client IP from proxy headers.
- `function resetJobRateLimit(): void` — clear all buckets (tests/maintenance).
- `type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }`.

## Inputs and Outputs
- `checkJobRateLimit` returns `{ ok: true }` when a token is available (decrementing it), else `{ ok: false, retryAfterSeconds }` (≥ 1, ceil of the time to refill one token). Capacity = per-minute allowance, refilling continuously; first sighting of a key starts full.
- `clientIp` reads the first `x-forwarded-for` entry, falls back to `x-real-ip`, else `"unknown"`.
- Config: `JOBS_RATE_LIMIT_PER_MIN` (default 30; non-positive/invalid → 30).

## Dependencies
None.

## Key Decisions
- Unlike the per-provider limiter (`lib/ratelimit/token-bucket.ts`), this NEVER awaits a refill — it returns a `retryAfter` hint so the request fails fast.
- In-memory + per-process; resets on cold start (accepted MVP trade-off, same as the state store). Default of 30/min is generous for a single-user app while throttling runaway scripts.

## Known Limitations
- Per-process buckets don't aggregate across serverless instances, so effective global limit scales with instance count.
- `x-forwarded-for` is client-spoofable upstream of a trusted proxy; `"unknown"` collapses all header-less callers into one bucket.
