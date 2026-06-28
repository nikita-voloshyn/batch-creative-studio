/**
 * State-store selection (backend — BE).
 *
 * `getStateStore()` is the single seam the route handlers and the orchestrator use
 * to reach authoritative Job/Item/Attempt state. It returns the shared Redis store
 * when the Upstash/Vercel-KV REST env is configured (multi-instance prod), and the
 * process-local in-memory store otherwise (local dev + the test suite). Both
 * satisfy `AsyncStateStore`, so callers `await` every method either way.
 *
 * The in-memory `stateStore`/`MemoryStateStore`/`createMemoryStateStore` exports
 * from `./store` are intentionally left as-is (the tests depend on them).
 */
import { isRedisConfigured, RedisStateStore } from "@/lib/state/redis-store";
import { type AsyncStateStore, stateStore } from "@/lib/state/store";

/** Lazy singleton Redis store (constructed only when the REST env is present). */
let redisStore: RedisStateStore | undefined;

/**
 * The active shared state store for this instance. Redis when configured, else the
 * in-memory singleton. Cheap to call per request (an env check + a cached ref).
 */
export function getStateStore(): AsyncStateStore {
  if (isRedisConfigured()) {
    redisStore ??= new RedisStateStore();
    return redisStore;
  }
  return stateStore;
}
