# Review: Task 5 — Orchestrator + retry engine + state

- **Date:** 2026-06-27
- **Implementer:** backend
- **Reviewer:** reviewer (fresh context)
- **Plan / Dispatch:** `batch-creative-studio-mvp-plan.md` (Task 5) · `batch-creative-studio-mvp-dispatch.md` (Group 3, In Progress)
- **Scope reviewed (read-only; no source edited):**
  - `lib/state/store.ts`
  - `lib/orchestrator/{config,retry,worker-pool,idempotency,event-bus,orchestrator}.ts`
  - `lib/ratelimit/token-bucket.ts`
  - `lib/blob/result-store.ts`
  - `.env.example` (orchestration tunables)
  - Consumed contracts (not modified by this task): `lib/types.ts`, `lib/providers/{types,errors,registry,config,prompt,reference-normalize,index}.ts`
  - Verified `put()` options against installed `node_modules/@vercel/blob@2.5.0` type defs (`dist/index.d.ts`, `dist/create-folder-DFjrvss1.d.ts`).

> Repo has **no git commits** — scope was established via `git status --porcelain` + reading files, per the dispatch note. No `lib/providers/**` adapter internals, `components/**`, `lib/client/**`, or `*.test.ts` were touched by this task.

---

## Verdict

**Approve.** This is a careful, contract-faithful implementation of the reliability core. The retry classification, attempt-cap→advance handoff, per-attempt timeout/abort composition, un-timed rate gate ordering, token-bucket math, idempotency/result-key semantics, the Terminal-invariant guarantees (timeouts + cap + sweep + abort), event-bus monotonic ids, and the Task-9 DI seam are all correct under hand-traced failure scenarios. `tsc`, raw Biome, Vitest (passWithNoTests), and `next build` are all green. No Critical or High findings. The remaining items are Low/Nit MVP-acceptable deviations (most are documented forward-dependencies for Task 9). The two implementer flags are both acceptable for MVP — see Findings L1 (flag 2) and the Acceptance table (flag 1).

---

## Findings by severity

### Critical — none.

### High — none.

### Medium — none.

### Low

**L1 — Pool slot is held during retry backoff (implementer flag 2; deviates from product-flow §6.3).**
`lib/orchestrator/orchestrator.ts:196`–`320` runs the *entire* `runWithRetry` loop — including `sleep(delay)` backoff (`retry.ts:206`) — inside the single `runPool` worker slot. product-flow §6.3 / §6.4 specify *release-and-requeue* on backoff ("while an item is in retry backoff, it releases its pool slot and rate token and re-queues"). The implementation holds the slot through the sleep.
- **Why it is acceptable at Task-5 scope:** there is only one provider in play (`processWithProvider(ctx, item, ctx.chain[0])`), and the per-provider **token bucket is the binding throughput constraint** (Gemini ~10 RPM ≪ POOL_SIZE×anything). The rate token is *not* held across backoff (it is a one-shot `take()` re-acquired per attempt), so a backing-off item does not pin a token. Steady-state throughput is therefore still RPM-bounded, not slot-bounded, and there is no deadlock/starvation. Worst-case 429-storm trace (N=20, POOL_SIZE=5, fast-failing 429s + ≤8 s backoff) drains in tens of seconds.
- **Where it starts to matter:** Task 9 (failover). Once an item can fail over to a *different* provider's budget, a sibling backing off on provider A while holding a slot can delay an item that could make progress on provider B. **Recommend the release-and-requeue behavior be implemented when Task 9 lands**, or explicitly re-accepted there. Honestly flagged by the implementer; not a Task-5 blocker.

**L2 — Result key `{ext}` is content-type-derived, so a format change across a *winning* retry/failover can orphan the prior blob.**
`lib/blob/result-store.ts:171`–`172` builds `results/{jobId}/{itemId}.{ext}` with `{ext}` sniffed from the *current* result's content-type. The "exactly one result object, no orphans, last-writer-wins" guarantee (decisions.md 2026-06-26, architecture §5.5) holds only while the ext is stable. If attempt N persists a PNG (`.png`) and a later winning attempt persists a WEBP (`.webp`), the two live at different keys → the first is orphaned. **Does not manifest in Task 5** (single provider returns a consistent format), but Gemini→Cloudflare failover (Task 9) can change format. This is a latent tension in the documented design itself (the spec specifies both ext-from-content-type *and* zero orphans). Low; surfaces in Task 9.

**L3 — Backoff jitter is additive (≤ base), not "full jitter"; the code comment is inaccurate.**
`lib/orchestrator/retry.ts:110`–`111`: `jitter = Math.random() * baseMs` added to the (capped) exponential term, commented `// full jitter`. True full jitter is `random() × min(cap, base·2^attempt)` (uniform over the whole window). The implemented additive jitter is bounded by `base` (500 ms), so at large backoffs (toward the 8 s cap) the randomization is small and decorrelation across the pool is weak. The math otherwise matches the architecture §5.3 written formula `min(MAX, base·2^attempt) + jitter` exactly, and at single-provider + POOL_SIZE 5 + RPM gating the retry-storm risk is negligible. Low/Nit — consider relabeling the comment and (optionally) widening jitter.

### Nit

**N1 — Orchestrator imports the `@/lib/providers` barrel, which re-exports `createGeminiProvider`.**
`orchestrator.ts:43`–`51` imports from the package barrel (`@/lib/providers`). The barrel (`lib/providers/index.ts:11`) re-exports `createGeminiProvider`, so the concrete adapter is in the orchestrator's *transitive* module graph. This is **not** a boundary violation: (a) `createGeminiProvider` is never named in the orchestrator's import list (confirmed — it imports `registry`, `buildPrompt`, `normalizeReferences`, `ProviderError`, and types only); (b) the grep-able boundary rule ("`lib/orchestrator/**` importing `lib/providers/gemini`") passes — verified; (c) the composition root is explicitly allowed to import `registry.ts`, which *already* pulls `createGeminiProvider` by design. Tightening to per-module imports would shrink the surface, but there is no real leak. The failover **engine** (`failover.ts`, Task 9) is the module that must import the interface only — not yet present, so nothing to check here.

**N2 — Rare abort-on-last-attempt-timeout yields `code:"timeout"`/advance→failed rather than `interrupted`.**
`retry.ts:176` distinguishes job-abort from attempt-timeout via `signal?.aborted && !timeoutSignal.aborted`. If the job signal and the per-attempt timeout fire in the same tick *on the final attempt*, the branch is skipped, the error classifies `timeout`→retry, `isLastAttempt` returns `advance`, and (single provider) the item terminalizes as `failed` with `code:"timeout"` instead of `"interrupted"`. Cosmetic only — the item still reaches a terminal state (Terminal invariant intact); the abort sweeper and the `sleep`-guard catch every other abort timing. Nit.

**N3 — `onUnexpectedError` terminalizes without an accompanying `job.progress`.**
`orchestrator.ts:167`–`178`: the defensive worker-throw path calls `terminalizeFailed` (emits `item.error`) but not `emitProgress`. `processItem` is designed never to throw (it catches its own errors at `:201`–`212`), so this path should be unreachable; if it ever fires, the per-item progress increment is skipped but `aggregateAndFinish` still computes correct final counts. Self-healing; Nit.

**N4 — `referenceStyleText` is not threaded into `buildPrompt`.**
`orchestrator.ts:242`–`247` calls `buildPrompt` without `referenceStyleText`. The style-text extractor (architecture §5c, product-flow §5c) is a providers-owned module that **does not exist yet** (`lib/providers/index.ts` exports no extractor; `reference-normalize.ts` does not produce style text). For Task 5's primary provider (`supportsImageReference=true`) image conditioning is used, so style text is unused. It becomes load-bearing for prompt-only fallback (Cloudflare schnell/SDXL) in Task 8/9. Correctly omitted now (no phantom dependency); flagged as a forward wiring requirement for Task 9. Informational/Nit.

---

## Traced-scenario notes (the load-bearing checks)

- **Retry classification (`retry.ts:37`–`51`).** `rate_limit|server|timeout|unavailable→retry`, `auth|quota_exhausted→advance`, `content_policy|invalid_input→fail_item` — exact match to architecture §5.3 / product-flow §0 / `errors.ts`. Policy lives in `retry.ts`; providers carry only neutral `kind`. ✓
- **Attempt-cap → advance (no off-by-one).** cap=3 ⇒ loop `attemptNumber ∈ {0,1,2}`. On attempt 2 a retryable error hits `isLastAttempt (2≥2)` → returns `{status:"advance"}` (`retry.ts:189`,`198`). Exactly 3 attempts, then failover-eligible advance. Matches "1 initial + 2 retries". ✓
- **Per-attempt timeout.** `AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)` composed with the job signal via `AbortSignal.any` (`retry.ts:165`–`166`); a timeout maps to `kind:"timeout"`→retry (`toProviderError:127`–`130`). `retryAfterMs` honored in full beyond the local cap (`retry.ts:114`). ✓
- **Un-timed rate gate ordering.** `acquire(signal)` awaited *before* the timed attempt (`retry.ts:158`), so RPM waits never burn the provider timeout — matches product-flow §6. ✓
- **Token bucket.** `capacity=max(1,rpm)`, `refillPerMs=capacity/60000` (`token-bucket.ts:104`). For rpm=10 ⇒ 1 token / 6 s = 10/min, burst up to 10. `take()` loops refill→decrement synchronously (no await between), so single-threaded JS makes it race-free; no deadlock (waitMs≥10). ✓
- **Idempotency + result key.** `idempotencyKey = sha256(itemId:attemptNumber)`; `dedupe` coalesces concurrent identical deliveries and clears on settle (no leak). Result via `put(results/{jobId}/{itemId}.{ext}, …, {addRandomSuffix:false, allowOverwrite:true})` — last-writer-wins, no random suffix. `item.result.imageUrl` is set only *after* `persistResult` resolves (`orchestrator.ts:273`–`283`,`214`–`221`). All four `put` options + `Buffer` body + `access:"public"` validated against the v2.5.0 type defs. ✓
- **Terminal invariant.** Every item path terminalizes: success/fail in `processItem`; in-flight aborts → `aborted`→`failed(interrupted)`; never-started queued items → `sweepNonTerminal`. `runPool` awaits in-flight workers before resolving (abort stops *new* pulls only), then sweep, then `aggregateAndFinish` always emits `job.done`. Job `failed` only on empty-chain / reference-normalization precondition (`failJob`); item aggregation yields only `completed | completed_with_errors`. ✓
- **Event bus.** Monotonic per-job `id`, 2000-event ring buffer (ample for N≤20), `replaySince(afterId)` for Last-Event-ID, subscriber throws isolated. `job.progress` after every terminal transition (last item's progress = final counts); `job.done` once per `runJob`. No lost/double emit on traced paths. ✓
- **DI seam.** `runJob(jobId, OrchestratorDeps)` injects `store/registry/rateLimiter/persist/normalize/getBus/signal`; `processWithProvider(ctx, item, chain[0])` is the documented single-provider unit Task 9 wraps in a chain loop. Single-writer holds — all Job/Item/Attempt mutations go through `stateStore` methods; the orchestrator only reads live objects. ✓

---

## Acceptance-criteria check

| Task 5 acceptance criterion | Status | Evidence |
|---|---|---|
| Consumes the `ImageProvider` registry | ✅ | `runJob` resolves `registry.chain()` (`orchestrator.ts:132`), injects it, and calls `provider.generate(input, signal)` via `processWithProvider`. Registry is the DI seam; engine never names a concrete adapter. |
| Processes N items concurrently with retries | ✅ | `runPool(pending, poolSize(), …)` bounded at POOL_SIZE; each item runs `runWithRetry` (backoff+jitter, cap, timeout). Isolation verified — one slow/failing item never blocks siblings (`worker-pool.ts:36`–`50`). |
| Terminal invariant holds within one function lifetime | ✅ | Per-attempt timeouts + attempt cap + abort-aware `acquire`/`sleep`/`generate` + `sweepNonTerminal` + always-emitted `job.done`. Hand-traced happy/retry/exhaust/abort paths all terminalize. |
| Unit-testable with a fake provider | ✅ | `OrchestratorDeps` injects every collaborator; `deriveSeed`, `classifyKind`, `runWithRetry`, `runPool`, `TokenBucket`, `JobEventBus`, `idempotencyKey`/`dedupe` are exported and independently testable; `createMemoryStateStore()` / `ProviderRateLimiter.reset()` give isolation. |
| Implementer flag 1 (idempotency at orchestration layer, not threaded to provider HTTP body) | ✅ Accepted | The providers-owned `ImageProvider.generate` / `GenerateInput` contract has **no** idempotency-key slot; pushing the key would require a providers-package contract change (out of this task's boundary). In-process `dedupe()` is an honest MVP realization of "redelivered identical attempt never produces a second result" for the single-process model. Documented in `idempotency.ts`. |
| Implementer flag 2 (slot held during backoff vs §6.3 release-and-requeue) | ⚠️ Accepted for MVP | See Finding **L1** — acceptable at single-provider Task-5 scope (token bucket is the binding limiter; no deadlock/starvation); recommend implementing release-and-requeue at Task 9. |
| Boundary compliance | ✅ | Grep confirms no `lib/providers/{gemini,cloudflare,replicate}`, `lib/client`, `components/`, or `.test` imports in Task-5 BE files. `createGeminiProvider` is **not** imported by the orchestrator (barrel re-export only — Nit N1). `retry.ts` importing `lib/providers/errors` is the architecture-sanctioned neutral-facts dependency. |

---

## Verification runs (re-run by reviewer)

| Command | Result |
|---|---|
| `pnpm exec tsc --noEmit` | **PASS** — `TypeScript: No errors found` |
| `./node_modules/.bin/biome check .` (raw binary; `pnpm exec biome check .` was intercepted by the rtk proxy and reported a spurious abnormal-termination warning) | **PASS** — `Checked 36 files in 38ms. No fixes applied.` exit 0 |
| `pnpm exec vitest run` (`./node_modules/.bin/vitest run`) | **PASS** — `No test files found, exiting with code 0` (`passWithNoTests`; suite + fake provider arrive in Task 10) |
| `pnpm build` (`./node_modules/.bin/next build`) | **PASS** — `✓ Compiled successfully`, `Finished TypeScript`, routes `/`, `/_not-found`, `ƒ /api/uploads` generated |

All four quality gates green.
