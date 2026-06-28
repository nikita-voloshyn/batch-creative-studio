---
component: ProviderRateLimiter
source: lib/ratelimit/token-bucket.ts
agent: backend
updated: 2026-06-28
---

# ProviderRateLimiter

## Purpose
Per-provider token-bucket rate limiter (component C16) that decouples worker-pool concurrency (`POOL_SIZE`) from each provider's RPM, so a large batch never causes a 429 storm. Also tracks best-effort daily usage for the quota pre-switch hook.

## Public Interface
- `class TokenBucket` — `constructor(capacity, refillPerMs)`; `take(signal?): Promise<void>` (take one token, awaiting a refill if empty); `available(): number` (current refilled count, for tests).
- `class ProviderRateLimiter`:
  - `acquire(providerId, rpm, signal?): Promise<void>` — acquire one token from the provider's bucket (creates the bucket on first use).
  - `recordCall(providerId): void` — increment the best-effort daily counter.
  - `usage(providerId): number` — calls recorded today (UTC day key).
  - `nearDailyQuota(providerId, dailyCap, softFraction = 0.9): boolean` — true once usage ≥ `dailyCap * softFraction`.
  - `reset(): void` — drop all buckets + counters (tests).
- `const rateLimiter: ProviderRateLimiter` — process-wide shared limiter.

## Inputs and Outputs
- `acquire` blocks (awaits refill) until a token is free; throws `AbortError` (`DOMException`) if the signal fires while waiting.
- Bucket capacity = `max(1, rpm)`; `refillPerMs = capacity / 60000` (continuous refill). Capacity allows a burst up to RPM.
- Daily counter is keyed by UTC date (`todayKey`) and resets across day boundary / cold start.
- `nearDailyQuota` returns `false` when `dailyCap <= 0`.

## Dependencies
None (pure in-process timers + maps).

## Key Decisions
- Buckets and daily counters are PROCESS-GLOBAL (shared across all concurrent jobs), so total provider calls/min stay bounded regardless of how many batches run.
- The worker pool acquires a token from the CURRENT provider's bucket before every provider call, so a 5-wide pool still cannot exceed e.g. Gemini's ~10 RPM.
- `nearDailyQuota` is exposed for the failover engine to start NEW items on the next provider before a daily cap is hit; this module only exposes the check, not the switch.
- `sleep` is abortable and cleans up its timer + listener on abort.

## Known Limitations
- The daily counter is in-memory and resets on cold start — best-effort only; a genuinely exhausted provider is still caught at runtime via a `quota_exhausted` ProviderError → advance.
- Buckets are per-process, so true global RPM enforcement breaks across serverless instances (MVP trade-off).
