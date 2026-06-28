---
component: ProviderError
source: lib/providers/errors.ts
agent: providers
updated: 2026-06-28
---

# ProviderError

## Purpose
The provider error taxonomy. Adapters throw a `ProviderError` carrying only neutral facts (kind, provider, HTTP status, optional retry-after); the `kind -> retry/advance/fatal` policy lives solely in the backend retry engine. Also provides shared HTTP/abort mapping helpers reused by the fetch-based adapters.

## Public Interface
- `type ProviderErrorKind` — `"rate_limit" | "server" | "timeout" | "unavailable" | "auth" | "content_policy" | "invalid_input" | "quota_exhausted"`.
- `class ProviderError extends Error` — `constructor(kind, providerId, message, httpStatus?, retryAfterMs?)`; fields are read-only facts, `name = "ProviderError"`.
- `kindFromHttpStatus(status: number): ProviderErrorKind` — base, message-agnostic status→kind mapping.
- `errorMessageOf(cause: unknown): string` — best-effort message extraction from any thrown value.
- `isAbortError(cause: unknown): boolean` — true for `AbortError` / `TimeoutError`.
- `retryAfterMsFromHeader(value): number | undefined` — parse a `Retry-After` header (delta-seconds or HTTP-date) into ms.

## Inputs and Outputs
- `kindFromHttpStatus`: 429→rate_limit; 401/403→auth; 408/504→timeout; 503→unavailable; ≥500→server; ≥400→invalid_input; else server.
- `retryAfterMsFromHeader`: numeric seconds → `round(seconds*1000)`; HTTP-date → positive delta to now (clamped ≥0); absent/unparseable → `undefined`.
- The retry engine reads `kind` to classify: rate_limit/server/timeout/unavailable → retry within attempt cap; auth/quota_exhausted → fatal, advance to next provider; content_policy/invalid_input → fatal, fail this item.

## Dependencies
- None (standalone; depended on by every adapter and by the backend retry engine).

## Key Decisions
- No `retryable` boolean: that would leak retry policy across the provider→engine boundary, so it is deliberately absent — adapters report facts, the engine decides.
- Shared helpers (`errorMessageOf`, `isAbortError`, `retryAfterMsFromHeader`) target the raw-HTTP adapters (Cloudflare, Replicate, Pollinations, HuggingFace). Gemini keeps private copies because its errors flow through the `@google/genai` `ApiError`.

## Known Limitations
- `kindFromHttpStatus` is a coarse default; adapters refine ambiguous cases (e.g. a 429 that is actually daily-quota exhaustion, a 400 that is a content-policy block) by inspecting the response body before falling back to it.
