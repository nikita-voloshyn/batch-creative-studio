/**
 * Provider error taxonomy (owner: providers — PV).
 *
 * NEUTRAL FACTS ONLY (architecture §4). Adapters do not decide whether an error
 * is retryable or fatal — they throw a `ProviderError` carrying only *facts*
 * (what kind of failure, which provider, the HTTP status, an optional
 * server-suggested retry delay). The `kind -> retry/advance/fatal` POLICY lives
 * solely in the backend retry engine (`lib/retry`, architecture §5.3); putting a
 * `retryable` decision here would leak that policy across the boundary, so it is
 * deliberately absent. The retry engine classifies on `ProviderError.kind`:
 *
 *   rate_limit | server | timeout | unavailable  -> retry (within attempt cap)
 *   auth | quota_exhausted                        -> fatal: advance to next provider
 *   content_policy | invalid_input                -> fatal: fail this item (no provider helps)
 */
export type ProviderErrorKind =
  | "rate_limit" // HTTP 429 (per-minute rate limit)
  | "server" // HTTP 5xx / unknown transient
  | "timeout" // network timeout / aborted
  | "unavailable" // provider "temporarily unavailable" / overloaded
  | "auth" // HTTP 401 / 403
  | "content_policy" // moderation / safety reject
  | "invalid_input" // HTTP 4xx (non-429) bad request
  | "quota_exhausted"; // provider-reported daily cap reached

/**
 * Typed error thrown by every adapter. Carries facts the retry engine needs to
 * classify and (optionally) honor a server-suggested backoff — never a decision.
 */
export class ProviderError extends Error {
  constructor(
    /** A fact about what happened, not a decision about what to do. */
    readonly kind: ProviderErrorKind,
    readonly providerId: string,
    message: string,
    /** Upstream HTTP status, when the failure came from an HTTP response. */
    readonly httpStatus?: number,
    /** Server-suggested retry delay (ms); surfaced for the retry engine to honor. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Base, message-agnostic mapping from an HTTP status to a neutral
 * `ProviderErrorKind`. Shared across adapters; an adapter may refine ambiguous
 * cases (e.g. a 429 that is actually a daily-quota exhaustion, or a 400 that is
 * a content-policy block) by inspecting the response body before falling back
 * to this default.
 */
export function kindFromHttpStatus(status: number): ProviderErrorKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_input";
  return "server";
}

/* ──────────────────────────────────────────────────────────────────────────
 * Shared, provider-agnostic mapping helpers
 *
 * Reused by the fetch-based adapters (Cloudflare, Replicate). The Gemini adapter
 * keeps its own copies (its errors flow through the `@google/genai` SDK's
 * `ApiError`); these are for adapters that drive the raw HTTP API themselves.
 * ────────────────────────────────────────────────────────────────────────── */

/** Best-effort string extraction from any thrown value. */
export function errorMessageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}

/** True when a thrown value is an abort/timeout from an `AbortSignal`. */
export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

/**
 * Parse a server-suggested retry delay from an HTTP `Retry-After` header value.
 * Supports both forms: delta-seconds (`"12"`) and an HTTP-date. Returns the
 * delay in ms, or `undefined` when absent/unparseable.
 */
export function retryAfterMsFromHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}
