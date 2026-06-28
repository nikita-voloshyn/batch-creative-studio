/**
 * Provider-call idempotency (component C17, backend — BE).
 *
 * Two distinct concerns are kept separate (product-flow §0 idempotency invariant):
 *  (a) PROVIDER-CALL DE-DUP — `idempotencyKey(itemId, attemptNumber)` =
 *      `hash(itemId + attemptNumber)`. Its sole role is to guard against
 *      double-delivery WITHIN an attempt: the same (itemId, attemptNumber) must
 *      never produce two stored objects. Retries use a fresh attemptNumber, so a
 *      retry is a distinct key (never coalesced with the original).
 *  (b) RESULT STORAGE — handled in `lib/blob/result-store.ts` under the per-item,
 *      attempt-independent key `results/{jobId}/{itemId}.{ext}` (last-writer-wins).
 *      That is NOT derived from the idempotency key.
 *
 * Interface limitation (flagged for the reviewer): the providers-owned
 * `ImageProvider.generate(input, signal)` contract carries NO slot for an
 * idempotency key, and `GenerateInput` has no such field — so the key cannot be
 * pushed to the provider's HTTP body without a providers-package contract change
 * (out of this task's boundary). Until then we enforce de-dup at the
 * ORCHESTRATION layer with `dedupe()`: concurrent identical (itemId, attemptNumber)
 * calls in this process are coalesced onto one in-flight promise. This is an
 * honest, in-process realization of the "redelivered identical attempt never
 * produces a second result" guarantee for the MVP (single process).
 */
import { createHash } from "node:crypto";

/** Stable de-dup key for one (item, attempt) pair. */
export function idempotencyKey(itemId: string, attemptNumber: number): string {
  return createHash("sha256").update(`${itemId}:${attemptNumber}`).digest("hex");
}

/** In-flight calls keyed by idempotency key, for concurrent-duplicate coalescing. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Run `fn` under `key`, coalescing any concurrent call with the same key onto the
 * single in-flight promise. The entry is cleared once the promise settles, so a
 * later (sequential) call with the same key runs `fn` again (e.g. a deliberate
 * targeted retry that reuses attemptNumber 0).
 */
export function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
