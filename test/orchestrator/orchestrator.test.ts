/**
 * Orchestrator integration specifications (testing agent, Task 10).
 *
 * Exercises `runJob` / `retryItem` at the composition-root seam with fully
 * INJECTED `OrchestratorDeps` — a fake registry over a fake provider chain, a
 * fresh in-memory store, a fresh rate limiter, a capturing event bus, and a fake
 * `persist` that records the per-item result key. This is the
 * "POST /api/jobs → stream → terminal states" coverage one layer below HTTP
 * (HTTP e2e is Task 13). Asserts the full SSE event sequence, partial-failure
 * aggregation (`completed` vs `completed_with_errors`; whole-job `failed` only on
 * a pre-item precondition failure), failover advancement, prompt-only
 * degradation, and retry idempotency (per-item last-writer-wins key — no
 * duplicate result object). Maps to product-flow §3/§4 and §5b/§5c/§5d/§5e/§5i.
 *
 * Backoff is shrunk to ~1ms via env knobs (decisions.md 2026-06-26: knobs are
 * env-driven) and POOL_SIZE=1 makes the shared fake-provider script deterministic
 * across items; one test raises POOL_SIZE to exercise concurrent draining.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PersistedResult, PersistResultArgs } from "@/lib/blob/result-store";
import { JobEventBus } from "@/lib/orchestrator/event-bus";
import { type OrchestratorDeps, retryItem, runJob } from "@/lib/orchestrator/orchestrator";
import { ProviderRateLimiter } from "@/lib/ratelimit/token-bucket";
import { createMemoryStateStore, type StateStore } from "@/lib/state/store";
import type { Job } from "@/lib/types";
import { createFakeProvider } from "../fakes/fakeProvider";
import { createFakeRegistry, makeJob } from "../fakes/fixtures";

type Captured = { name: string; data: Record<string, unknown> };

/** A persist double that records the per-item key it resolves (last-writer-wins). */
function makeFakePersist() {
  const keys: string[] = [];
  const persist = async (args: PersistResultArgs): Promise<PersistedResult> => {
    const ext =
      args.contentType === "image/webp"
        ? "webp"
        : args.contentType === "image/jpeg"
          ? "jpg"
          : "png";
    const key = `results/${args.jobId}/${args.itemId}.${ext}`;
    keys.push(key);
    return {
      imageUrl: `https://blob.example/${key}`,
      contentType: args.contentType ?? "image/png",
    };
  };
  return { persist, keys };
}

/** Wire deps + a capturing bus around a store and a fake chain. */
function wire(store: StateStore, chain: ReturnType<typeof createFakeProvider>[]) {
  const bus = new JobEventBus("test-job");
  const events: Captured[] = [];
  bus.subscribe((e) => events.push({ name: e.name, data: e.data as Record<string, unknown> }));
  const { persist, keys } = makeFakePersist();
  const deps: OrchestratorDeps = {
    store,
    registry: createFakeRegistry(chain),
    rateLimiter: new ProviderRateLimiter(),
    persist,
    normalize: async () => ["data:image/png;base64,AAAA"],
    // Stub the once-per-job vision extractor so tests never hit the network.
    extractStyle: async () => undefined,
    getBus: () => bus,
  };
  return { deps, events, persistKeys: keys, bus };
}

const names = (events: Captured[]) => events.map((e) => e.name);
const byName = (events: Captured[], name: string) => events.filter((e) => e.name === name);

beforeEach(() => {
  process.env.ATTEMPT_CAP = "1"; // immediate advance on a retryable error (no backoff)
  process.env.BACKOFF_BASE_MS = "1";
  process.env.BACKOFF_MAX_MS = "1";
  process.env.POOL_SIZE = "1"; // deterministic shared-script ordering
});

afterEach(() => {
  for (const k of ["ATTEMPT_CAP", "BACKOFF_BASE_MS", "BACKOFF_MAX_MS", "POOL_SIZE"]) {
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

function seed(store: StateStore, jobId: string, itemCount = 1): Job {
  const job = makeJob(jobId, itemCount);
  store.createJob(job);
  return job;
}

describe("runJob — happy path event sequence", () => {
  test("emits item.status(running) → item.result → job.progress → job.done(completed)", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-happy");
    const gemini = createFakeProvider({ id: "gemini" });
    const { deps, events, persistKeys } = wire(store, [gemini]);

    await runJob("job-happy", deps);

    expect(names(events)).toEqual(["item.status", "item.result", "job.progress", "job.done"]);
    expect(events[0].data).toMatchObject({ status: "running" });
    expect(events[1].data).toMatchObject({ providerId: "gemini", usedImageReference: true });
    expect(events[2].data).toMatchObject({ done: 1, failed: 0, total: 1 });
    expect(events[3].data).toMatchObject({ status: "completed" });

    const itemId = job.items[0].id;
    expect(store.getItem("job-happy", itemId)?.status).toBe("succeeded");
    expect(persistKeys).toEqual([`results/job-happy/${itemId}.png`]);
  });
});

describe("runJob — failover (§5b) and degradation (§5c)", () => {
  test("advances to the next provider after the first is exhausted, then succeeds", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-fo");
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "error", kind: "rate_limit" }],
    });
    const cloudflare = createFakeProvider({ id: "cloudflare" });
    const { deps, events } = wire(store, [gemini, cloudflare]);

    await runJob("job-fo", deps);

    const result = byName(events, "item.result")[0];
    expect(result.data).toMatchObject({ providerId: "cloudflare", usedImageReference: true });
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed" });
    expect(store.getItem("job-fo", job.items[0].id)?.status).toBe("succeeded");
  });

  test("surfaces usedImageReference:false when the fallback provider is prompt-only", async () => {
    const store = createMemoryStateStore();
    seed(store, "job-degrade");
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "error", kind: "rate_limit" }],
    });
    const cloudflare = createFakeProvider({ id: "cloudflare", supportsImageReference: false });
    const { deps, events } = wire(store, [gemini, cloudflare]);

    await runJob("job-degrade", deps);

    expect(byName(events, "item.result")[0].data).toMatchObject({
      providerId: "cloudflare",
      usedImageReference: false,
    });
  });
});

describe("runJob — all providers exhausted (§5d)", () => {
  test("fails the item with all_providers_exhausted + the last provider id", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-exhaust");
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "error", kind: "rate_limit" }],
      fallback: { type: "error", kind: "rate_limit" },
    });
    const cloudflare = createFakeProvider({
      id: "cloudflare",
      script: [{ type: "error", kind: "quota_exhausted" }],
      fallback: { type: "error", kind: "quota_exhausted" },
    });
    const { deps, events, persistKeys } = wire(store, [gemini, cloudflare]);

    await runJob("job-exhaust", deps);

    const err = byName(events, "item.error")[0];
    expect(err.data).toMatchObject({
      code: "all_providers_exhausted",
      lastProviderId: "cloudflare",
    });
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed_with_errors" });
    expect(store.getItem("job-exhaust", job.items[0].id)?.status).toBe("failed");
    expect(persistKeys).toEqual([]); // nothing persisted on a fully-failed item
  });
});

describe("runJob — content policy fails one item without failover (§5i)", () => {
  test("stops on content_policy, never tries the next provider, batch continues", async () => {
    const store = createMemoryStateStore();
    seed(store, "job-policy");
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "error", kind: "content_policy" }],
    });
    const cloudflare = createFakeProvider({ id: "cloudflare" });
    const { deps, events } = wire(store, [gemini, cloudflare]);

    await runJob("job-policy", deps);

    expect(byName(events, "item.error")[0].data).toMatchObject({
      code: "content_policy",
      lastProviderId: "gemini",
    });
    expect(cloudflare.callCount()).toBe(0); // never failed over
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed_with_errors" });
  });
});

describe("runJob — empty 200 is retryable then fails over (§5k)", () => {
  test("an empty-image response is treated as retryable and advances the chain", async () => {
    const store = createMemoryStateStore();
    seed(store, "job-empty");
    const gemini = createFakeProvider({ id: "gemini", script: [{ type: "empty" }] });
    const cloudflare = createFakeProvider({ id: "cloudflare" });
    const { deps, events } = wire(store, [gemini, cloudflare]);

    await runJob("job-empty", deps);

    expect(byName(events, "item.result")[0].data).toMatchObject({ providerId: "cloudflare" });
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed" });
  });
});

describe("runJob — partial-failure aggregation (§5e)", () => {
  test("a mix of succeeded and failed items yields completed_with_errors", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-partial", 3);
    // POOL_SIZE=1 => script consumed in item order: ok, ok, fail.
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "success" }, { type: "success" }, { type: "error", kind: "rate_limit" }],
      fallback: { type: "error", kind: "rate_limit" },
    });
    const { deps, events } = wire(store, [gemini]);

    await runJob("job-partial", deps);

    const statuses = job.items.map((i) => store.getItem("job-partial", i.id)?.status);
    expect(statuses).toEqual(["succeeded", "succeeded", "failed"]);
    expect(byName(events, "item.result")).toHaveLength(2);
    expect(byName(events, "item.error")).toHaveLength(1);
    const lastProgress = byName(events, "job.progress").at(-1);
    expect(lastProgress?.data).toMatchObject({ done: 2, failed: 1, total: 3 });
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed_with_errors" });
  });

  test("all items failing is completed_with_errors (done=0), never job-level failed", async () => {
    const store = createMemoryStateStore();
    seed(store, "job-allfail", 2);
    const gemini = createFakeProvider({
      id: "gemini",
      fallback: { type: "error", kind: "rate_limit" },
      script: [
        { type: "error", kind: "rate_limit" },
        { type: "error", kind: "rate_limit" },
      ],
    });
    const { deps, events } = wire(store, [gemini]);

    await runJob("job-allfail", deps);

    const done = byName(events, "job.done")[0].data;
    expect(done).toMatchObject({ status: "completed_with_errors" });
    expect(byName(events, "job.progress").at(-1)?.data).toMatchObject({
      done: 0,
      failed: 2,
      total: 2,
    });
  });
});

describe("runJob — concurrency drains all items", () => {
  test("with POOL_SIZE>1 every item completes and the job reaches completed", async () => {
    process.env.POOL_SIZE = "5";
    const store = createMemoryStateStore();
    const job = seed(store, "job-conc", 6);
    const gemini = createFakeProvider({ id: "gemini" }); // fallback success, order-independent
    const { deps, events } = wire(store, [gemini]);

    await runJob("job-conc", deps);

    expect(job.items.every((i) => store.getItem("job-conc", i.id)?.status === "succeeded")).toBe(
      true,
    );
    expect(byName(events, "item.result")).toHaveLength(6);
    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "completed" });
    expect(byName(events, "job.progress").at(-1)?.data).toMatchObject({
      done: 6,
      failed: 0,
      total: 6,
    });
  });
});

describe("runJob — whole-job failed only on a pre-item precondition failure", () => {
  test("reference normalization failure fails the whole job (no items run)", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-norm");
    const gemini = createFakeProvider({ id: "gemini" });
    const { deps, events } = wire(store, [gemini]);
    deps.normalize = async () => {
      throw new Error("bad reference image");
    };

    await runJob("job-norm", deps);

    expect(names(events)).toEqual(["job.done"]);
    expect(events[0].data).toMatchObject({ status: "failed" });
    expect(store.getJob("job-norm")?.status).toBe("failed");
    expect(store.getItem("job-norm", job.items[0].id)?.status).toBe("queued"); // never started
    expect(gemini.callCount()).toBe(0);
  });

  test("an empty provider chain fails the whole job", async () => {
    const store = createMemoryStateStore();
    seed(store, "job-nochain");
    const { deps, events } = wire(store, []);

    await runJob("job-nochain", deps);

    expect(byName(events, "job.done")[0].data).toMatchObject({ status: "failed" });
    expect(store.getJob("job-nochain")?.status).toBe("failed");
  });
});

describe("retryItem — idempotent re-run, no duplicate result (§5d / §4)", () => {
  test("retry re-runs the chain to success with a single per-item result key", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-retry");
    const itemId = job.items[0].id;
    // First the provider fails, then (on retry) it succeeds.
    const gemini = createFakeProvider({
      id: "gemini",
      script: [{ type: "error", kind: "rate_limit" }, { type: "success" }],
      fallback: { type: "error", kind: "rate_limit" },
    });
    const { deps, events, persistKeys } = wire(store, [gemini]);

    await runJob("job-retry", deps);
    expect(store.getItem("job-retry", itemId)?.status).toBe("failed");
    expect(persistKeys).toEqual([]); // nothing persisted while failed

    // Simulate the retry route's failed → queued CAS, then re-run the item.
    expect(store.casItemStatus("job-retry", itemId, "failed", "queued")).toBe(true);
    await retryItem("job-retry", itemId, deps);

    expect(store.getItem("job-retry", itemId)?.status).toBe("succeeded");
    // Exactly one result object, written once, under the stable per-item key.
    expect(persistKeys).toEqual([`results/job-retry/${itemId}.png`]);
    expect(new Set(persistKeys).size).toBe(1);
    // job re-aggregates and re-emits job.done (now completed).
    expect(byName(events, "job.done").at(-1)?.data).toMatchObject({ status: "completed" });
  });

  test("retryItem is a no-op when the item is not queued (de-dup guard, §5p)", async () => {
    const store = createMemoryStateStore();
    const job = seed(store, "job-noop");
    const itemId = job.items[0].id;
    const gemini = createFakeProvider({ id: "gemini" });
    const { deps } = wire(store, [gemini]);

    await runJob("job-noop", deps); // item succeeds (status succeeded, not queued)
    const callsAfterRun = gemini.callCount();
    await retryItem("job-noop", itemId, deps); // item is succeeded -> guard returns

    expect(gemini.callCount()).toBe(callsAfterRun); // no new provider call
    expect(store.getItem("job-noop", itemId)?.status).toBe("succeeded");
  });
});
