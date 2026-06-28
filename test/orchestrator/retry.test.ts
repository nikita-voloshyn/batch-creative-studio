/**
 * Retry engine specifications (testing agent, Task 10).
 *
 * Covers the kind→decision POLICY (`classifyKind`) and the single-provider
 * attempt loop (`runWithRetry`): capped exponential backoff + full jitter, a
 * server-suggested `retryAfterMs`, cap-exhaustion surfacing as `advance`,
 * immediate `advance` for auth/quota and `fail_item` for content-policy/invalid-
 * input, and `AbortSignal` handling. Backoff timing is asserted under FAKE TIMERS
 * (no real waiting): `Math.random` is pinned so jitter is deterministic and
 * attempt invocation deltas are measured on the faked `Date` clock
 * (product-flow §5a / §0; decisions.md 2026-06-26 attempt-cap).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { classifyKind, runWithRetry } from "@/lib/orchestrator/retry";
import { ProviderError, type ProviderErrorKind } from "@/lib/providers/errors";
import type { Attempt } from "@/lib/types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BASE_OPTS = {
  providerId: "gemini",
  attemptCap: 3,
  attemptTimeoutMs: 60_000,
  backoffBaseMs: 500,
  backoffMaxMs: 8_000,
} as const;

/** An `attempt` fn that records the faked-clock time of each call. */
function recordingAttempt(behavior: (n: number) => Promise<unknown>) {
  const times: number[] = [];
  const fn = vi.fn(async (_signal: AbortSignal, n: number) => {
    times.push(Date.now());
    return behavior(n);
  });
  return { fn, times };
}

describe("classifyKind", () => {
  test("maps retryable kinds to retry", () => {
    for (const kind of ["rate_limit", "server", "timeout", "unavailable"] as ProviderErrorKind[]) {
      expect(classifyKind(kind)).toBe("retry");
    }
  });

  test("maps provider-hopeless kinds (auth, quota_exhausted) to advance", () => {
    expect(classifyKind("auth")).toBe("advance");
    expect(classifyKind("quota_exhausted")).toBe("advance");
  });

  test("maps no-provider-helps kinds (content_policy, invalid_input) to fail_item", () => {
    expect(classifyKind("content_policy")).toBe("fail_item");
    expect(classifyKind("invalid_input")).toBe("fail_item");
  });
});

describe("runWithRetry — retryable backoff", () => {
  test("retries rate_limit up to the attempt cap then surfaces advance", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0); // jitter = 0
    const { fn, times } = recordingAttempt(async () => {
      throw new ProviderError("rate_limit", "gemini", "429");
    });

    const promise = runWithRetry(fn, { ...BASE_OPTS, attemptCap: 4 });
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await promise;

    expect(fn).toHaveBeenCalledTimes(4); // attempts 0..3
    expect(outcome.status).toBe("advance");
    // Capped exponential delays base*2^n: 500, 1000, 2000 (no sleep after the last).
    expect(times[1] - times[0]).toBe(500);
    expect(times[2] - times[1]).toBe(1_000);
    expect(times[3] - times[2]).toBe(2_000);
  });

  test("caps the exponential backoff at backoffMaxMs", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fn, times } = recordingAttempt(async () => {
      throw new ProviderError("server", "gemini", "503");
    });

    const promise = runWithRetry(fn, {
      ...BASE_OPTS,
      attemptCap: 4,
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_500,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(times[1] - times[0]).toBe(1_000); // min(1500, 1000*2^0)
    expect(times[2] - times[1]).toBe(1_500); // min(1500, 1000*2^1)
    expect(times[3] - times[2]).toBe(1_500); // min(1500, 1000*2^2) -> capped
  });

  test("adds full jitter bounded by base to the delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0.5 * base
    const { fn, times } = recordingAttempt(async () => {
      throw new ProviderError("unavailable", "gemini", "overloaded");
    });

    const promise = runWithRetry(fn, {
      ...BASE_OPTS,
      attemptCap: 2,
      backoffBaseMs: 1_000,
      backoffMaxMs: 100_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(times[1] - times[0]).toBe(1_500); // 1000*2^0 + 0.5*1000
  });

  test("honors a server-suggested retryAfterMs beyond the local backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fn, times } = recordingAttempt(async () => {
      throw new ProviderError("rate_limit", "gemini", "429", 429, 5_000);
    });

    const promise = runWithRetry(fn, { ...BASE_OPTS, attemptCap: 2, backoffBaseMs: 500 });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    // Local delay would be 500ms; the 5s server Retry-After wins.
    expect(times[1] - times[0]).toBe(5_000);
  });

  test("retries then succeeds (429 twice then succeed)", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw new ProviderError("rate_limit", "gemini", "429");
      return "image-ok";
    });

    const promise = runWithRetry(fn, BASE_OPTS);
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.value).toBe("image-ok");
  });

  test("coerces an unknown thrown error to a retryable server error", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi.fn(async () => {
      throw new Error("kaboom (not a ProviderError)");
    });

    const promise = runWithRetry(fn, { ...BASE_OPTS, attemptCap: 2 });
    await vi.advanceTimersByTimeAsync(60_000);
    const outcome = await promise;

    expect(fn).toHaveBeenCalledTimes(2); // retried -> server is retryable
    expect(outcome.status).toBe("advance");
  });
});

describe("runWithRetry — immediate (non-retry) decisions", () => {
  test("treats auth as an immediate advance (no retries, no backoff)", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("auth", "gemini", "401");
    });
    const outcome = await runWithRetry(fn, BASE_OPTS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("advance");
  });

  test("treats quota_exhausted as an immediate advance", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("quota_exhausted", "gemini", "daily cap");
    });
    const outcome = await runWithRetry(fn, BASE_OPTS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("advance");
  });

  test("treats content_policy as an immediate fail_item", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("content_policy", "gemini", "blocked");
    });
    const outcome = await runWithRetry(fn, BASE_OPTS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("fail_item");
    if (outcome.status === "fail_item") expect(outcome.error.kind).toBe("content_policy");
  });

  test("treats invalid_input as an immediate fail_item", async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError("invalid_input", "gemini", "bad request");
    });
    const outcome = await runWithRetry(fn, BASE_OPTS);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("fail_item");
  });
});

describe("runWithRetry — abort handling", () => {
  test("returns aborted without calling the provider when pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "never");
    const outcome = await runWithRetry(fn, { ...BASE_OPTS, signal: controller.signal });
    expect(fn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("aborted");
  });

  test("stops with aborted when the job signal fires during backoff", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new ProviderError("server", "gemini", "503");
    });

    const promise = runWithRetry(fn, { ...BASE_OPTS, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0); // run attempt 0, enter backoff sleep
    controller.abort();
    const outcome = await promise;

    expect(fn).toHaveBeenCalledTimes(1); // never re-entered after abort
    expect(outcome.status).toBe("aborted");
  });
});

describe("runWithRetry — attempt records", () => {
  test("emits a success record on the winning attempt", async () => {
    const records: Attempt[] = [];
    const fn = vi.fn(async () => "ok");
    await runWithRetry(fn, { ...BASE_OPTS, onAttempt: (a) => records.push(a) });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("success");
    expect(records[0].providerId).toBe("gemini");
  });

  test("records retryable_error then fatal/terminal outcomes across attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const records: Attempt[] = [];
    const fn = vi.fn(async () => {
      throw new ProviderError("rate_limit", "gemini", "429");
    });

    const promise = runWithRetry(fn, {
      ...BASE_OPTS,
      attemptCap: 2,
      onAttempt: (a) => records.push(a),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await promise;

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.outcome === "retryable_error")).toBe(true);
  });

  test("records a fatal_error for an immediate fail_item kind", async () => {
    const records: Attempt[] = [];
    const fn = vi.fn(async () => {
      throw new ProviderError("content_policy", "gemini", "blocked");
    });
    await runWithRetry(fn, { ...BASE_OPTS, onAttempt: (a) => records.push(a) });
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("fatal_error");
  });
});

describe("runWithRetry — acquire gate", () => {
  test("awaits the injected acquire gate before each attempt", async () => {
    const acquire = vi.fn(async () => {});
    const fn = vi.fn(async () => "ok");
    await runWithRetry(fn, { ...BASE_OPTS, acquire });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("returns aborted when the acquire gate throws (rate-limit wait aborted)", async () => {
    const acquire = vi.fn(async () => {
      throw new DOMException("aborted token wait", "AbortError");
    });
    const fn = vi.fn(async () => "ok");
    const outcome = await runWithRetry(fn, { ...BASE_OPTS, acquire });
    expect(fn).not.toHaveBeenCalled();
    expect(outcome.status).toBe("aborted");
  });
});
