---
component: StateStoreSelector
source: lib/state/index.ts
agent: backend
updated: 2026-06-28
---

# StateStoreSelector

## Purpose
The single seam route handlers and the orchestrator use to obtain the active state store, choosing the shared Redis store in multi-instance prod and the in-memory store for local dev / tests.

## Public Interface
- `function getStateStore(): AsyncStateStore` — returns the shared `RedisStateStore` (lazy singleton) when `isRedisConfigured()`, otherwise the process-local in-memory `stateStore`.

## Inputs and Outputs
- Reads: `isRedisConfigured()` (an env check) per call.
- Returns: an `AsyncStateStore`; both impls satisfy it, so callers `await` every method either way.
- Cheap per request — an env check plus a cached reference; the `RedisStateStore` is constructed at most once per instance.

## Dependencies
- `lib/state/redis-store.ts` — `isRedisConfigured`, `RedisStateStore`.
- `lib/state/store.ts` — `AsyncStateStore` type, `stateStore` singleton.

## Key Decisions
- The in-memory `stateStore` / `MemoryStateStore` / `createMemoryStateStore` exports are intentionally left untouched because the test suite depends on them directly.
- Selection is per-call (not module-load) so env presence is evaluated at request time.

## Known Limitations
- Decision is purely env-driven; no runtime health-check or fallback if Redis is configured but unreachable.
