# Review: Task 10 — Fake provider + reliability test suite

- **Date:** 2026-06-28
- **Implementer:** testing
- **Reviewer:** reviewer (fresh context)
- **Task:** 10 — Fake provider + reliability test suite (`docs/plans/batch-creative-studio-mvp-plan.md`)
- **Scope reviewed:** `test/fakes/{fakeProvider,fixtures}.ts`, `test/orchestrator/{retry,failover,orchestrator,idempotency,event-bus}.test.ts`, `test/ratelimit/token-bucket.test.ts`, `test/blob/result-store.test.ts`, `test/providers/{cloudflare,gemini}.test.ts`, `vitest.config.ts`, `package.json`. Code-under-test read for contract fidelity: `lib/orchestrator/{retry,failover,orchestrator}.ts`, `lib/ratelimit/token-bucket.ts`, `lib/blob/result-store.ts`, `lib/providers/{gemini,cloudflare,errors}.ts`.

## Verdict: **Approve**

The suite is genuinely high-value, not false-green. The highest-leverage suites (retry, failover, orchestrator) assert real outputs — provider-advancement order, terminal `all_providers_exhausted` + `lastProviderId`, the exact SSE event sequence, `completed` vs `completed_with_errors` aggregation, single-result idempotency, and the precise capped-exponential-backoff schedule under fake timers. The fake provider implements the real `ImageProvider` contract and its scripted failures flow through the real `runWithRetry`/`runFailover` engine (the orchestrator integration uses the real `runJob`/`retryItem`/`processItem` with injected deps, not a reimplementation). All 106 tests run and pass; coverage matches the claim and is concentrated on the engine; Biome is clean. Boundary respected (only `test/**` + `vitest.config.ts` + `package.json`). The "no production bugs surfaced" report is credible: the production engine is correct and the tests are strong enough to have caught a regression if it weren't. A few defensive paths (orchestrator-level abort sweep, result-store SSRF guard) are uncovered — Low, non-blocking.

## Findings by severity

### Critical
None.

### High
None.

### Medium
None.

### Low

- **L1 — Orchestrator-level abort/interrupt sweep is not integration-tested.** `lib/orchestrator/orchestrator.ts:537-550` (`sweepNonTerminal` → `failed(interrupted)`) is uncovered (coverage flags lines 542-547). No test aborts a `runJob` mid-flight to assert that still-`queued`/`running` items become `failed` with `code:"interrupted"` and `job.done` still fires. The engine primitives *are* covered — `retry.test.ts:208-233` asserts the `aborted` outcome (pre-abort and abort-during-backoff) and `failover.test.ts:149-161` asserts an `aborted` outcome stops the chain — but the orchestrator's whole-job sweep path is not exercised end-to-end. Add one `runJob` test with `deps.signal` aborted after first item to close this.

- **L2 — `result-store.ts` SSRF guard is not negatively tested.** The provider-URL re-persist path test (`test/blob/result-store.test.ts:119-136`) only uses a benign `https` URL; `isBlockedHost` and the protocol check (`lib/blob/result-store.ts:113-131,145-149`) are uncovered. No assertion that a blocked host (`localhost`, `127.0.0.1`, `169.254.169.254`, `metadata.google.internal`) or a non-`https` URL is rejected. This is a security-relevant branch in a reliability-core file the suite claims to cover. (SSRF is primarily Task 12's domain, so this is a coverage gap, not a defect.) Add 2 negative-path tests asserting `persistResult` rejects a blocked/non-https provider URL.

### Info

- **N1 — Fake provider location differs from an older doc note.** `docs/product-flow.md` line 36 places the fake under `lib/testing/**`; it actually lives under `test/fakes/`. This matches the Task 10 dispatch (`test/fakes/{fakeProvider,fixtures}.ts`) and is cleaner (test-only code under `test/`). No action — the dispatch is authoritative.
- **N2 — `processItem` internal-error catch (`orchestrator.ts:313-322`) and `runPool.onUnexpectedError` (`worker-pool.ts:47`) are defensive paths left uncovered.** Acceptable for MVP — these only fire on a true engine bug.

## Test-quality assessment (would these catch a regression?)

Yes. Spot-checked 10 specific tests against the production contract; each would fail if the logic were wrong:

| # | Test (file:line) | Asserts (real, not tautological) | Would fail if… |
|---|---|---|---|
| 1 | `retry.test.ts:60` retries to cap then advance | `fn` called 4× and delays `times[1]-times[0]==500`, `1000`, `2000` on the faked clock | backoff schedule or cap-exhaustion→`advance` broke |
| 2 | `retry.test.ts:79` caps backoff | deltas `1000,1500,1500` with base 1000 / max 1500 | `Math.min(maxMs, base*2^n)` cap removed |
| 3 | `retry.test.ts:119` honors `retryAfterMs` | delta `5000` (server) over local `500` | server-suggested delay override dropped |
| 4 | `failover.test.ts:110` all-exhausted | `status:failed`, `reason:exhausted`, `lastProviderId:replicate`, `error.kind:quota_exhausted`, `runCalls==[gemini,cloudflare,replicate]` | advancement order or last-provider id wrong |
| 5 | `failover.test.ts:179` never pre-switch the last | `runCalls==[cloudflare]` (gemini skipped, last hope still run) | last-provider-never-skipped invariant broke |
| 6 | `orchestrator.test.ts:92` happy-path sequence | event names `[item.status,item.result,job.progress,job.done]` + each payload + persist key `results/job-happy/{itemId}.png` | SSE ordering, payload shape, or per-item key changed |
| 7 | `orchestrator.test.ts:150` all-providers-exhausted | `item.error{code:all_providers_exhausted, lastProviderId:cloudflare}`, `job.done{completed_with_errors}`, `persistKeys==[]` | exhaustion code/lastProvider or "no persist on failure" broke |
| 8 | `orchestrator.test.ts:216` partial-failure aggregation | item statuses `[succeeded,succeeded,failed]`, 2× `item.result`, 1× `item.error`, `job.progress{done:2,failed:1,total:3}`, `completed_with_errors` | aggregation rule or progress counting wrong |
| 9 | `orchestrator.test.ts:318` idempotent retry | one stable key `results/job-retry/{itemId}.png`, `new Set(keys).size==1`, re-emitted `job.done{completed}` | last-writer-wins / duplicate-result regression |
| 10 | `cloudflare.test.ts:137` HTTP→kind table | 429→rate_limit, 401/403→auth, 408→timeout, 503→unavailable, 500→server, 400→invalid_input, daily-429→quota_exhausted, safety-400/nsfw-422→content_policy, with `httpStatus`+`providerId` | error-kind mapping or body-refinement broke |

Honesty checks:
- **Fake provider is honest** (`test/fakes/fakeProvider.ts:73-125`): implements the real `ImageProvider` (`id`, `supportsImageReference`, `generate(input, signal)` from `@/lib/providers/types`); scripted `error`/`abort`/`empty`/`success` behaviors throw the real `ProviderError` and flow through `runWithRetry`/`runFailover`. The `empty` behavior returns a zero-byte image that the *real* orchestrator result-validation (`orchestrator.ts:385-392`) rejects as retryable — verified end-to-end in `orchestrator.test.ts:201`.
- **Integration uses the real engine** (`orchestrator.test.ts:22`): imports `runJob`/`retryItem` from `@/lib/orchestrator/orchestrator`; deps inject a fake registry/store/rate-limiter/bus/persist but the chain loop, retry loop, aggregation and event emission are production code.
- **Fake timers, no real waiting** (`retry.test.ts`, `token-bucket.test.ts`): `vi.useFakeTimers()` + `advanceTimersByTimeAsync`, `Math.random` pinned (0 / 0.5); backoff deltas measured on the faked `Date` clock. Full run is 518 ms. Integration tests set `ATTEMPT_CAP=1` so they advance without sleeping — backoff is asserted only in the dedicated timer suite, the correct division.
- **Not over-mocked:** `failover.test.ts` stubs `runProvider` to unit-test chain-advancement policy *in isolation*, while `orchestrator.test.ts` exercises the same seam integrated through the real `runProviderAttempts`→`runWithRetry`→`classifyKind` path. The seam is covered both ways.

## Acceptance-criteria check

| Acceptance criterion (Task 10) | Status | Evidence |
|---|---|---|
| Deterministic reliability tests pass | ✅ | 106/106 pass in 518 ms; `Math.random` pinned + fake timers; no real waiting/network |
| `pnpm exec vitest run` green | ✅ | `Test Files 9 passed (9) · Tests 106 passed (106)` |
| Reliability core covered | ✅ | retry / failover / orchestrator / token-bucket / result-store / gemini / cloudflare all exercised; coverage concentrated on engine (failover 90.5% stmts/100% branch/100% funcs; retry 89.6%/84.2%/100%; token-bucket 93%/95.2%; orchestrator 82.9%) |
| Fake provider (timeout/429/fatal/empty-200/slow) | ✅ | `fakeProvider.ts` `error`(any kind)/`abort`/`empty`/`success` script; consumed per-attempt; honest `ImageProvider` |
| Unit: retry (backoff/jitter, classification) | ✅ | `retry.test.ts` 20 tests — schedule, cap, jitter, retryAfter, 3-way classify, abort, attempt records, acquire gate |
| Unit: failover (chain/exhaustion) | ✅ | `failover.test.ts` 9 tests — advance, degradation, exhausted, fail_item, aborted, quota pre-switch, empty chain |
| Unit: adapter mappers | ✅ | `cloudflare.test.ts`/`gemini.test.ts` — request shaping + response decode + full HTTP-status→kind table + retry-after parse |
| Integration: jobs → stream → terminal states | ✅ | `orchestrator.test.ts` 13 tests — exact SSE sequence, failover, degradation, exhausted, content-policy, empty-200, partial aggregation, concurrency, precondition `failed`, idempotent retry |
| Boundary test | ✅ | `orchestrator.test.ts:287-316` (whole-job `failed` only on precondition) + idempotency/event-bus suites guard the engine boundary; only `test/**`+`vitest.config.ts`+`package.json` changed |

## Boundary compliance

Repo has no git commits; verified via file inspection + `git status --porcelain` (all files untracked). Changes match the Task 10 declaration exactly:
- New: `test/fakes/{fakeProvider,fixtures}.ts`, `test/orchestrator/{retry,failover,orchestrator,idempotency,event-bus}.test.ts`, `test/ratelimit/token-bucket.test.ts`, `test/blob/result-store.test.ts`, `test/providers/{cloudflare,gemini}.test.ts`.
- Edited: `vitest.config.ts` (`@` alias mirroring tsconfig + V8 coverage `include` aimed at the reliability core), `package.json` (devDep `@vitest/coverage-v8@4.1.9`).
- No production source touched — every `lib/**` non-test file read carries its original backend/providers component header and is consumed (not modified) by tests; no `app/**` or `components/**` changes.

## Verification runs

```text
$ pnpm exec vitest run
 RUN  v4.1.9 /Users/volosyn.nikita/dev/batch-creative-studio
 Test Files  9 passed (9)
      Tests  106 passed (106)
   Duration  518ms
```

```text
$ pnpm exec vitest run --coverage
 Test Files  9 passed (9)
      Tests  106 passed (106)
------------------|---------|----------|---------|---------|
File              | % Stmts | % Branch | % Funcs | % Lines |
------------------|---------|----------|---------|---------|
All files         |   84.05 |    68.38 |   94.73 |   86.76 |
 blob             |   70.58 |    63.21 |     100 |   78.33 |
  result-store.ts |   70.58 |    63.21 |     100 |   78.33 |
 orchestrator     |   87.22 |    69.35 |   95.45 |   89.53 |
  config.ts       |   82.35 |    52.94 |   88.88 |      80 |
  failover.ts     |   90.47 |      100 |     100 |      90 |
  orchestrator.ts |   82.87 |     59.8 |    93.1 |   86.82 |
  retry.ts        |   89.55 |    84.21 |     100 |      90 |
  worker-pool.ts  |   83.33 |    71.42 |     100 |   92.85 |
 providers        |   81.48 |    68.39 |   96.96 |   83.24 |
  cloudflare.ts   |   85.04 |    66.27 |   93.75 |   87.12 |
  errors.ts       |   74.28 |    72.72 |     100 |      68 |
  gemini.ts       |   79.72 |    69.09 |     100 |   83.07 |
 ratelimit        |   92.98 |    95.23 |   93.33 |   92.72 |
  token-bucket.ts |   92.98 |    95.23 |   93.33 |   92.72 |
 state            |   83.33 |       50 |   84.61 |   89.65 |
------------------|---------|----------|---------|---------|
Statements : 84.05% (580/690)   Functions : 94.73% (126/133)
```
Coverage claim (84% stmts / 94.7% funcs) is accurate and **not inflated** — the V8 `include` glob targets exactly the reliability core + the two tested adapters; UI/route files are excluded by design (route HTTP e2e is Task 13). The engine files (failover/retry/token-bucket) carry the highest numbers.

```text
$ pnpm exec biome check .   (raw binary)
Checked 62 files in 53ms. No fixes applied.   (exit 0)
```

```text
$ grep -rnE '\.(skip|only|todo)|expect\(true\)|xit\(|xdescribe\(' test/
NO_FORBIDDEN_PATTERNS_FOUND
```
No `.skip`/`.only`/`.todo`, no always-passing assertions, no disabled suites. All 106 tests execute.
