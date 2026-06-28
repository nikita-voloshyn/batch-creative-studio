/**
 * Token-bucket rate-limiter specifications (testing agent, Task 10).
 *
 * Capacity = RPM (burst ceiling), refill = RPM/60000 tokens/ms (steady state).
 * `take`/`acquire` resolve immediately while tokens remain and AWAIT the next
 * refill when empty (asserted under fake timers — no real waiting). Also covers
 * the `nearDailyQuota` soft-threshold pre-switch hook (architecture §5.4,
 * product-flow §6 / §5g).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderRateLimiter, TokenBucket } from "@/lib/ratelimit/token-bucket";

afterEach(() => {
  vi.useRealTimers();
});

describe("TokenBucket", () => {
  test("starts full at capacity (allows an immediate burst up to RPM)", () => {
    const bucket = new TokenBucket(5, 5 / 60_000);
    expect(bucket.available()).toBe(5);
  });

  test("acquires immediately while tokens remain", async () => {
    const bucket = new TokenBucket(2, 2 / 60_000);
    await bucket.take();
    await bucket.take();
    expect(bucket.available()).toBeLessThan(1);
  });

  test("awaits the next refill when empty, then resolves", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(2, 0.001); // 0.001 tokens/ms => 1 token / 1000ms
    await bucket.take();
    await bucket.take();

    let resolved = false;
    const pending = bucket.take().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false); // still waiting for the refill

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  test("refills continuously at refillPerMs up to capacity", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket(10, 0.001); // 1 token / 1000ms
    // Drain to zero.
    for (let i = 0; i < 10; i++) await bucket.take();
    expect(bucket.available()).toBeLessThan(1);

    await vi.advanceTimersByTimeAsync(3_000); // +3 tokens
    expect(bucket.available()).toBeCloseTo(3, 5);
  });

  test("rejects an acquire whose signal is already aborted", async () => {
    const bucket = new TokenBucket(1, 1 / 60_000);
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.take(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("ProviderRateLimiter — acquire", () => {
  test("acquires up to RPM immediately, then waits for a refill", async () => {
    vi.useFakeTimers();
    const limiter = new ProviderRateLimiter();
    // rpm=2 => capacity 2, refill 2/60000 per ms (~1 token / 30s).
    await limiter.acquire("gemini", 2);
    await limiter.acquire("gemini", 2);

    let third = false;
    const pending = limiter.acquire("gemini", 2).then(() => {
      third = true;
    });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); // 30s total => one token refilled
    await pending;
    expect(third).toBe(true);
  });

  test("rpm below 1 is clamped to a capacity of 1", async () => {
    const limiter = new ProviderRateLimiter();
    await expect(limiter.acquire("x", 0)).resolves.toBeUndefined();
  });
});

describe("ProviderRateLimiter — daily quota", () => {
  test("counts calls and reports nearDailyQuota at the soft threshold", () => {
    const limiter = new ProviderRateLimiter();
    const cap = 10; // soft threshold = 0.9 * 10 = 9
    for (let i = 0; i < 8; i++) limiter.recordCall("gemini");
    expect(limiter.usage("gemini")).toBe(8);
    expect(limiter.nearDailyQuota("gemini", cap)).toBe(false);

    limiter.recordCall("gemini"); // 9th call -> at threshold
    expect(limiter.nearDailyQuota("gemini", cap)).toBe(true);
  });

  test("honors a custom soft fraction", () => {
    const limiter = new ProviderRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordCall("cf");
    expect(limiter.nearDailyQuota("cf", 10, 0.5)).toBe(true); // 5 >= 5
    expect(limiter.nearDailyQuota("cf", 10, 0.6)).toBe(false); // 5 < 6
  });

  test("never near-quota when the daily cap is non-positive", () => {
    const limiter = new ProviderRateLimiter();
    limiter.recordCall("cf");
    expect(limiter.nearDailyQuota("cf", 0)).toBe(false);
  });

  test("reset clears buckets and daily counters", () => {
    const limiter = new ProviderRateLimiter();
    for (let i = 0; i < 3; i++) limiter.recordCall("gemini");
    expect(limiter.usage("gemini")).toBe(3);
    limiter.reset();
    expect(limiter.usage("gemini")).toBe(0);
  });
});
