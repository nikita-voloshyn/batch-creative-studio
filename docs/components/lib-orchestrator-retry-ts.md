---
component: RetryEngine
source: lib/orchestrator/retry.ts
agent: backend
updated: 2026-06-28
---

# RetryEngine

## Purpose
Owns the error-kind → action POLICY and the timed, retried attempt loop against a SINGLE provider. Providers throw a neutral `ProviderError` carrying only facts (kind, httpStatus, retryAfterMs); this module decides retry-vs-advance-vs-fail. The 3-way decision is what the failover engine reuses unchanged.

## Public Interface
- `classifyKind(kind: ProviderErrorKind): RetryDecision` — maps a neutral error kind to `"retry"` (rate_limit/server/timeout/unavailable), `"advance"` (auth/quota_exhausted), or `"fail_item"` (content_policy/invalid_input).
- `runWithRetry<T>(attempt, options: RetryOptions): Promise<RetryOutcome<T>>` — runs the attempt loop for one provider.
- `type RetryDecision` — `"retry" | "advance" | "fail_item"`.
- `type RetryOptions` — `{ providerId; attemptCap; attemptTimeoutMs; backoffBaseMs; backoffMaxMs; signal?; acquire?; onAttempt? }`.
- `type RetryOutcome<T>` — `{status:"success"; value}` | `{status:"advance"; error}` | `{status:"fail_item"; error}` | `{status:"aborted"; error}`.

## Inputs and Outputs
- `attempt(signal, attemptNumber)`: the caller-supplied provider call (+ any validation/persistence folded in); throws a `ProviderError` on failure.
- Loop: attempts numbered `0..attemptCap-1` (cap floored at 1). Before each timed attempt it awaits the optional un-timed `acquire` gate (rate-limit token) under the JOB signal only, so a long rate-limit wait does not consume the per-attempt timeout. Each attempt runs under an `AbortSignal.timeout(attemptTimeoutMs)`, combined with the job signal via `AbortSignal.any`.
- On a `retry`-class error: records a `retryable_error` attempt; if last attempt returns `advance`, else sleeps an exponential-backoff-with-full-jitter delay (capped, honoring server `retryAfterMs` in full even beyond the cap) and continues.
- On `advance`/`fail_item`: records a `fatal_error` attempt and returns that status.
- A fired job signal (when the timeout signal did NOT fire) returns `{status:"aborted"}`; an aborted backoff sleep also returns aborted.
- `onAttempt(record)` is called once per attempt with the completed `Attempt` (synchronous hook — cannot await).
- Unknown thrown values (incl. persist/validation errors) coerce to a retryable `ProviderError("server")`; abort/timeout names coerce to `ProviderError("timeout")`.

## Dependencies
- `lib/providers/errors` — `ProviderError`, `ProviderErrorKind`.
- `lib/types` — `Attempt` record shape.

## Key Decisions
- The 3-way outcome (vs. binary retry/fail) exists so the failover engine can consume it directly: retry-cap exhaustion is surfaced as `advance` (try the next provider), not as a terminal failure.
- Rate-limit `acquire` is awaited OUTSIDE the per-attempt timeout so a long token wait never burns the provider-call budget.
- Server-suggested `retryAfterMs` (e.g. 429 Retry-After) overrides the local cap — the server knows its own cool-down.
- A job-level abort is distinguished from a genuine attempt timeout by checking `signal.aborted && !timeoutSignal.aborted`, so interrupts are reported as `aborted` rather than retried.

## Known Limitations
- Provider-agnostic by design — knows nothing about the chain, the registry, or the store; the orchestrator/failover engine supplies all context.
- The final post-loop `advance` return is an unreachable defensive fallback.
