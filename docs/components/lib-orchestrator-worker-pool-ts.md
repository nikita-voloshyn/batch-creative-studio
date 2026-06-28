---
component: WorkerPool
source: lib/orchestrator/worker-pool.ts
agent: backend
updated: 2026-06-28
---

# WorkerPool

## Purpose
Generic bounded-concurrency pool that drains a queue of items with at most `concurrency` running at once. A slot frees the instant a worker resolves and immediately pulls the next item, so one slow or failing item never blocks its siblings. Side-effect-free and provider-agnostic — the orchestrator supplies the per-item `worker`.

## Public Interface
- `runPool<T>(items: readonly T[], concurrency: number, worker: (item, index) => Promise<void>, options?: WorkerPoolOptions): Promise<void>` — runs `worker` over all items with bounded concurrency. Never rejects.
- `type WorkerPoolOptions` — `{ signal?: AbortSignal; onUnexpectedError?(item, error): void }`.

## Inputs and Outputs
- Returns immediately on an empty list. Effective width = `max(1, min(concurrency, total))`.
- Spawns `width` runner loops sharing a monotonically incremented `nextIndex`; each pulls the next index until exhausted.
- On `signal.aborted`, runners stop pulling NEW items (in-flight items run to completion). Resolves when every item is processed or no further items start after an abort.
- Worker rejections are caught and surfaced via `onUnexpectedError(item, error)` — they never abort the drain or reject the returned promise.

## Dependencies
- None (pure utility; no imports).

## Key Decisions
- Cooperative index-pull (vs. fixed chunking) gives true work-stealing: a freed slot immediately grabs the next item, so a slow item cannot stall its siblings.
- Catches worker throws as a safety net even though the orchestrator's worker is contracted to terminalize its own failures — a stray rejection must never starve remaining items.
- Abort stops only NEW pulls; in-flight items complete so they can terminalize cleanly.

## Known Limitations
- Fixed width for the run; no dynamic resizing. Sufficient for the MVP fixed pool (POOL_SIZE≈5, N≤20).
- No per-item timeout or cancellation of in-flight work beyond what the worker itself honors via the signal.
