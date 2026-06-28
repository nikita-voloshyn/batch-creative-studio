/**
 * Redis-backed shared state store (component C20', backend — BE).
 *
 * The MVP `MemoryStateStore` lives in one process; on Vercel's multi-instance
 * serverless that breaks the flow — `POST /api/jobs` (instance A) writes the job
 * while the SSE stream / snapshot (instance B) reads it, so the job is "not found".
 * This impl moves authoritative Job/Item/Attempt state into Upstash Redis (REST,
 * serverless/edge friendly) so EVERY instance reads and writes the same state.
 *
 * It is env-gated: `getStateStore()` (lib/state/index.ts) returns this only when
 * the Upstash/KV env is present, otherwise the in-memory store. Construction is
 * lazy (`Redis.fromEnv()` reads `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN`
 * OR `KV_REST_API_URL`+`KV_REST_API_TOKEN`); no network call happens at import.
 *
 * ── Storage model ──────────────────────────────────────────────────────────
 * Each Job is a Redis HASH at `bcs:job:{jobId}` (1-hour TTL, refreshed on write —
 * these are ephemeral, like the in-memory store):
 *   • field `meta`        → the Job envelope WITHOUT items (id/status/seed/params/
 *                           referenceImageUrls/createdAt), as JSON.
 *   • field `order`       → JSON array of item ids (preserves item order).
 *   • field `item:{id}`   → the full `Item` JSON (incl. its attempts).
 * The Upstash SDK serializes objects with `JSON.stringify` on write and
 * `JSON.parse`s on read, so a hash field round-trips to the same JSON text — which
 * is exactly what the CAS Lua script (below) operates on at the byte level.
 *
 * ── Write semantics ────────────────────────────────────────────────────────
 * Every Job is run-once by a SINGLE instance (the SSE stream that won the start
 * claim hosts `runJob`; a targeted retry re-drives one item), so per-item writes
 * never contend across instances — they are plain get→modify→set on the small
 * per-item field (different items are different fields → no lost updates). The one
 * genuinely concurrent mutation is the retry route's `casItemStatus` (a different
 * instance may double-fire it on a double-click); that is made ATOMIC with a Lua
 * script (`redis.eval`) so exactly one caller wins the `failed → queued` flip.
 */
import { Redis } from "@upstash/redis";
// The store contract lives in store.ts; the domain entities in types.ts.
import type { AsyncStateStore } from "@/lib/state/store";
import type { Attempt, Item, ItemStatus, Job, JobStatus } from "@/lib/types";

/** 1-hour TTL on a job hash — ephemeral, refreshed on every write. */
const JOB_TTL_SECONDS = 60 * 60;

/** Redis key for a job's hash. */
function jobKey(jobId: string): string {
  return `bcs:job:${jobId}`;
}

/** Hash field holding one item's JSON. */
function itemField(itemId: string): string {
  return `item:${itemId}`;
}

/** The Job envelope persisted under the `meta` field (everything but `items`). */
type JobMeta = Omit<Job, "items">;

/**
 * Atomic compare-and-set on ONE item's status, run server-side so a concurrent
 * double-click cannot both win (architecture §8.2 / §11). It reads the single
 * `item:{id}` hash field and, only if it currently contains `"status":"{from}"`,
 * rewrites that exact token to `"status":"{to}"` and refreshes the TTL — a literal
 * (non-pattern) find/replace on the item's own JSON. The item's `status` is the
 * first `"status":"…"` token in its serialized form (it precedes any nested
 * `error`), so the first match is authoritative. Returns 1 on a winning flip, 0 if
 * the field is missing or no longer in `{from}` (lost race / already transitioned).
 */
const CAS_ITEM_STATUS_LUA = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local fromTok = '"status":"' .. ARGV[2] .. '"'
local s, e = string.find(raw, fromTok, 1, true)
if not s then return 0 end
local toTok = '"status":"' .. ARGV[3] .. '"'
local updated = string.sub(raw, 1, s - 1) .. toTok .. string.sub(raw, e + 1)
redis.call('HSET', KEYS[1], ARGV[1], updated)
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1
`;

/** Lazily-constructed, process-wide Upstash REST client (one per instance). */
let client: Redis | undefined;

/** True when the Upstash (or Vercel KV) REST env is configured for this instance. */
export function isRedisConfigured(): boolean {
  return Boolean(
    (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
      (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  );
}

/**
 * Lazy singleton Upstash client. `Redis.fromEnv()` auto-reads either the Upstash
 * (`UPSTASH_REDIS_REST_URL`/`_TOKEN`) or the Vercel KV (`KV_REST_API_URL`/`_TOKEN`)
 * env pair. Construction performs no network I/O.
 */
export function getRedisClient(): Redis {
  client ??= Redis.fromEnv();
  return client;
}

/** Redis implementation of the async state-store contract. */
export class RedisStateStore implements AsyncStateStore {
  private readonly redis: Redis;

  constructor(redis: Redis = getRedisClient()) {
    this.redis = redis;
  }

  async createJob(job: Job): Promise<Job> {
    const key = jobKey(job.id);
    const { items, ...meta } = job;
    const fields: Record<string, unknown> = {
      meta: meta as JobMeta,
      order: items.map((item) => item.id),
    };
    for (const item of items) fields[itemField(item.id)] = item;
    const pipe = this.redis.pipeline();
    pipe.hset(key, fields);
    pipe.expire(key, JOB_TTL_SECONDS);
    await pipe.exec();
    return job;
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    const all = await this.redis.hgetall<Record<string, unknown>>(jobKey(jobId));
    if (!all || all.meta == null) return undefined;
    const meta = all.meta as JobMeta;
    const order = (all.order as string[] | undefined) ?? [];
    const items: Item[] = [];
    for (const id of order) {
      const item = all[itemField(id)] as Item | undefined;
      if (item) items.push(item);
    }
    return { ...meta, items };
  }

  // Reads always return a freshly-parsed object (an inherent deep clone); the
  // snapshot route and getJob can share it. Callers still treat results read-only.
  async snapshot(jobId: string): Promise<Job | undefined> {
    return this.getJob(jobId);
  }

  async getItem(jobId: string, itemId: string): Promise<Item | undefined> {
    const item = await this.redis.hget<Item>(jobKey(jobId), itemField(itemId));
    return item ?? undefined;
  }

  async setJobStatus(jobId: string, status: JobStatus): Promise<void> {
    const key = jobKey(jobId);
    const meta = await this.redis.hget<JobMeta>(key, "meta");
    if (!meta) return;
    meta.status = status;
    await this.writeField(key, "meta", meta);
  }

  async setItemStatus(jobId: string, itemId: string, status: ItemStatus): Promise<void> {
    await this.mutateItem(jobId, itemId, (item) => {
      item.status = status;
    });
  }

  async appendAttempt(jobId: string, itemId: string, attempt: Attempt): Promise<void> {
    await this.mutateItem(jobId, itemId, (item) => {
      item.attempts.push(attempt);
    });
  }

  async setItemResult(
    jobId: string,
    itemId: string,
    result: NonNullable<Item["result"]>,
  ): Promise<void> {
    await this.mutateItem(jobId, itemId, (item) => {
      item.result = result;
      item.error = undefined;
      item.status = "succeeded";
    });
  }

  async setItemError(
    jobId: string,
    itemId: string,
    error: NonNullable<Item["error"]>,
  ): Promise<void> {
    await this.mutateItem(jobId, itemId, (item) => {
      item.error = error;
      item.status = "failed";
    });
  }

  async casItemStatus(
    jobId: string,
    itemId: string,
    from: ItemStatus,
    to: ItemStatus,
  ): Promise<boolean> {
    const result = await this.redis.eval<[string, string, string, string], number>(
      CAS_ITEM_STATUS_LUA,
      [jobKey(jobId)],
      [itemField(itemId), from, to, String(JOB_TTL_SECONDS)],
    );
    return Number(result) === 1;
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.redis.del(jobKey(jobId));
  }

  /** Read one item field, apply `mutate`, write it back, and refresh the TTL. */
  private async mutateItem(
    jobId: string,
    itemId: string,
    mutate: (item: Item) => void,
  ): Promise<void> {
    const key = jobKey(jobId);
    const item = await this.redis.hget<Item>(key, itemField(itemId));
    if (!item) return;
    mutate(item);
    await this.writeField(key, itemField(itemId), item);
  }

  /** HSET a single field and (re)set the job hash TTL in one round trip. */
  private async writeField(key: string, field: string, value: unknown): Promise<void> {
    const pipe = this.redis.pipeline();
    pipe.hset(key, { [field]: value });
    pipe.expire(key, JOB_TTL_SECONDS);
    await pipe.exec();
  }
}
