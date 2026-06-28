---
component: Idempotency
source: lib/orchestrator/idempotency.ts
agent: backend
updated: 2026-06-28
---

# Idempotency

## Purpose
Provider-call de-duplication: guarantees the same `(itemId, attemptNumber)` never produces two stored objects by coalescing concurrent identical in-process calls onto a single in-flight promise. This is the orchestration-layer realization of the "redelivered identical attempt never produces a second result" invariant for the single-process MVP.

## Public Interface
- `idempotencyKey(itemId: string, attemptNumber: number): string` — stable SHA-256 hex of `itemId:attemptNumber`.
- `dedupe<T>(key: string, fn: () => Promise<T>): Promise<T>` — runs `fn` under `key`, coalescing any concurrent call with the same key onto the one in-flight promise; clears the entry once it settles.

## Inputs and Outputs
- `dedupe`: if an in-flight promise exists for `key`, returns it without invoking `fn`; otherwise invokes `fn`, registers the promise, and removes it on settle (success OR failure).
- A later SEQUENTIAL call with the same key runs `fn` again (e.g. a deliberate targeted retry that reuses attemptNumber 0).

## Dependencies
- `node:crypto` — `createHash` for the SHA-256 key.

## Key Decisions
- Two concerns are kept separate per the product-flow idempotency invariant: (a) provider-call de-dup lives here keyed by `(itemId, attemptNumber)`; (b) result storage lives in `lib/blob/result-store.ts` under the attempt-independent per-item key `results/{jobId}/{itemId}.{ext}` (last-writer-wins), NOT derived from this key.
- Retries use a fresh `attemptNumber`, so each retry is a distinct key and is never coalesced with the original attempt.
- The entry is cleared on settle so the map cannot leak and so sequential same-key calls re-run.

## Known Limitations
- In-process only (single Map in one process): provides no cross-instance idempotency. A multi-instance deployment would need the key pushed into the provider HTTP body.
- The `ImageProvider.generate(input, signal)` contract has no idempotency-key slot and `GenerateInput` has no such field, so the key cannot reach the provider without a providers-package contract change — out of this component's boundary.
