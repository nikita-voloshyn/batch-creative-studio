/**
 * In-memory job/item/attempt state store (component C20, backend — BE).
 *
 * SINGLE-WRITER OF AUTHORITATIVE STATE (product-flow §0). Every mutation to a
 * Job / Item / Attempt goes through THIS module — the orchestrator never reaches
 * into a `Job` object and mutates it directly; it calls the methods here. That
 * keeps the "Item/Job mutations are performed only by the backend orchestrator,
 * via the store" invariant literally true and gives us one place to later swap
 * the impl for Postgres (`pgStore.ts`, full-product — architecture §8.2).
 *
 * MVP scope: a per-process `Map<jobId, Job>`. It does NOT survive a cold start /
 * scale-down / process recycle (the accepted MVP trade-off — decisions.md
 * 2026-06-26, architecture §5.7 / §13, product-flow §11). Persistence (Postgres
 * + KV) is deferred.
 *
 * Read semantics: `getJob` / `getItem` return the LIVE object for fast internal
 * reads — callers MUST treat them as read-only and mutate only through the store
 * methods. `snapshot` returns a deep clone, safe to serialize and hand to a Route
 * Handler (the `GET /api/jobs/:id` snapshot, Task 6) without risking external
 * mutation of authoritative state.
 */
import type { Attempt, Item, ItemStatus, Job, JobStatus } from "@/lib/types";

/**
 * State-store contract. The in-memory impl below satisfies it; a Postgres impl
 * (full-product) can satisfy the same surface so the orchestrator stays
 * storage-agnostic (architecture §8.2).
 */
export interface StateStore {
  /** Insert a freshly-built Job (with its N queued Items). Returns the stored Job. */
  createJob(job: Job): Job;
  /** Live Job reference (read-only to callers), or `undefined` if unknown. */
  getJob(jobId: string): Job | undefined;
  /** Live Item reference (read-only to callers), or `undefined` if unknown. */
  getItem(jobId: string, itemId: string): Item | undefined;
  /** Deep clone of the Job, safe to serialize / hand out (reconnect snapshot). */
  snapshot(jobId: string): Job | undefined;

  /** Set the Job-level status (running → terminal, or back to running on retry). */
  setJobStatus(jobId: string, status: JobStatus): void;
  /** Set an Item's status. */
  setItemStatus(jobId: string, itemId: string, status: ItemStatus): void;
  /** Append one Attempt record to an Item's ordered attempt list. */
  appendAttempt(jobId: string, itemId: string, attempt: Attempt): void;
  /** Set the success result + flip the Item to `succeeded`, clearing any prior error. */
  setItemResult(jobId: string, itemId: string, result: NonNullable<Item["result"]>): void;
  /** Set the terminal error + flip the Item to `failed`. */
  setItemError(jobId: string, itemId: string, error: NonNullable<Item["error"]>): void;

  /**
   * Atomic compare-and-set on Item status (architecture §8.2 / §11). Used by the
   * targeted-retry route to move `failed → queued` exactly once, de-duping
   * concurrent double-clicks: returns `true` only for the caller that performed
   * the transition. JS is single-threaded per process, so the read-check-write
   * here is atomic with respect to other handlers in the same process.
   */
  casItemStatus(jobId: string, itemId: string, from: ItemStatus, to: ItemStatus): boolean;

  /** Drop a Job entirely (e.g. cleanup after the stream closes). */
  deleteJob(jobId: string): void;
}

/** A value that may be returned synchronously OR as a Promise. */
export type Awaitable<T> = T | Promise<T>;

/**
 * Async-tolerant view of the same `StateStore` contract (X1 / architecture §8.2).
 *
 * WHY THIS EXISTS: the MVP `MemoryStateStore` is synchronous (single process), and
 * the test-suite pins those synchronous signatures. The production shared store
 * (`RedisStateStore`, Upstash REST) is unavoidably asynchronous. Every method here
 * returns `Awaitable<T>`, so a SYNC `StateStore` is structurally assignable to it
 * (each `T` satisfies `T | Promise<T>`) AND an async Redis impl satisfies it too.
 * Consumers (the route handlers + the orchestrator) therefore type the store as
 * `AsyncStateStore` and `await` every call: awaiting a sync return is a harmless
 * micro-task, awaiting the Redis promise does the real I/O. This keeps the
 * in-memory path (and the 106 tests) untouched while making the store swappable.
 */
export interface AsyncStateStore {
  createJob(job: Job): Awaitable<Job>;
  getJob(jobId: string): Awaitable<Job | undefined>;
  getItem(jobId: string, itemId: string): Awaitable<Item | undefined>;
  snapshot(jobId: string): Awaitable<Job | undefined>;
  setJobStatus(jobId: string, status: JobStatus): Awaitable<void>;
  setItemStatus(jobId: string, itemId: string, status: ItemStatus): Awaitable<void>;
  appendAttempt(jobId: string, itemId: string, attempt: Attempt): Awaitable<void>;
  setItemResult(
    jobId: string,
    itemId: string,
    result: NonNullable<Item["result"]>,
  ): Awaitable<void>;
  setItemError(jobId: string, itemId: string, error: NonNullable<Item["error"]>): Awaitable<void>;
  casItemStatus(
    jobId: string,
    itemId: string,
    from: ItemStatus,
    to: ItemStatus,
  ): Awaitable<boolean>;
  deleteJob(jobId: string): Awaitable<void>;
}

class MemoryStateStore implements StateStore {
  private readonly jobs = new Map<string, Job>();

  createJob(job: Job): Job {
    this.jobs.set(job.id, job);
    return job;
  }

  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  getItem(jobId: string, itemId: string): Item | undefined {
    return this.jobs.get(jobId)?.items.find((item) => item.id === itemId);
  }

  snapshot(jobId: string): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  setJobStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (job) job.status = status;
  }

  setItemStatus(jobId: string, itemId: string, status: ItemStatus): void {
    const item = this.getItem(jobId, itemId);
    if (item) item.status = status;
  }

  appendAttempt(jobId: string, itemId: string, attempt: Attempt): void {
    const item = this.getItem(jobId, itemId);
    if (item) item.attempts.push(attempt);
  }

  setItemResult(jobId: string, itemId: string, result: NonNullable<Item["result"]>): void {
    const item = this.getItem(jobId, itemId);
    if (!item) return;
    item.result = result;
    item.error = undefined;
    item.status = "succeeded";
  }

  setItemError(jobId: string, itemId: string, error: NonNullable<Item["error"]>): void {
    const item = this.getItem(jobId, itemId);
    if (!item) return;
    item.error = error;
    item.status = "failed";
  }

  casItemStatus(jobId: string, itemId: string, from: ItemStatus, to: ItemStatus): boolean {
    const item = this.getItem(jobId, itemId);
    if (!item || item.status !== from) return false;
    item.status = to;
    return true;
  }

  deleteJob(jobId: string): void {
    this.jobs.delete(jobId);
  }
}

/** Process-wide MVP state store consumed by the orchestrator + Route Handlers. */
export const stateStore: StateStore = new MemoryStateStore();

/** Factory (used by tests in Task 10 to get an isolated store). */
export function createMemoryStateStore(): StateStore {
  return new MemoryStateStore();
}
