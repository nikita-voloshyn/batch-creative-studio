/**
 * Job-creation idempotency store (route layer, backend — BE).
 *
 * `POST /api/jobs` accepts an `Idempotency-Key` header (a per-Generate-click
 * UUID). Within a short window the SAME key resolves to the SAME `{ jobId }`, so
 * a double-click / client retry can never mint two Jobs (product-flow §0 / §5o,
 * architecture §7.2). In-memory + per-process (MVP trade-off, resets on cold
 * start). Single-threaded JS makes the check-then-reserve below atomic with
 * respect to other in-process handlers.
 *
 * Config: `JOB_IDEMPOTENCY_WINDOW_MS` (default 60000).
 */

type Entry = { jobId: string; expiresAt: number };

const entries = new Map<string, Entry>();

function windowMs(): number {
  const raw = process.env.JOB_IDEMPOTENCY_WINDOW_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

/** Look up a still-valid jobId for `key`, pruning it if the window has elapsed. */
export function lookupIdempotentJob(key: string): string | undefined {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    entries.delete(key);
    return undefined;
  }
  return entry.jobId;
}

/** Remember `jobId` for `key` for the configured window. */
export function rememberIdempotentJob(key: string, jobId: string): void {
  entries.set(key, { jobId, expiresAt: Date.now() + windowMs() });
}

/** Test/maintenance hook: clear all entries. */
export function resetJobIdempotency(): void {
  entries.clear();
}
