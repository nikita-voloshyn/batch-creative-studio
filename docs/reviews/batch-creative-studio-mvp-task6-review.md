# Task 6 Review — Job API + SSE server stream

- **Date:** 2026-06-27
- **Implementer:** backend
- **Reviewer:** reviewer (fresh context)
- **Task:** 6 — `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs/:id/stream`, `POST /api/jobs/:id/items/:itemId/retry`, plus `lib/api/ssrf.ts` / `rate-limit.ts` / `job-idempotency.ts`; orchestrator edits (`buildContext`/`retryItem`/`finishIfAllTerminal`/`emitProgressDirect`) and `.env.example`.
- **Acceptance:** "Endpoints match architecture §7 contracts; SSE streams progressive events; reconnect via Last-Event-ID + snapshot."

## Verdict

**Approve** (ship). No Critical or High findings. The highest-risk areas — the SSE `Last-Event-ID` replay→subscribe race and the SSRF guard — are both correct. One **Medium** doc/behavior contradiction (retry `409` vs `200`) should be reconciled before Task 7 (frontend) consumes the retry contract; the rest are Low/Nit and largely accepted MVP trade-offs.

---

## Findings by severity

### Medium

**M1 — Retry `409`-vs-`200` is a real doc contradiction, and the implementation is non-deterministic under double-click.**
`app/api/jobs/[id]/items/[itemId]/retry/route.ts:42-54`.
- architecture §7.2 / C11: `409 if item not in failed` (409 *is* the dedup guard).
- product-flow §5p / §3 transition table / §8: a retry on an item already `queued|running|succeeded` is a **no-op that still returns `200 { ok:true }`**; DoD §5p: "the response is **always** `200 { ok: true }`."

These genuinely conflict. The implementation follows architecture §7.2: it returns `409` when `item.status !== "failed"` (line 42-47), but returns `200` on the narrow CAS-lost path (line 51-54). Trace a double-click on a `failed` item:
- if request B's status read (line 42) lands **before** A's CAS → B sees `failed`, CAS loses → **`200`** (line 53);
- if B's read lands **after** A's CAS → B sees `queued` → **`409`** (line 42).

So the same double-click returns `200` or `409` depending on micro-timing — the worst of both contracts. No duplicate work is ever spawned (the "no duplicate processing" invariant holds), so this is a contract/UX defect, not a data bug. **Which is right:** product-flow defers to architecture on *contracts* ("Where … Architecture define a contract … this doc treats it as authoritative"), and `lib/types.ts`/§7 is the named contract authority — so `409` is the nominally-correct choice and the implementation followed it. But product-flow §5p's always-`200` idempotent design is the better double-click UX and is the doc Task 7 will read. **Recommendation:** pick one and align docs + code before Task 7: either (a) keep `409` and amend product-flow §5p to say "409 for a non-`failed` item" (and make the CAS-lost path also `409`/`200` consistently), or (b) make the route return `200 {ok:true}` for any non-`failed` item and amend architecture §7.2. Flag for developer decision.

### Low

**L1 — SSRF allowlist is broader than "the app's own bucket" (architecture §9 intent).** `lib/api/ssrf.ts:25,43-50`. The default allowlist is the generic suffix `.public.blob.vercel-storage.com`, which accepts **any** Vercel Blob store's public host, not just this app's bucket ("they must have come from `/api/uploads`", §9). The destination is still a public CDN host (no private/internal/metadata reach — that is solidly blocked), so this is not an exploitable SSRF, only a looser-than-documented trust boundary. Mitigation already exists: pin `BLOB_ALLOWED_HOST_SUFFIXES` to the specific store host (e.g. `<storeId>.public.blob.vercel-storage.com`) in production. Worth documenting as the recommended prod setting.

**L2 — `isBlockedHost` defense-in-depth has known gaps (currently moot, fragile if the allowlist loosens).** `lib/api/ssrf.ts:58-79`. The private-range check only recognizes dotted-decimal IPv4 and a few IPv6 prefixes. It does **not** catch: octal (`0177.0.0.1`), hex (`0x7f.1`), decimal-integer (`2130706433` = 127.0.0.1), or IPv4-mapped IPv6 (`::ffff:169.254.169.254`). These all bypass `isBlockedHost`. Today this is **harmless** because the allowlist gate (`isAllowedBlobHost`) rejects every host that is not `*.public.blob.vercel-storage.com`, so no IP literal ever reaches a fetch. But the module's own comment claims it "survives a looser allowlist" — it does not fully. If `BLOB_ALLOWED_HOST_SUFFIXES` is ever widened, these gaps become live SSRF. Recommend normalizing the host (or relying on a parse-and-canonicalize step) if the block is ever to be load-bearing, and softening the comment.

**L3 — No length/size caps on `params.brief` and `perImageHints` values.** `app/api/jobs/route.ts:83-103`. `brief` and each hint value are accepted as arbitrary-length strings and held in the in-memory store; a single client could submit multi-MB strings to inflate per-job memory. Bounded in practice by the per-IP rate limit and single-user scope, so Low. A simple max-length guard would close it.

**L4 — `clientIp` trusts `x-forwarded-for` leftmost token.** `lib/api/rate-limit.ts:58-67`. Off-platform (or behind a misconfigured proxy) a client can spoof `x-forwarded-for` to evade the per-IP bucket. On Vercel the platform sets this header authoritatively, so acceptable for the documented deploy target; note it as a deploy assumption.

**L5 — Documented retry-vs-sweep race (accepted MVP).** `lib/orchestrator/orchestrator.ts:228-233`. A targeted retry that runs while the owning `runJob` is still draining can be clobbered by `sweepNonTerminal`. The implementer flags it; the dominant case (retry on an already-terminal job) is race-free. Last-writer-wins + idempotent client merge keep state convergent. No action for MVP.

### Nit

**N1 — Unbounded in-memory maps (accepted MVP leak).** `startedJobs` (stream/route.ts:39) is never cleared; `getJobEventBus` buses (event-bus.ts:96) are never `delete`d by the stream route; `job-idempotency`/`rate-limit` maps prune lazily/never. For single-user MVP this is negligible, and *not* deleting the bus is arguably required for the retry-reopen feature (replay must survive `job.done`). Note only.

**N2 — `Connection: keep-alive` response header** (stream/route.ts:163) is a forbidden/ignored header under HTTP/2 on Vercel. Harmless; matches architecture §6.1's listed headers.

**N3 — `retryItem` re-drive gets no `AbortSignal`.** `retry/route.ts:64-66` calls `retryItem(jobId, itemId)` with default deps, so the re-drive has no external abort (only per-attempt `ATTEMPT_TIMEOUT_MS` bounds it). Same hard-kill exposure as `runJob`; acceptable MVP. Per-item path still terminalizes the item on completion.

---

## What-to-check trace results

**1. SSE correctness — CORRECT.** `stream/route.ts` returns a `ReadableStream<Uint8Array>` with `Content-Type: text/event-stream`; frames are `id: <n>\nevent: <name>\ndata: <json>\n\n` (line 42-44) — correct framing, heartbeat is an SSE comment `: heartbeat\n\n` (line 152).
- **Exactly-once start:** process-global `startedJobs` set; `!startedJobs.has(jobId)` → `add` → emit initial `job.progress{0,0,N}` → `void runJob(..., {signal})` (line 118-131). `start()` runs synchronously through `add` before any `await`, and the streams spec invokes `start` synchronously during `new ReadableStream`, so two concurrent opens cannot both start the run. Reconnecting/concurrent streams skip the block and only subscribe+replay. **Correct.**
- **Last-Event-ID replay→subscribe, no await gap:** the manual `bus.replaySince(lastSeenId)` loop (137-140), the `liveCursor = bus.lastEventId` capture (146), and `bus.subscribe(handler, liveCursor)` (147-150) are **adjacent synchronous statements** — no `await` between. `void runJob` suspends at `await buildContext → await normalize` emitting nothing synchronously beyond the handler's own initial progress, so no live event interleaves. `subscribe(sinceId=liveCursor)` replays `id>liveCursor` = empty, so **no duplicate, no loss, no gap.** **Correct.**
- **Initial `job.progress{0,0,N}` once:** emitted only inside the start guard (line 120); the starter then replays it once from the buffer; reconnects skip the emit and get it from replay. **No double-send.**
- **Cleanup on abort:** `cleanup()` clears heartbeat, unsubscribes, removes the abort listener, closes the controller, guarded by `closed` (line 77-88); wired to `request.signal` abort (108-112) and the stream's `cancel` (154). `request.signal` is passed to `runJob` (121) for the graceful sweep. **Correct.**
- **Reconnect mid-job preserves results:** `replaySince(lastSeenId)` re-delivers missed `item.result`/`item.error`/`job.progress`; the ring buffer (2000) covers an N≤20 batch; already-shown events (`id ≤ lastSeenId`) are skipped. Terminal-already case short-circuits via `terminalReplayed` (139-144). **Correct.**

**2. SSRF guard — CORRECT / robust.** `lib/api/ssrf.ts`: `https:` only (URL normalizes uppercase scheme), rejects embedded credentials (`username`/`password`), strict host allowlist `*.public.blob.vercel-storage.com`, plus a private/loopback/link-local/ULA/CGNAT/metadata block as defense-in-depth. Pure/synchronous — **no fetch, so no redirect SSRF.** Applied to **every** entry of `productImageUrls` and `referenceImageUrls` in `POST /api/jobs` (route.ts:151-158) before the Job is created and before any adapter sees a URL. Bypass attempts (octal/hex/decimal-int IP, trailing-dot host, IPv4-mapped IPv6, userinfo `@`, uppercase scheme) are all **rejected by the allowlist gate** (none end with the Blob suffix) — see L1/L2 for the defense-in-depth caveats, which are not currently exploitable.

**3. Rate-limit + idempotency — CORRECT.** Per-IP token bucket (rate-limit.ts), `429` + `Retry-After` (route.ts:122-127). `Idempotency-Key` → same `{jobId}`: a pre-validation lookup (132-134) and a **re-check immediately before the synchronous create** (163-166); the re-check → `createJob` → `rememberIdempotentJob` block has **no `await`** (163-187), so it is atomic in single-threaded JS — no double-mint on double-click. `Job.seed = deriveSeed(jobId)` set (180); `perImageHints` carried on `Job.params` (181), **no `Item.captionHint`**. Returns `201 {jobId}` and does **not** start `runJob`.

**4. Targeted retry — CORRECT (modulo M1 status code).** `casItemStatus("failed","queued")` is atomic and dedups double-click (retry/route.ts:50-54); `404` (job/item unknown), `409` (non-`failed`) paths present. Re-drives via `retryItem → processItem` (so Task 9 failover auto-applies). Re-emits `item.status{queued}` immediately, then `item.*`/`job.progress`, and `finishIfAllTerminal` re-emits `job.done` on re-aggregation (orchestrator.ts:457-468). Re-opens a terminal job to `running` (58) so a snapshot taken right after reflects it.

**5. Orchestrator edits + seam — INTACT.** `processItem` still calls `processWithProvider(ctx, item, ctx.chain[0])` exactly **once** (orchestrator.ts:284) — no cross-provider failover loop (that is Task 9). The added `buildContext`/`retryItem`/`finishIfAllTerminal`/`emitProgressDirect` are pure extraction/aggregation/emit helpers and do not touch the seam. All Job/Item mutations go through the store (single-writer preserved); the retry route's direct `casItemStatus`/`setJobStatus` calls are the architecture-§7.2/C11-sanctioned route responsibility, still mediated by the store.

**6. Boundary compliance — CLEAN.** Changes are confined to `app/api/**`, `lib/api/**`, `lib/orchestrator/orchestrator.ts`, and `.env.example`. No `components/**`, `lib/client/**`, or `lib/providers/**` adapter internals are touched by Task 6, and no `*.test.ts` exist (Task 10 pending). The routes import only `lib/api/*`, `lib/orchestrator/{config,orchestrator,event-bus}`, `lib/state/store`, and `lib/types` — **no concrete adapter import** in any `app/api/**` file (architecture §3 forbidden-import rule holds). Note: `lib/orchestrator/config.ts` exposes `maxItems()`/`quotaSoftFraction()` consumed by the route; both are backend-owned, so in-domain even if added alongside Task 6. (No git history exists — attribution is by file content + scope, not a per-task diff.)

---

## Acceptance-criteria check

| Criterion | Status | Evidence |
|---|---|---|
| `POST /api/jobs` matches §7.2 (`201 {jobId}` · `400` · `429`; SSRF + seed + persist; no gen) | PASS | route.ts:119-191; `429`+Retry-After (122-127), `400` shape/SSRF (144-158), seed (180), `201` (190), no `runJob` |
| `GET /api/jobs/:id` snapshot (`200 Job` · `404`) | PASS | [id]/route.ts:17-27, deep-clone `snapshot` |
| `GET /api/jobs/:id/stream` SSE (`text/event-stream`, events, `Last-Event-ID`, `404`) | PASS | stream/route.ts; framing, replay, heartbeat, abort cleanup, `signal`→`runJob` |
| `POST .../retry` (`200 {ok:true}` · `404` · `409`) | PASS w/ caveat | retry/route.ts; see **M1** (409/200 doc contradiction + non-determinism) |
| SSE streams progressive events; exactly-once start | PASS | initial `job.progress{0,0,N}` + `startedJobs` guard |
| Reconnect via `Last-Event-ID` + snapshot, no loss/dup | PASS | synchronous replay→subscribe with `liveCursor` high-water mark |
| SSRF guard on all user URLs, https + Blob allowlist + private-range block | PASS | ssrf.ts; applied to both URL arrays pre-create |
| Rate-limit + idempotency (no double-mint) | PASS | atomic re-check→create→remember, no await |
| Task 9 seam intact (single `processWithProvider(ctx,item,chain[0])`) | PASS | orchestrator.ts:284 |
| Boundary compliance | PASS | only `app/api/**`, `lib/api/**`, `orchestrator.ts`, `.env.example` |

---

## Verification runs

All commands run from repo root with the raw `./node_modules/.bin/*` binaries (rtk wrapper emitted a spurious OOM warning on `biome --version`; raw binary is authoritative).

| Command | Result |
|---|---|
| `biome check .` | **exit 0** — "Checked 45 files in 47ms. No fixes applied." |
| `tsc --noEmit` | **exit 0** — no diagnostics |
| `vitest run` | **exit 0** — "No test files found" (Task 10 reliability suite pending — expected) |
| `next build` | **exit 0** — compiled + typechecked; the 4 Task 6 routes emit as dynamic functions: `ƒ /api/jobs`, `ƒ /api/jobs/[id]`, `ƒ /api/jobs/[id]/items/[itemId]/retry`, `ƒ /api/jobs/[id]/stream` |

`next build` route table confirms `○ /` static and all five API routes (`+ /api/uploads`) as `ƒ (Dynamic) server-rendered on demand` — matches `runtime="nodejs"` + `dynamic="force-dynamic"` on each handler.
