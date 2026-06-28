---
component: RedisStateStore
source: lib/state/redis-store.ts
agent: backend
updated: 2026-06-28
---

# RedisStateStore

## Purpose
Redis-backed shared state store (component C20') so every serverless instance reads/writes the same authoritative Job/Item/Attempt state. Solves the multi-instance "job not found" problem where `POST /api/jobs` and the SSE stream land on different instances.

## Public Interface
- `function isRedisConfigured(): boolean` — true when Upstash (`UPSTASH_REDIS_REST_URL`/`_TOKEN`) or Vercel KV (`KV_REST_API_URL`/`_TOKEN`) env is present.
- `function getRedisClient(): Redis` — lazy process-wide Upstash REST client (`Redis.fromEnv()`, no network I/O at construction).
- `class RedisStateStore implements AsyncStateStore` — `constructor(redis = getRedisClient())`; implements `createJob`, `getJob`, `getItem`, `snapshot`, `setJobStatus`, `setItemStatus`, `appendAttempt`, `setItemResult`, `setItemError`, `casItemStatus`, `deleteJob` (all async).

## Inputs and Outputs
- Storage model: each Job is a Redis HASH at `bcs:job:{jobId}` with a 1-hour TTL refreshed on every write. Fields: `meta` (Job without items), `order` (JSON array of item ids), `item:{id}` (full Item JSON incl. attempts).
- `createJob` pipelines `hset` + `expire`; returns the input Job.
- `getJob` reads `hgetall`, returns `undefined` when missing or `meta` absent; reassembles items in `order`. `snapshot` delegates to `getJob` (each read is a freshly-parsed deep clone).
- Per-item mutators (`setItemStatus`/`appendAttempt`/`setItemResult`/`setItemError`) use a private `mutateItem`: hget one item field → mutate → hset back + refresh TTL.
- `setJobStatus` reads/writes only the `meta` field.
- `casItemStatus` runs a Lua script via `redis.eval`; returns `true` when result is 1.
- `deleteJob` deletes the hash key.

## Dependencies
- `@upstash/redis` — `Redis` REST client.
- `lib/state/store.ts` — `AsyncStateStore` contract.
- `lib/types.ts` — domain entities.

## Key Decisions
- `casItemStatus` uses a server-side Lua script (`CAS_ITEM_STATUS_LUA`) doing a literal find/replace on the first `"status":"{from}"` token of the item's own JSON, then `EXPIRE` — so a concurrent double-click cannot both win `failed → queued`. The item's `status` is the first such token (it precedes any nested `error`), making the first match authoritative.
- Per-item writes are different hash fields → no lost updates across the (single) runner; the only genuinely concurrent mutation is the CAS, hence the Lua atomicity.
- Job hashes are ephemeral (1h TTL) like the in-memory store — not durable persistence.
- Construction is lazy/env-gated so importing the module never performs network I/O.

## Known Limitations
- TTL-based; jobs expire after 1 hour of no writes.
- CAS correctness depends on the JSON serialization placing `status` before `error` (true for current `Item` shape).
- Not durable storage; full persistence (Postgres) still deferred.
