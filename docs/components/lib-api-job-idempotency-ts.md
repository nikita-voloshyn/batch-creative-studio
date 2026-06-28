---
component: JobIdempotency
source: lib/api/job-idempotency.ts
agent: backend
updated: 2026-06-28
---

# JobIdempotency

## Purpose
Job-creation idempotency store. Within a short window, the same `Idempotency-Key` (a per-Generate-click UUID sent to `POST /api/jobs`) resolves to the same `jobId`, so a double-click or client retry never mints two Jobs.

## Public Interface
- `function lookupIdempotentJob(key: string): string | undefined` — return a still-valid `jobId` for `key`, pruning it if the window has elapsed.
- `function rememberIdempotentJob(key: string, jobId: string): void` — record `key → jobId` for the configured window.
- `function resetJobIdempotency(): void` — clear all entries (tests/maintenance).

## Inputs and Outputs
- `lookupIdempotentJob` returns `undefined` for unknown or expired keys (expired entries are deleted on access).
- `rememberIdempotentJob` stores `{ jobId, expiresAt: now + windowMs }`.
- Config: `JOB_IDEMPOTENCY_WINDOW_MS` (default 60000; non-positive/invalid → 60000).

## Dependencies
None.

## Key Decisions
- In-memory + per-process (resets on cold start) — accepted MVP trade-off.
- Single-threaded JS makes the route's check-then-reserve (lookup → create → remember) atomic with respect to other in-process handlers.

## Known Limitations
- Per-process map; the same key on two serverless instances within the window could still create two Jobs (a shared store would be needed for cross-instance guarantees).
- Lazy expiry only on lookup — stale entries linger in the map until next accessed.
