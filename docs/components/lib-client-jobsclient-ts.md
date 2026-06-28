---
component: jobsClient
source: lib/client/jobsClient.ts
agent: frontend
updated: 2026-06-28
---

# jobsClient (Jobs REST client)

## Purpose
Typed HTTP wrappers over the three non-stream job endpoints. Keeps the client purely over-the-wire (never imports server modules) and surfaces the HTTP status so callers can distinguish 404 ("gone") from transient failures.

## Public Interface
- `class JobApiError extends Error` — carries `status: number` (404 ⇒ gone; 0 ⇒ network/unreachable).
- `createJob(body, idempotencyKey, signal?) → Promise<{ jobId }>` — `POST /api/jobs` with `Idempotency-Key`; throws `JobApiError` on 4xx/5xx or network failure.
- `getSnapshot(jobId, signal?) → Promise<Job>` — `GET /api/jobs/:id`; throws `JobApiError(404)` on gone, other non-ok statuses otherwise.
- `retryItem(jobId, itemId, signal?) → Promise<void>` — `POST /api/jobs/:id/items/:itemId/retry`; resolves on `200 { ok: true }`, throws `JobApiError(404)` for unknown job/item.

## Inputs and Outputs
- `createJob`: sends JSON body + `content-type` + `Idempotency-Key` headers; network error → `JobApiError(0, ...)`; non-ok → `JobApiError(status, serverError||fallback)`; returns `{ jobId }`.
- `getSnapshot`: returns a full `Job`; 404 → friendly "no longer available" error.
- `retryItem`: idempotent on the server (failed item re-driven, other statuses no-op, both `200`); only error path is 404.
- `readError` (internal): best-effort extraction of the server's `{ error }` string, else a status-based fallback.

## Dependencies
- `@/lib/types` — `Job`.
- `store` — `CreateJobRequest` (the FE-owned request contract; type-only import).

## Key Decisions
- One UUID per Generate click as `Idempotency-Key` lets the server collapse duplicate submits onto the same `jobId`.
- Errors always carry the HTTP status so the SSE client / store can branch on 404 vs transient.
- Network failures map to `status: 0` to distinguish "unreachable" from HTTP responses.

## Known Limitations
- No retry/backoff here — retry policy lives in the SSE client and store.
- Response shapes are cast (`as`), trusting the server contract; no runtime schema validation.
