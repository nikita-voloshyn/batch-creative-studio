---
component: Orchestrator
source: lib/orchestrator/orchestrator.ts
agent: backend
updated: 2026-06-28
---

# Orchestrator

## Purpose
The composition root that drives one Job's full lifecycle: validates the provider chain, normalizes references once, drives the bounded worker pool over queued Items, runs the per-Item failover/retry loop, persists results, emits SSE events, and aggregates to a terminal Job status. It is the single BE module allowed to depend on the providers package (registry/prompt/reference-normalize) and never imports a concrete adapter.

## Public Interface
- `deriveSeed(jobId: string): number` — FNV-1a hash of the jobId masked to a non-negative int32; deterministic per-batch seed used when `Job.seed` is not finite.
- `runJob(jobId: string, deps?: OrchestratorDeps): Promise<void>` — runs a created Job to terminal status, emitting `job.done`. Resolves only after the Job is terminal.
- `retryItem(jobId, itemId, deps?): Promise<void>` — re-drives ONE Item that the retry route already CAS'd `failed → queued`; reuses `processItem` (full chain from provider #1) and re-emits `job.done` if this re-completes the job.
- `type OrchestratorDeps` — injectable singletons: `store`, `registry`, `rateLimiter`, `persist`, `normalize`, `getBus`, `signal`. All optional; default to process-global singletons.

## Inputs and Outputs
- `runJob`: reads the Job from the store; sets Job `running`; on precondition failure (empty chain / bad reference) sets Job `failed` and emits `job.done {status:"failed"}` (the ONLY legitimate job-level failed path). Otherwise processes all `queued`/`running` items via `runPool`, sweeps non-terminal items to `failed(interrupted)`, then aggregates to `completed` or `completed_with_errors`.
- `retryItem`: bails if the item is not `queued`. On context-build failure, terminalizes only that item (never fails the whole job). Otherwise runs `processItem`, then finishes the job if all items are terminal.
- Per-item processing (`processItem`): emits `item.status running`; runs `runFailover` over `ctx.chain`; on success calls `persist` and emits `item.result` (carrying `usedImageReference` from the winning provider); on failure terminalizes with `item.error`. Always emits `job.progress` after.
- Writes to store: `setJobStatus`, `setItemStatus`, `setItemResult`, `setItemError`, `appendAttempt`. Emits SSE events through the per-job bus.
- Never throws from item processing — all item failures are mapped to terminal `failed` Items.

## Dependencies
- `lib/orchestrator/failover.ts` — runs the ordered multi-provider chain loop per item.
- `lib/orchestrator/retry.ts` — per-provider timed retry loop (`runWithRetry`, `RetryOutcome`).
- `lib/orchestrator/worker-pool.ts` — bounded-concurrency drain (`runPool`).
- `lib/orchestrator/event-bus.ts` — per-job SSE event bus (`getJobEventBus`).
- `lib/orchestrator/idempotency.ts` — in-process provider-call de-dup (`dedupe`, `idempotencyKey`).
- `lib/orchestrator/config.ts` — env-driven tunables (pool size, attempt cap, timeouts, backoff, quota soft fraction).
- `lib/providers` — `registry`, `buildPrompt`, `normalizeReferences`, `ImageProvider`, `GenerateInput`, `ProviderError`.
- `lib/ratelimit/token-bucket` — per-provider RPM acquire + best-effort daily quota.
- `lib/blob/result-store` — `persistResult` (per-item key, last-writer-wins).
- `lib/state` — `getStateStore` / `AsyncStateStore`.

## Key Decisions
- Seed masked to non-negative int32 (`& 0x7fffffff`) because some providers (Gemini `generation_config.seed`) 400 on values > 2^31-1.
- Per-item write barrier (`ctx.attemptWrites`): fire-and-forget `appendAttempt` writes are chained per item and drained before the terminal result/error write, closing a Redis lost-update race on the shared `item:{id}` field. No-op on the sync in-memory store.
- `GenerateInput.referenceImageUrls` passes ORIGINAL http(s) Blob URLs (not inlined `data:` URLs) because Pollinations' `image=` param overflows the request URI (HTTP 414) with data URLs; adapters fetch them as inline data themselves.
- `usesImageReference` in the prompt is asserted only when the provider conditions on references AND http reference URLs are actually sent — never merely from `provider.supportsImageReference` — so the prompt never claims a reference that was not sent.
- Result blob `contentType` is threaded from the winning provider's `GenerateResult` so a format-changing failover (Gemini PNG → Cloudflare WEBP) keeps a stable `{ext}`.
- An item HOLDS its pool slot through retry backoff (re-accepted Task-5 L1): release-and-requeue is deferred to the durable-queue full product; worst-case idle is small and bounded for the MVP fixed pool.
- Item aggregation NEVER yields job-level `failed` — a job with failed items is `completed_with_errors`.

## Known Limitations
- `referenceStyleText` is not threaded into prompt-only fallbacks: the providers package exposes no style-text extractor seam yet, so prompt-only fallbacks lean on the brief alone (flagged for the providers agent).
- Retry concurrency race: a retry that runs while the owning `runJob` is still draining can race the end-of-run sweep; convergence relies on last-writer-wins + idempotent client merge. Eliminating it is a durable-queue concern. The dominant case (retry on an already-terminal job) is race-free.
- Provider-call idempotency is in-process only (single-process MVP); the `ImageProvider.generate` contract carries no idempotency-key slot.
