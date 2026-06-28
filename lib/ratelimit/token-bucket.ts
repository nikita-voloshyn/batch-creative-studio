/**
 * Per-provider token-bucket rate limiter (component C16, backend — BE).
 *
 * Decouples `POOL_SIZE` (worker concurrency) from each provider's RPM so a large
 * N never causes a 429 storm (architecture §5.4, product-flow §6). The worker
 * pool acquires a token from the CURRENT provider's bucket before every provider
 * call; if the bucket is empty the acquire awaits the next refill, so the pool
 * can be 5 wide yet still never exceed Gemini's ~10 RPM.
 *
 * The buckets + the daily-usage counters are PROCESS-GLOBAL — shared across all
 * concurrent jobs in the process, not per-job (product-flow §5s), so total
 * provider calls/min stay bounded regardless of how many batches run.
 *
 * Quota pre-switch HOOK (architecture §5.4): `nearDailyQuota` is exposed for the
 * Task 9 failover engine to consult before starting NEW items on a provider that
 * is nearing its daily cap. Task 5 only exposes the check; the actual start-
 * position switch is Task 9. The counter is in-memory and resets on cold start —
 * best-effort in MVP; a genuinely exhausted provider is still caught at runtime
 * by a `quota_exhausted` ProviderError → advance.
 */

/** Abortable sleep that rejects with an `AbortError` if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted while waiting for a rate-limit token", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted while waiting for a rate-limit token", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Classic token bucket: `capacity` tokens that refill continuously at
 * `refillPerMs`. `capacity` = the per-minute ceiling (allows a burst up to RPM),
 * `refillPerMs` = RPM / 60000 (steady-state rate).
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Take one token, awaiting a refill if none is currently available. */
  async take(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException("Aborted while waiting for a rate-limit token", "AbortError");
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil(deficit / this.refillPerMs));
      await sleep(waitMs, signal);
    }
  }

  /** Current (refilled) token count — exposed for tests / introspection. */
  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** Today's date key (UTC) used to roll the best-effort daily counter. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Manages one bucket + one daily counter per providerId, process-global. */
export class ProviderRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly daily = new Map<string, { day: string; count: number }>();

  private bucketFor(providerId: string, rpm: number): TokenBucket {
    let bucket = this.buckets.get(providerId);
    if (!bucket) {
      const capacity = Math.max(1, rpm);
      bucket = new TokenBucket(capacity, capacity / 60_000);
      this.buckets.set(providerId, bucket);
    }
    return bucket;
  }

  /** Acquire one token from `providerId`'s bucket (RPM from providers config). */
  acquire(providerId: string, rpm: number, signal?: AbortSignal): Promise<void> {
    return this.bucketFor(providerId, rpm).take(signal);
  }

  /** Record one provider call against the best-effort daily counter. */
  recordCall(providerId: string): void {
    const day = todayKey();
    const entry = this.daily.get(providerId);
    if (!entry || entry.day !== day) {
      this.daily.set(providerId, { day, count: 1 });
      return;
    }
    entry.count += 1;
  }

  /** Calls recorded for `providerId` today (resets across UTC day / cold start). */
  usage(providerId: string): number {
    const entry = this.daily.get(providerId);
    return entry && entry.day === todayKey() ? entry.count : 0;
  }

  /**
   * Quota pre-switch hook (architecture §5.4). True once a provider has used at
   * least `softFraction` of its `dailyCap` — Task 9 consults this to start NEW
   * items on the next provider in the chain. Best-effort in MVP.
   */
  nearDailyQuota(providerId: string, dailyCap: number, softFraction = 0.9): boolean {
    if (dailyCap <= 0) return false;
    return this.usage(providerId) >= dailyCap * softFraction;
  }

  /** Drop all buckets + counters (used by tests for isolation). */
  reset(): void {
    this.buckets.clear();
    this.daily.clear();
  }
}

/** Process-wide limiter shared across all jobs (product-flow §5s). */
export const rateLimiter = new ProviderRateLimiter();
