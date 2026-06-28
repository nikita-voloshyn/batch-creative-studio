---
component: MemoryStateStore
source: lib/state/store.ts
agent: backend
updated: 2026-06-28
---

# MemoryStateStore

## Purpose
The in-memory, single-writer store of authoritative Job/Item/Attempt state (component C20). Every mutation to a Job/Item/Attempt flows through this module so the "mutations only via the store" invariant holds and the impl is later swappable for Postgres/Redis.

## Public Interface
- `interface StateStore` — synchronous contract: `createJob(job)`, `getJob(jobId)`, `getItem(jobId, itemId)`, `snapshot(jobId)`, `setJobStatus`, `setItemStatus`, `appendAttempt`, `setItemResult`, `setItemError`, `casItemStatus(jobId, itemId, from, to) → boolean`, `deleteJob`.
- `type Awaitable<T> = T | Promise<T>` — value returned sync or as a Promise.
- `interface AsyncStateStore` — same surface as `StateStore` but every method returns `Awaitable<T>`; a sync `StateStore` is structurally assignable to it, as is an async Redis impl.
- `const stateStore: StateStore` — process-wide MVP singleton.
- `function createMemoryStateStore(): StateStore` — factory for isolated instances (tests).
- `class MemoryStateStore implements StateStore` (not exported directly; reached via the singleton/factory).

## Inputs and Outputs
- `getJob` / `getItem` return the LIVE object (fast internal reads); callers MUST treat them read-only.
- `snapshot` returns a `structuredClone` deep copy — safe to serialize and hand to a Route Handler.
- `setItemResult` sets the result, clears any prior `error`, flips status to `succeeded`.
- `setItemError` sets the error, flips status to `failed`.
- `casItemStatus` reads-checks-writes: returns `true` only for the caller that performed `from → to`; `false` if the item is missing or no longer in `from`.
- All mutators no-op silently when the job/item is unknown.

## Dependencies
- `lib/types.ts` — `Attempt`, `Item`, `ItemStatus`, `Job`, `JobStatus`.

## Key Decisions
- Backed by a per-process `Map<jobId, Job>`; does NOT survive cold start / scale-down / process recycle (accepted MVP trade-off).
- `casItemStatus` relies on single-threaded JS: the read-check-write is atomic with respect to other handlers in the same process, de-duping concurrent retry double-clicks.
- `AsyncStateStore` exists so the sync MVP store (and its 106 pinned tests) stay untouched while production can supply an async Redis store behind the same type.

## Known Limitations
- Single-process only; multi-instance serverless needs `RedisStateStore` (see `lib/state/redis-store.ts`).
- No persistence; Postgres impl (`pgStore.ts`) is deferred (architecture §8.2).
