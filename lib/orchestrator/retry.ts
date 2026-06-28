/**
 * Retry engine — owns the kind→decision POLICY (component C14, backend — BE).
 *
 * Providers throw a NEUTRAL `ProviderError` carrying only facts (`kind`,
 * `httpStatus`, `retryAfterMs`); THIS module decides retry-vs-fatal
 * (architecture §4 / §5.3, errors.ts). The decision is 3-way so the Task 9
 * failover engine can reuse it unchanged:
 *
 *   rate_limit | server | timeout | unavailable  → "retry"     (within attempt cap)
 *   auth | quota_exhausted                        → "advance"   (this provider is
 *                                                                 hopeless; try the
 *                                                                 next in the chain)
 *   content_policy | invalid_input                → "fail_item" (no provider helps;
 *                                                                 fail the item)
 *
 * `runWithRetry` runs the attempt loop against a SINGLE provider:
 *  - attempts numbered 0..attemptCap-1 (default cap 3, product-flow §0);
 *  - each timed attempt runs under `ATTEMPT_TIMEOUT_MS` via an `AbortSignal`
 *    (a timeout is a retryable error);
 *  - exponential backoff + full jitter between retries, capped, honoring a
 *    server-suggested `retryAfterMs`;
 *  - returns `success` | `advance` | `fail_item` | `aborted`.
 *
 * TASK 9 SEAM: this loop is provider-agnostic (`attempt` + `acquire` are
 * injected). The orchestrator calls it once with the primary provider today; Task
 * 9 wraps it in a chain loop — on `advance` (or a retry-cap exhaustion, also
 * surfaced as `advance`) it moves to the next provider; on `fail_item` it stops;
 * on `success` it is done. No change to this engine is required.
 */
import { ProviderError, type ProviderErrorKind } from "@/lib/providers/errors";
import type { Attempt } from "@/lib/types";

/** What the engine decides to do after a non-success attempt. */
export type RetryDecision = "retry" | "advance" | "fail_item";

/** Map a neutral provider-error `kind` to the retry/failover/fail policy. */
export function classifyKind(kind: ProviderErrorKind): RetryDecision {
  switch (kind) {
    case "rate_limit":
    case "server":
    case "timeout":
    case "unavailable":
      return "retry";
    case "auth":
    case "quota_exhausted":
      return "advance";
    case "content_policy":
    case "invalid_input":
      return "fail_item";
  }
}

export type RetryOptions = {
  /** Provider id, for error wrapping + attempt records. */
  providerId: string;
  /** Attempts per provider (`ATTEMPT_CAP`, default 3 = attempts 0..2). */
  attemptCap: number;
  /** Per-attempt timeout in ms (`ATTEMPT_TIMEOUT_MS`). */
  attemptTimeoutMs: number;
  /** Exponential-backoff base in ms (`BACKOFF_BASE_MS`). */
  backoffBaseMs: number;
  /** Exponential-backoff cap in ms (`BACKOFF_MAX_MS`). */
  backoffMaxMs: number;
  /** Job-level abort signal (graceful shutdown / sweeper). */
  signal?: AbortSignal;
  /**
   * Un-timed gate run before each timed attempt (e.g. the per-provider rate-limit
   * token acquire). Awaited under the job signal only, so a long rate-limit wait
   * does NOT consume the per-attempt provider timeout (product-flow §6 ordering).
   */
  acquire?: (signal?: AbortSignal) => Promise<void>;
  /** Called once per attempt at its end with the completed Attempt record. */
  onAttempt?: (attempt: Attempt) => void;
};

/** Outcome of the single-provider retry loop. */
export type RetryOutcome<T> =
  | { status: "success"; value: T }
  | { status: "advance"; error: ProviderError }
  | { status: "fail_item"; error: ProviderError }
  | { status: "aborted"; error: ProviderError };

/** Abortable sleep; rejects with an `AbortError` if the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted during retry backoff", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted during retry backoff", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `delay = min(cap, base*2^attempt + jitter)`, honoring a server `retryAfterMs`. */
function backoffDelayMs(
  attemptNumber: number,
  baseMs: number,
  maxMs: number,
  retryAfterMs?: number,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** attemptNumber);
  const jitter = Math.random() * baseMs; // full jitter, bounded by base
  let delay = Math.min(maxMs, exponential + jitter);
  // A server-suggested retry delay (e.g. 429 Retry-After) is honored in full,
  // even beyond the local cap — the server knows its own cool-down.
  if (typeof retryAfterMs === "number" && retryAfterMs > delay) delay = retryAfterMs;
  return delay;
}

/** Coerce any thrown value into a neutral `ProviderError`. */
function toProviderError(
  caught: unknown,
  providerId: string,
  timeoutSignal: AbortSignal,
): ProviderError {
  if (caught instanceof ProviderError) return caught;
  const isAbort =
    timeoutSignal.aborted ||
    (caught instanceof Error && (caught.name === "AbortError" || caught.name === "TimeoutError"));
  if (isAbort) {
    return new ProviderError("timeout", providerId, "Attempt timed out or was aborted.");
  }
  const message = caught instanceof Error ? caught.message : String(caught);
  // Unknown failures (incl. result-persist / validation errors) are retryable.
  return new ProviderError("server", providerId, message);
}

/**
 * Run the timed, retried attempt loop for ONE provider. `attempt(signal,
 * attemptNumber)` performs the provider call (+ any validation/persistence the
 * caller folds in) and throws a `ProviderError` on failure.
 */
export async function runWithRetry<T>(
  attempt: (signal: AbortSignal, attemptNumber: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const { providerId, attemptCap, attemptTimeoutMs, backoffBaseMs, backoffMaxMs, signal } = options;
  const cap = Math.max(1, attemptCap);

  const abortedOutcome = (): RetryOutcome<T> => ({
    status: "aborted",
    error: new ProviderError("timeout", providerId, "Job aborted (interrupted)."),
  });

  for (let attemptNumber = 0; attemptNumber < cap; attemptNumber++) {
    if (signal?.aborted) return abortedOutcome();

    // Un-timed gate (rate-limit token); only the job signal can abort it.
    try {
      await options.acquire?.(signal);
    } catch {
      return abortedOutcome();
    }
    if (signal?.aborted) return abortedOutcome();

    const startedAt = new Date().toISOString();
    const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      const value = await attempt(attemptSignal, attemptNumber);
      options.onAttempt?.({ providerId, startedAt, finishedAt: nowIso(), outcome: "success" });
      return { status: "success", value };
    } catch (caught) {
      const error = toProviderError(caught, providerId, timeoutSignal);

      // Distinguish a job-level abort (interrupted) from a real attempt timeout.
      if (signal?.aborted && !timeoutSignal.aborted) {
        options.onAttempt?.({
          providerId,
          startedAt,
          finishedAt: nowIso(),
          outcome: "retryable_error",
          errorMessage: "Job aborted (interrupted).",
        });
        return abortedOutcome();
      }

      const decision = classifyKind(error.kind);
      if (decision === "retry") {
        const isLastAttempt = attemptNumber >= cap - 1;
        options.onAttempt?.({
          providerId,
          startedAt,
          finishedAt: nowIso(),
          outcome: "retryable_error",
          errorMessage: error.message,
        });
        // Retry cap reached on this provider → advance (failover in Task 9).
        if (isLastAttempt) return { status: "advance", error };
        const delay = backoffDelayMs(
          attemptNumber,
          backoffBaseMs,
          backoffMaxMs,
          error.retryAfterMs,
        );
        try {
          await sleep(delay, signal);
        } catch {
          return abortedOutcome();
        }
        continue;
      }

      // "advance" (auth/quota) or "fail_item" (content-policy/invalid-input).
      options.onAttempt?.({
        providerId,
        startedAt,
        finishedAt: nowIso(),
        outcome: "fatal_error",
        errorMessage: error.message,
      });
      return { status: decision, error };
    }
  }

  // Unreachable: the loop returns from within. Defensive fallback = advance.
  return {
    status: "advance",
    error: new ProviderError("server", providerId, "Attempt loop exhausted."),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
