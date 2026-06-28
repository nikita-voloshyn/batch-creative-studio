/**
 * Job orchestrator / composition root (component C12, backend — BE).
 *
 * Drives one Job's lifecycle, callable from the SSE stream Route Handler (Task 6)
 * which hosts it inline (architecture §5.1 / §6). Given an already-created Job
 * (N queued Items, persisted by `POST /api/jobs`), it:
 *   1. validates `registry.chain()` is non-empty (else job-level `failed`);
 *   2. runs reference normalization ONCE per job (else job-level `failed`);
 *   3. derives the per-batch deterministic seed;
 *   4. drives the bounded worker pool over the queued Items;
 *   5. for each Item: builds `GenerateInput`, runs the retry loop against the
 *      provider, persists the result under the per-item key, updates state, and
 *      emits SSE events through the per-job event bus;
 *   6. sweeps any non-terminal Item to `failed(interrupted)` on abort/shutdown;
 *   7. aggregates to a terminal Job status and emits `job.done`.
 *
 * This is the COMPOSITION ROOT: it is the one BE module allowed the declared
 * BE→PV non-interface dependency on `registry`/`prompt`/`reference-normalize`
 * (architecture §2/§3). It NEVER imports a concrete adapter.
 *
 * TASK 9 (multi-provider failover) — IMPLEMENTED: per-Item processing runs the
 * full chain via the `lib/orchestrator/failover.ts` engine. `processItem` calls
 * `runFailover(ctx.chain, …)`; each provider runs the per-provider retry path
 * (`runProviderAttempts` → `runWithRetry` + `classifyKind`). The engine advances
 * on `advance` (retries exhausted OR auth/quota_exhausted), stops on `fail_item`
 * (content_policy/invalid_input) and `aborted`, finishes on `success`, and pre-
 * emptively skips a near-daily-quota provider (`rateLimiter.nearDailyQuota`,
 * product-flow §5g). Only an exhausted chain yields `item.failed`
 * (`all_providers_exhausted` + last provider tried). `retryItem` re-runs the FULL
 * chain because it reuses `processItem` (chain always starts at provider #1).
 *
 * L1 RE-ACCEPTED (Task-5 review): an item HOLDS its pool slot through retry
 * backoff — `runWithRetry`'s backoff `sleep` is awaited inside the worker, so the
 * slot is occupied while the item sleeps. product-flow §6.3 prefers
 * release-and-requeue, but that needs a not-before re-queue + token release
 * across the worker pool (non-trivial). For the MVP FIXED pool (POOL_SIZE=5, N≤20,
 * ATTEMPT_CAP=3, backoff capped at BACKOFF_MAX_MS=8s) the worst-case idle is small
 * and bounded; release-and-requeue is the durable-queue (full-product) concern
 * (architecture §13). Decision: re-accept hold-through-backoff for the MVP.
 */

import { persistResult } from "@/lib/blob/result-store";
import {
  attemptCap,
  attemptTimeoutMs,
  backoffBaseMs,
  backoffMaxMs,
  poolSize,
  quotaSoftFraction,
} from "@/lib/orchestrator/config";
import { getJobEventBus, type JobEventBus } from "@/lib/orchestrator/event-bus";
import {
  type FailoverOutcome,
  type FailoverTransition,
  runFailover,
} from "@/lib/orchestrator/failover";
import { dedupe, idempotencyKey } from "@/lib/orchestrator/idempotency";
import { type RetryOutcome, runWithRetry } from "@/lib/orchestrator/retry";
import { runPool } from "@/lib/orchestrator/worker-pool";
import {
  buildPrompt,
  registry as defaultRegistry,
  extractReferenceStyleText,
  type GenerateInput,
  type ImageProvider,
  normalizeReferences,
  ProviderError,
  type ProviderRegistry,
} from "@/lib/providers";
import {
  rateLimiter as defaultRateLimiter,
  type ProviderRateLimiter,
} from "@/lib/ratelimit/token-bucket";
import { getStateStore } from "@/lib/state";
import type { AsyncStateStore } from "@/lib/state/store";
import type { Attempt, Item, Job, JobStatus } from "@/lib/types";

/**
 * Injectable dependencies — defaults are the process-global singletons. `store`
 * defaults to `getStateStore()` (Redis when configured, else in-memory); it is
 * typed `AsyncStateStore` so the orchestrator awaits every store call, which works
 * for both the sync in-memory store (tests) and the async Redis store (prod).
 */
export type OrchestratorDeps = {
  store?: AsyncStateStore;
  registry?: ProviderRegistry;
  rateLimiter?: ProviderRateLimiter;
  /** Result-bytes writer (per-item key, last-writer-wins). */
  persist?: typeof persistResult;
  /** Reference-normalizer (providers-owned, run once per job). */
  normalize?: typeof normalizeReferences;
  /** Reference-mood text extractor (providers-owned, run once per job, best-effort). */
  extractStyle?: typeof extractReferenceStyleText;
  /** Per-job event bus resolver (the SSE route shares the same bus). */
  getBus?: (jobId: string) => JobEventBus;
  /** Job-level abort (stream close / graceful shutdown / maxDuration). */
  signal?: AbortSignal;
};

/** Per-item success payload (mirrors `Item.result`). */
type ItemResult = NonNullable<Item["result"]>;
/** Per-item terminal error payload (mirrors `Item.error`). */
type ItemError = NonNullable<Item["error"]>;

/** Outcome of processing one Item (after the single-provider retry loop). */
type ItemOutcome = { kind: "succeeded"; result: ItemResult } | { kind: "failed"; error: ItemError };

/** Everything the per-item workers need, assembled once per job. */
type JobContext = {
  jobId: string;
  job: Job;
  store: AsyncStateStore;
  registry: ProviderRegistry;
  rateLimiter: ProviderRateLimiter;
  bus: JobEventBus;
  persist: typeof persistResult;
  chain: ImageProvider[];
  normalizedRefs: string[];
  /**
   * Reference MOOD as text, extracted ONCE per job by a vision model
   * (`extractReferenceStyleText`). Threaded into every item's prompt so a
   * single-image edit model (HF Kontext) re-styles the product in the reference's
   * mood without compositing the reference as a second image. `undefined` when
   * there is no reference or extraction failed (best-effort) → prompt leans on the
   * brief alone.
   */
  referenceStyleText?: string;
  seed: number;
  signal?: AbortSignal;
  /**
   * Per-item write barrier (Redis lost-update fix). Holds the tail of the
   * in-flight `appendAttempt` chain for each item id, so `processItem` can await
   * it BEFORE a terminal status/result/error write. Without it, a slow fire-and-
   * forget attempt append (HGET→mutate→HSET on the shared `item:{id}` field) can
   * land AFTER `setItemResult`/`setItemError` and clobber the terminal write,
   * stranding the item `running`. The sync in-memory store resolves these on a
   * microtask, so behavior (and the 106 tests) is unchanged.
   */
  attemptWrites: Map<string, Promise<void>>;
};

/**
 * Per-batch deterministic seed from the jobId (FNV-1a), so it is reproducible
 * without being part of the request payload (architecture §5.6). `POST /api/jobs`
 * (Task 6) uses this to set `Job.seed`; the orchestrator falls back to it if
 * `Job.seed` is not a finite number.
 *
 * Masked to a NON-NEGATIVE INT32 (`& 0x7fffffff` → 0..2_147_483_647): some
 * providers reject a uint32 seed (e.g. Gemini's `generation_config.seed` is
 * `TYPE_INT32` and 400s on values > 2^31-1). int32 is universally accepted.
 */
export function deriveSeed(jobId: string): number {
  let hash = 2166136261;
  for (let i = 0; i < jobId.length; i++) {
    hash ^= jobId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash & 0x7fffffff;
}

/** Discriminated result of assembling a per-job context. */
type ContextResult = { ok: true; ctx: JobContext } | { ok: false; code: string; message: string };

/**
 * Resolve deps, validate the provider chain, run reference normalization once,
 * derive the seed, and assemble the per-job `JobContext`. Shared by `runJob` and
 * the targeted-retry path (`retryItem`). Returns a precondition failure (empty
 * chain / bad reference) as data instead of throwing, so each caller decides
 * whether that fails the whole job (`runJob`) or only the retried item
 * (`retryItem`). It assembles `ctx.chain` (the whole resolved chain) that the
 * per-item failover loop (`processItem` → `runFailover`) iterates.
 */
async function buildContext(jobId: string, deps: OrchestratorDeps): Promise<ContextResult> {
  const store = deps.store ?? getStateStore();
  const registry = deps.registry ?? defaultRegistry;
  const rateLimiter = deps.rateLimiter ?? defaultRateLimiter;
  const persist = deps.persist ?? persistResult;
  const normalize = deps.normalize ?? normalizeReferences;
  const extractStyle = deps.extractStyle ?? extractReferenceStyleText;
  const bus = (deps.getBus ?? getJobEventBus)(jobId);
  const signal = deps.signal;

  const job = await store.getJob(jobId);
  if (!job) return { ok: false, code: "unknown_job", message: "Job not found." };

  // Empty / under-configured provider chain → legitimate job-level failure.
  const chain = registry.chain();
  if (chain.length === 0) {
    return {
      ok: false,
      code: "no_providers_configured",
      message: "No image providers are configured.",
    };
  }

  // One-time reference normalization → precondition failure on a bad reference.
  let normalizedRefs: string[];
  try {
    normalizedRefs = await normalize(job.referenceImageUrls, signal);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Reference normalization failed.";
    return { ok: false, code: "reference_normalization_failed", message };
  }

  // One-time reference MOOD extraction (best-effort): a vision model turns the
  // reference image(s) into a short style/mood text that every item's prompt reuses
  // so a single-image edit model re-styles the product in that mood WITHOUT a second
  // image in frame. Never gates the job — on failure the prompt leans on the brief.
  const referenceStyleText = await extractStyle(job.referenceImageUrls, signal);

  const seed = Number.isFinite(job.seed) ? job.seed : deriveSeed(jobId);
  const ctx: JobContext = {
    jobId,
    job,
    store,
    registry,
    rateLimiter,
    bus,
    persist,
    chain,
    normalizedRefs,
    referenceStyleText,
    seed,
    signal,
    attemptWrites: new Map(),
  };
  return { ok: true, ctx };
}

/**
 * Run a created Job to terminal status. Resolves once the Job has reached a
 * terminal status and `job.done` has been emitted. Honors the Terminal invariant
 * within this one function lifetime (architecture §5.7, product-flow §0).
 */
export async function runJob(jobId: string, deps: OrchestratorDeps = {}): Promise<void> {
  const store = deps.store ?? getStateStore();
  const bus = (deps.getBus ?? getJobEventBus)(jobId);

  const job = await store.getJob(jobId);
  if (!job) return; // Nothing to run (unknown job); the route returns 404 separately.

  await store.setJobStatus(jobId, "running");

  // 1-2. Validate chain + normalize references → job-level `failed` on failure.
  const built = await buildContext(jobId, deps);
  if (!built.ok) {
    await failJob(store, bus, jobId, built.code, built.message);
    return;
  }
  const ctx = built.ctx;

  // 3. Drive the bounded worker pool over the queued Items.
  const pending = job.items.filter((item) => item.status === "queued" || item.status === "running");
  await runPool(pending, poolSize(), (item) => processItem(ctx, item), {
    signal: ctx.signal,
    onUnexpectedError: (item, error) => {
      // Defensive: processItem terminalizes its own failures, so this is only a
      // true bug. Terminalize the item so it never hangs the aggregation. The
      // end-of-run sweep also catches any item left non-terminal, so a fire-and-
      // forget here is safe even if the async write has not yet landed.
      const id = (item as Item)?.id;
      if (id) {
        void terminalizeFailed(ctx, id, {
          code: "internal_error",
          message: error instanceof Error ? error.message : "Unexpected worker error.",
          lastProviderId: ctx.chain[0]?.id ?? "",
        });
      }
    },
  });

  // 4. Sweep any Item still non-terminal (never started / aborted) → interrupted.
  await sweepNonTerminal(ctx);

  // 5. Aggregate to a terminal Job status (never job-level `failed` from items).
  await aggregateAndFinish(ctx);
}

/**
 * Re-drive ONE Item that the retry route (component C11) has just CAS'd
 * `failed → queued`. Reuses the per-item path (`processItem`), so a Task 9
 * failover loop added inside `processItem` automatically benefits retries too.
 * Emits the same `item.status`/`item.result`/`item.error`/`job.progress` events
 * to the per-job bus that open streams forward, and re-emits `job.done` if this
 * retry re-completes a previously-terminal job (product-flow §4 / §5d). Never
 * throws — all failures are terminalized on the Item.
 *
 * Concurrency note (MVP): if the owning `runJob` is still draining other items
 * when a retry runs, its end-of-run `sweepNonTerminal` could race this in-flight
 * item. Last-writer-wins on the per-item result key + idempotent client merge
 * keep state convergent; eliminating the race is a durable-queue (full-product)
 * concern. The dominant case — retry on an already-terminal job — is race-free
 * because that `runJob` has fully returned.
 */
export async function retryItem(
  jobId: string,
  itemId: string,
  deps: OrchestratorDeps = {},
): Promise<void> {
  const store = deps.store ?? getStateStore();
  const bus = (deps.getBus ?? getJobEventBus)(jobId);

  // The route performed the failed → queued CAS; bail if it is not queued.
  if ((await store.getItem(jobId, itemId))?.status !== "queued") return;

  const built = await buildContext(jobId, deps);
  if (!built.ok) {
    // A single-item retry must never fail the whole job — terminalize this item.
    await store.setItemError(jobId, itemId, {
      code: built.code,
      message: built.message,
      lastProviderId: "",
    });
    bus.emit("item.error", {
      itemId,
      code: built.code,
      message: built.message,
      lastProviderId: "",
    });
    await emitProgressDirect(store, bus, jobId);
    await finishIfAllTerminal(store, bus, jobId);
    return;
  }

  const live = await store.getItem(jobId, itemId);
  if (live) await processItem(built.ctx, live);
  await finishIfAllTerminal(store, bus, jobId);
}

/**
 * Process ONE Item: emit `running`, run the MULTI-PROVIDER failover loop over the
 * whole chain, persist on success, update state, and emit the terminal event.
 * Never throws — all failures are mapped to a terminal `failed` Item (one Item's
 * failure never blocks others). `retryItem` reuses this, so a targeted retry
 * automatically re-runs the full chain from provider #1.
 */
async function processItem(ctx: JobContext, item: Item): Promise<void> {
  await ctx.store.setItemStatus(ctx.jobId, item.id, "running");
  ctx.bus.emit("item.status", { itemId: item.id, status: "running" });

  let outcome: ItemOutcome;
  try {
    const result = await runFailover<ItemResult>(ctx.chain, {
      // Quota pre-switch (product-flow §5g): skip a provider at/over its daily
      // soft threshold so a near-exhausted Gemini yields to Cloudflare proactively.
      shouldPreSwitch: (provider) =>
        ctx.rateLimiter.nearDailyQuota(
          provider.id,
          ctx.registry.quota(provider.id).dailyCap,
          quotaSoftFraction(),
        ),
      runProvider: (provider) => runProviderAttempts(ctx, item, provider),
      onAdvance: (transition) => logFailover(ctx, item.id, transition),
    });
    outcome = failoverToOutcome(result);
  } catch (error) {
    outcome = {
      kind: "failed",
      error: {
        code: "internal_error",
        message: error instanceof Error ? error.message : "Unexpected processing error.",
        lastProviderId: ctx.chain[0]?.id ?? "",
      },
    };
  }

  // Write barrier (Redis lost-update fix): drain any in-flight attempt append for
  // this item BEFORE the terminal write, so a slow `appendAttempt` cannot clobber
  // `setItemResult`/`setItemError` on the shared `item:{id}` field. The failover
  // loop above has fully resolved, so no further attempts are produced; awaiting
  // the tail of the per-item append chain therefore drains all of them. No-op on
  // the sync in-memory store.
  await ctx.attemptWrites.get(item.id);
  ctx.attemptWrites.delete(item.id);

  if (outcome.kind === "succeeded") {
    await ctx.store.setItemResult(ctx.jobId, item.id, outcome.result);
    // `usedImageReference` from the WINNING provider's GenerateResult flows out on
    // the SSE `item.result` so the FE can render the `style: prompt-only` badge
    // when a fallback provider could not use the reference (product-flow §5c).
    ctx.bus.emit("item.result", {
      itemId: item.id,
      imageUrl: outcome.result.imageUrl,
      providerId: outcome.result.providerId,
      usedImageReference: outcome.result.usedImageReference,
    });
  } else {
    await terminalizeFailed(ctx, item.id, outcome.error);
  }
  await emitProgress(ctx);
}

/**
 * Run the per-provider timed retry loop for ONE provider and return its raw 3-way
 * `RetryOutcome` for the failover engine to act on. This is the per-provider
 * "inner" of the chain loop: it builds the `GenerateInput` (threading
 * `usesImageReference` from whether reference images are ACTUALLY sent to a
 * reference-capable provider, so a no-reference or prompt-only path degrades the
 * prompt cleanly), records each attempt, and threads the winning result's
 * `contentType` into the per-item result blob so a format-changing failover
 * (Gemini PNG → Cloudflare WEBP) keeps a stable `{ext}`.
 */
async function runProviderAttempts(
  ctx: JobContext,
  item: Item,
  provider: ImageProvider,
): Promise<RetryOutcome<ItemResult>> {
  const input: GenerateInput = {
    productImageUrl: item.productImageUrl,
    // Pass the ORIGINAL http(s) reference Blob URLs (already SSRF-validated at
    // POST /api/jobs), not the inlined `data:` URLs. The inline-conditioning
    // adapters (Gemini/Cloudflare) fetch them via `fetchImageAsInlineData` (which
    // handles http + data:), and Pollinations needs http URLs for its `image=`
    // param (a `data:` URL there overflows the request-URI → HTTP 414). The
    // `normalizeReferences` pass above still runs as a fetch+type/size validation.
    referenceImageUrls: ctx.job.referenceImageUrls,
    prompt: buildPrompt({
      brief: ctx.job.params.brief,
      captionHint: ctx.job.params.perImageHints?.[item.productImageUrl],
      // Reference MOOD as text, extracted once per job (architecture §5c /
      // product-flow §5.4). The PRIMARY style signal for the product-only HF
      // Kontext edit, and supplementary cues for an image-conditioned fallback.
      referenceStyleText: ctx.referenceStyleText,
      aspectRatio: ctx.job.params.aspectRatio,
      // Assert "match the reference image(s)" in the prompt ONLY when style
      // reference images are ACTUALLY passed to this generation (http URLs the
      // provider receives) AND the provider conditions on references — not merely
      // from `provider.supportsImageReference`. Otherwise the prompt claims a
      // reference image that was never sent (zero references, or a prompt-only
      // text model), which is self-contradictory.
      usesImageReference:
        provider.supportsImageReference &&
        ctx.job.referenceImageUrls.some((url) => /^https?:\/\//i.test(url)),
    }),
    aspectRatio: ctx.job.params.aspectRatio,
    seed: ctx.seed,
  };
  const rpm = ctx.registry.quota(provider.id).rpm;

  const attempt = async (
    attemptSignal: AbortSignal,
    attemptNumber: number,
  ): Promise<ItemResult> => {
    // Count this provider call toward the best-effort daily quota (architecture §5.4).
    ctx.rateLimiter.recordCall(provider.id);
    // De-dup any concurrent identical (itemId, attemptNumber) delivery in-process.
    const key = idempotencyKey(item.id, attemptNumber);
    const generated = await dedupe(key, () => provider.generate(input, attemptSignal));

    const bytes = generated.imageBytes;
    const isEmpty =
      bytes == null ||
      (bytes instanceof Uint8Array && bytes.byteLength === 0) ||
      (typeof bytes === "string" && bytes.trim() === "");
    if (isEmpty) {
      // Empty/corrupt 200 → retryable (product-flow §5k); never a result.
      throw new ProviderError("server", provider.id, "Provider returned an empty image.");
    }

    const persisted = await ctx.persist({
      jobId: ctx.jobId,
      itemId: item.id,
      imageBytes: bytes,
      // Prefer the adapter-declared content-type for the result-blob `{ext}`
      // (falls back to magic-byte sniffing when absent) — keeps `{ext}` stable
      // across a format-changing failover (Task-5 review L2 / Task-8 flag).
      contentType: generated.contentType,
      signal: attemptSignal,
    });
    return {
      imageUrl: persisted.imageUrl,
      providerId: generated.providerId,
      usedImageReference: generated.usedImageReference,
    };
  };

  return runWithRetry(attempt, {
    providerId: provider.id,
    attemptCap: attemptCap(),
    attemptTimeoutMs: attemptTimeoutMs(),
    backoffBaseMs: backoffBaseMs(),
    backoffMaxMs: backoffMaxMs(),
    signal: ctx.signal,
    acquire: (s) => ctx.rateLimiter.acquire(provider.id, rpm, s),
    onAttempt: (record) => recordAttempt(ctx, item.id, record),
  });
}

/** Map the chain-level failover outcome to the Item result/error payload. */
function failoverToOutcome(outcome: FailoverOutcome<ItemResult>): ItemOutcome {
  switch (outcome.status) {
    case "success":
      return { kind: "succeeded", result: outcome.value };
    case "failed": {
      // Exhausted chain → a clear `all_providers_exhausted` cause that names the
      // last provider tried (product-flow §5d). A `fail_item` (content-policy /
      // invalid-input) keeps the underlying error kind (product-flow §5i).
      const isExhausted = outcome.reason === "exhausted";
      const code = isExhausted ? "all_providers_exhausted" : outcome.error.kind;
      const message = isExhausted
        ? `All providers exhausted (last tried: ${outcome.lastProviderId || "none"}). ${outcome.error.message}`
        : outcome.error.message;
      return {
        kind: "failed",
        error: { code, message, lastProviderId: outcome.lastProviderId },
      };
    }
    case "aborted":
      return {
        kind: "failed",
        error: {
          code: "interrupted",
          message: outcome.error.message,
          lastProviderId: outcome.lastProviderId,
        },
      };
  }
}

/** Emit the structured `failover` log line on each chain hop (product-flow §9). */
function logFailover(ctx: JobContext, itemId: string, transition: FailoverTransition): void {
  console.info(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "failover",
      jobId: ctx.jobId,
      itemId,
      from: transition.from.id,
      to: transition.to?.id,
      reason: transition.reason,
    }),
  );
}

/**
 * Append an Attempt to the store and emit the per-attempt structured log line.
 *
 * Invoked as the retry engine's synchronous `onAttempt` hook, so it cannot await.
 * The attempt list and log line are non-critical telemetry (the load-bearing
 * item status/result/error writes are all awaited in `processItem`), so the async
 * store write is fire-and-forget. Per item, attempts are produced one at a time
 * (a provider call + backoff separates them), so they are issued in order; the
 * orchestrator invocation stays alive until `job.done`, so a pending Redis write
 * still lands.
 *
 * To close the Redis lost-update race, the append is CHAINED onto the prior
 * in-flight append for the same item (recorded on `ctx.attemptWrites`) — this
 * keeps same-item appends serialized (each is a HGET→mutate→HSET on the shared
 * `item:{id}` field, so overlapping ones would clobber) AND gives `processItem`
 * a tail promise to await as a write barrier before its terminal write. The
 * append is best-effort: any failure is logged and swallowed so it can never
 * reject the barrier and break the load-bearing terminal write.
 */
function recordAttempt(ctx: JobContext, itemId: string, attempt: Attempt): void {
  const prior = ctx.attemptWrites.get(itemId) ?? Promise.resolve();
  const next = prior.then(() =>
    persistAttempt(ctx, itemId, attempt).catch((error) => {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          event: "attempt_persist_failed",
          jobId: ctx.jobId,
          itemId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }),
  );
  ctx.attemptWrites.set(itemId, next);
}

async function persistAttempt(ctx: JobContext, itemId: string, attempt: Attempt): Promise<void> {
  await ctx.store.appendAttempt(ctx.jobId, itemId, attempt);
  const attemptIndex = ((await ctx.store.getItem(ctx.jobId, itemId))?.attempts.length ?? 1) - 1;
  console.info(
    JSON.stringify({
      ts: attempt.finishedAt,
      level: attempt.outcome === "success" ? "info" : "warn",
      jobId: ctx.jobId,
      itemId,
      attempt: attemptIndex,
      providerId: attempt.providerId,
      outcome: attempt.outcome,
      errorCode: attempt.outcome === "success" ? undefined : attempt.errorMessage,
    }),
  );
}

/** Set the Item to terminal `failed` + emit `item.error`. */
async function terminalizeFailed(ctx: JobContext, itemId: string, error: ItemError): Promise<void> {
  await ctx.store.setItemError(ctx.jobId, itemId, error);
  ctx.bus.emit("item.error", {
    itemId,
    code: error.code,
    message: error.message,
    lastProviderId: error.lastProviderId,
  });
}

/** Emit `job.progress` from the live item statuses (store/bus form). */
async function emitProgressDirect(
  store: AsyncStateStore,
  bus: JobEventBus,
  jobId: string,
): Promise<void> {
  const job = await store.getJob(jobId);
  if (!job) return;
  let done = 0;
  let failed = 0;
  for (const item of job.items) {
    if (item.status === "succeeded") done += 1;
    else if (item.status === "failed") failed += 1;
  }
  bus.emit("job.progress", { done, failed, total: job.items.length });
}

/** Emit `job.progress` from the live item statuses (context form). */
async function emitProgress(ctx: JobContext): Promise<void> {
  await emitProgressDirect(ctx.store, ctx.bus, ctx.jobId);
}

/**
 * Re-aggregate after a targeted retry: if every Item is now terminal, set the
 * terminal Job status and (re-)emit `job.done` (product-flow §4). No-op while any
 * Item is still non-terminal — the owning `runJob` will finish the job. Item
 * aggregation never yields job-level `failed`.
 */
async function finishIfAllTerminal(
  store: AsyncStateStore,
  bus: JobEventBus,
  jobId: string,
): Promise<void> {
  const job = await store.getJob(jobId);
  if (!job) return;
  const allTerminal = job.items.every(
    (item) => item.status === "succeeded" || item.status === "failed",
  );
  if (!allTerminal) return;
  const failed = job.items.filter((item) => item.status === "failed").length;
  const status: JobStatus = failed === 0 ? "completed" : "completed_with_errors";
  await store.setJobStatus(jobId, status);
  bus.emit("job.done", { status });
}

/** Mark any still-non-terminal Item as `failed(interrupted)` (abort/shutdown). */
async function sweepNonTerminal(ctx: JobContext): Promise<void> {
  const job = await ctx.store.getJob(ctx.jobId);
  if (!job) return;
  for (const item of job.items) {
    if (item.status === "queued" || item.status === "running") {
      await terminalizeFailed(ctx, item.id, {
        code: "interrupted",
        message: "Batch interrupted before this item completed.",
        lastProviderId: ctx.chain[0]?.id ?? "",
      });
      await emitProgress(ctx);
    }
  }
}

/** Aggregate item outcomes → terminal Job status and emit `job.done`. */
async function aggregateAndFinish(ctx: JobContext): Promise<void> {
  const job = await ctx.store.getJob(ctx.jobId);
  if (!job) return;
  const failed = job.items.filter((item) => item.status === "failed").length;
  // Item aggregation NEVER yields job-level `failed` (product-flow §0/§4).
  const status: JobStatus = failed === 0 ? "completed" : "completed_with_errors";
  await ctx.store.setJobStatus(ctx.jobId, status);
  ctx.bus.emit("job.done", { status });
}

/**
 * Job-level precondition failure (empty chain / reference normalization). No
 * Items run; this is the only legitimate `job.done {status:"failed"}` path
 * (architecture §5.1, product-flow §4).
 */
async function failJob(
  store: AsyncStateStore,
  bus: JobEventBus,
  jobId: string,
  code: string,
  message: string,
): Promise<void> {
  await store.setJobStatus(jobId, "failed");
  console.error(JSON.stringify({ level: "error", jobId, code, message }));
  bus.emit("job.done", { status: "failed" });
}
