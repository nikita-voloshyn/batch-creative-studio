# Task 9 Review — Failover engine + partial-failure + degradation

**Date:** 2026-06-27
**Implementer:** backend
**Reviewer:** reviewer (fresh context)
**Scope:** Task 9 — `lib/orchestrator/failover.ts` (new); `lib/orchestrator/orchestrator.ts` (modified: `runFailover` wired into `processItem`, `runProviderAttempts` split out, `failoverToOutcome` / `logFailover` added); `lib/blob/result-store.ts` (modified: `PersistResultArgs.contentType` + prefer-declared).
**Method:** Static analysis by hand-tracing failover scenarios (no tests yet — Task 10 pending). Repo has no git commits; reviewed via `git status --porcelain` + file reads.

---

## Verdict

**Approve.** The failover engine is correct, interface-pure, and boundary-respecting; the per-item chain always terminalizes; only an exhausted chain yields `item.failed`; degradation surfaces end-to-end to the SSE `item.result`; quota pre-switch never strands the last provider; and all four verification gates are green. The two residual gaps are (a) a cross-domain providers-package gap (no style-text extractor for prompt-only fidelity) that is correctly flagged and out of backend's single-writer domain, and (b) a documented MVP trade-off (hold-slot-through-backoff). Neither blocks. The acceptance clause "verified with forced fake-provider failures" is **deferred to Task 10** (no tests exist yet) and was traced by hand instead.

No Critical or High findings.

---

## Findings by severity

### Low

**L-1 — Prompt-only fallback leans on the brief alone; `referenceStyleText` is never threaded (degradation fidelity gap).**
`lib/orchestrator/orchestrator.ts:358-368` builds the prompt per provider and correctly threads `usesImageReference: provider.supportsImageReference`, but leaves `referenceStyleText` unset (the inline comment flags that `normalizeReferences` exposes no style-text extractor seam). When failover lands on a text-only Cloudflare model (`supportsImageReference:false`), `buildPrompt` (`lib/providers/prompt.ts:49-63`) omits both the image-match line and the style-cue line, so the prompt-only post is steered by the brief + aspect guidance only.
This is a **providers-package gap**, not a backend defect: architecture §5c / product-flow §5c make the style-text extractor a providers-owned, once-per-job component that does not yet exist, and the CLAUDE.md single-writer rule bars `backend` from authoring it. The §5c DoD is still met — a real image renders, `usedImageReference:false` is recorded, and the badge surfaces. **Acceptable MVP gap; remains owned by the providers agent (Task-5 N4 / Task-8 carryover).** Style fidelity, not correctness, is reduced.

**L-2 — Hold-slot-through-backoff deviates from the product-flow §6.3 release-and-requeue decision.**
`runWithRetry` (`lib/orchestrator/retry.ts:199-210`) awaits the backoff `sleep` inside the worker, so a retrying item occupies its pool slot during backoff. product-flow §6.3 frames release-slot-and-requeue as a *decision*, so holding the slot technically contradicts it. The orchestrator header (`orchestrator.ts:33-39`) re-accepts hold-through-backoff for the fixed MVP pool (POOL_SIZE=5, N≤20, ATTEMPT_CAP=3, BACKOFF_MAX_MS=8s ⇒ bounded worst-case idle). **Reasonable for the MVP** — release-and-requeue needs a not-before scheduler across the pool, and the durable queue is the real fix (architecture §13). Revisit only if 429-storm throughput proves inadequate. Not a Task 9 regression (pre-existing Task-5 behavior).

### Nit

**N-1 — Orphan-prevention rationale is slightly overstated in the `contentType` comments.**
`result-store.ts:40-45` / `types.ts:50-59` justify the declared-`contentType` preference as preventing a "stale-ext blob" / "orphan" across a Gemini-PNG → Cloudflare-WEBP failover. Tracing the chain, a provider that fails over **never persisted** a result (persist runs only inside a *successful* attempt, which returns `success` and stops the chain — `orchestrator.ts:394-409`), so there is at most **one** successful persist per item and the `{ext}`-in-key can never produce two objects. The real guarantee is one-persist-per-item; the `contentType` fix improves ext / `Content-Type` *accuracy* (so the served header and URL extension match the bytes), which is still worthwhile. Functionally correct — no orphan is possible; the comment just credits the wrong mechanism.

**N-2 — `runWithRetry`'s `acquire` guard maps any throw to `aborted`.**
`retry.ts:157-161` wraps `options.acquire?.(signal)` in `try { … } catch { return abortedOutcome(); }`. Today `acquire` is `TokenBucket.take`, which only rejects with an `AbortError`, so this is safe. A future `acquire` that threw for a non-abort reason would be silently mis-reported as `interrupted` (item failed, no retry/failover). Pre-existing Task-5 code; worth narrowing to abort-only when the limiter grows. No impact today.

**N-3 — `idempotencyKey` omits `providerId` (safe by construction).**
`idempotency.ts:27` keys on `hash(itemId:attemptNumber)`, so Gemini attempt 0 and Cloudflare attempt 0 for the same item share a key. This is harmless: a single item is processed by one worker strictly sequentially through the chain (failover only after a provider fully exhausts), so the two are never concurrent and `dedupe` never coalesces them. Across items the `itemId` differs. No change needed; noted for the record.

---

## Acceptance-criteria check

| # | Acceptance clause | Status | Evidence |
|---|---|---|---|
| 1 | Provider exhaustion fails over | **Met** | `failover.ts:119-123` — `advance` (retry-cap exhausted *or* auth/quota fatal) with `hasNext` ⇒ `onAdvance(exhausted)` + `continue` to next provider. `runWithRetry` surfaces cap-exhaustion as `advance` (`retry.ts:198`). |
| 2 | All-exhausted → `item.failed` | **Met** | `advance` on the last provider (`hasNext` false) ⇒ `failed{reason:"exhausted"}` (`failover.ts:124-130`); mapped to `code:"all_providers_exhausted"` + human cause naming `lastProviderId` (`orchestrator.ts:432-440`). Only an exhausted chain (not `fail_item`, not `aborted`) yields this. |
| 3 | Job aggregates partial failures | **Met** | `aggregateAndFinish` / `finishIfAllTerminal` → `completed` (failed==0) else `completed_with_errors`; never job-level `failed` from items (`orchestrator.ts:523-561`). Whole-job `failed` only via `failJob` on empty-chain / normalization precondition (`orchestrator.ts:568-578`). Matches product-flow §4 / §5e. |
| 4 | Degradation flagged → SSE | **Met** | Winning `GenerateResult.usedImageReference` → `ItemResult` (`orchestrator.ts:407`) → `setItemResult` + `bus.emit("item.result", {…usedImageReference})` (`orchestrator.ts:329-334`) → SSE `frame()` serializes the full payload via `JSON.stringify(event.data)` (`app/api/jobs/[id]/stream/route.ts:43`). `ItemResultEvent.usedImageReference` is on the wire contract (`types.ts:111-116`). |
| 5 | Quota-based pre-switch | **Met** | `shouldPreSwitch` only when `hasNext` (`failover.ts:99`), via `nearDailyQuota(id, dailyCap, softFraction)` (`token-bucket.ts:137-140`, `orchestrator.ts:303-308`). Last provider never pre-switched. Traced near-quota Gemini+Cloudflare → skip Gemini, run Cloudflare; near-quota single/last provider → still tried. |
| 6 | Verified with forced fake-provider failures | **Deferred** | No tests exist yet (Task 10 — `lib/testing/**` fake provider + reliability suite). Verified here by hand-tracing scenarios §5b/§5c/§5d/§5e/§5g. |

### Additional scenario traces (by hand)

- **Outcome routing (the crux).** `success` → return winner (`failover.ts:106-107`); `fail_item` (content_policy/invalid_input) → STOP, `failed{reason:"fail_item"}` keeping the underlying kind as the code (`failover.ts:108-115`, `orchestrator.ts:432-440`) — never fails over; `aborted` → STOP, no failover (`failover.ts:116-118`), mapped to `failed{code:"interrupted"}` (`orchestrator.ts:442-451`); `advance` → next provider or exhausted-fail. Exhaustive `switch` over a TS-exhaustive 3-status union, so every item terminalizes — no hang, no fail-over-on-fail_item, no advance past the last provider.
- **No infinite loop / off-by-one.** `for (i=0; i<chain.length; i++)`; `next=chain[i+1]`, `hasNext = next!==undefined`. Last index `chain.length-1` ⇒ `next` undefined ⇒ `advance` returns exhausted-fail. `continue` always increments `i`. `runWithRetry` bounded by `cap`; `TokenBucket.take` waits a finite `refillPerMs`. All bounded.
- **Engine purity / boundary.** `failover.ts` imports only `RetryOutcome` (type), `ImageProvider` (interface), `ProviderError` (neutral) from the providers barrel — no `lib/providers/**` adapter, no registry, no rate limiter, no result store (`failover.ts:34-36`). The composition root binds `shouldPreSwitch` (rate limiter + `registry.quota`) and `runProvider` (persist + prompt + dedupe). Separation per architecture §4 holds.
- **Retry re-runs full chain.** `retryItem` → `processItem` → `runFailover(ctx.chain, …)` starting at `chain[0]` (`orchestrator.ts:283, 300`). Chain always restarts at provider #1.
- **`{ext}` stability across PNG→WEBP failover.** Only one successful persist per item (advancing providers never persist), so the per-item key is written at most once; `contentType` preference makes that single write's ext + `Content-Type` accurate. `put` options unchanged and correct: `access:"public"`, declared `contentType`, `addRandomSuffix:false`, `allowOverwrite:true`, server `token`, `abortSignal` (`result-store.ts:202-209`). Provider-URL precedence header → declared → sniff (`result-store.ts:164-168`). No orphan.

---

## Verification runs (2026-06-27)

| Command | Result |
|---|---|
| `pnpm exec biome check .` | **Pass** — the wrapped run reported `[warn] Linter process terminated abnormally (possibly out of memory)` (harness/OOM artifact, not a lint failure). Re-run with the raw binary scoped to source: `node ./node_modules/@biomejs/biome/bin/biome check lib app components docs` → `Checked 40 files … No fixes applied.` **EXIT 0**. |
| `pnpm exec tsc --noEmit` | **Pass** — `TypeScript: No errors found`. |
| `pnpm exec vitest run` | **Pass (vacuous)** — `PASS (0) FAIL (0)`. No `.test.ts` files exist yet (Task 10 pending). |
| `pnpm build` | **Pass** — `next build` (Next.js 16.2.9): `Compiled successfully`, `Finished TypeScript`, static pages generated; all 5 API routes built (`/api/jobs`, `/api/jobs/[id]`, `/api/jobs/[id]/items/[itemId]/retry`, `/api/jobs/[id]/stream`, `/api/uploads`). |

---

## Summary

Task 9 correctly turns the single-provider seam into an ordered failover loop over the injected `ImageProvider[]`. The engine is pure (interface + injected hooks only), the per-item path always terminalizes, exhaustion is the sole route to `item.failed` (`all_providers_exhausted` + `lastProviderId` + human cause), `fail_item` and `aborted` correctly stop without failover, partial-failure aggregation stays `completed | completed_with_errors`, degradation flows to the SSE `item.result`, and quota pre-switch never strands the last provider. The `contentType` → result-store fix keeps the per-item key's ext accurate. Residual items (L-1 providers style-text gap, L-2 slot-hold MVP trade-off) are documented and out of this task's blocking scope. **Approve.**
