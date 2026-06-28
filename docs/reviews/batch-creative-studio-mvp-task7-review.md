# Review: Task 7 — Batch grid + progressive tiles + SSE client

- **Date:** 2026-06-28
- **Implementer:** frontend
- **Reviewer:** reviewer (fresh context)
- **Plan / Dispatch:** `batch-creative-studio-mvp-plan.md` (Task 7) · `batch-creative-studio-mvp-dispatch.md` (Group 5, In Progress)
- **Scope reviewed (read-only; no source edited):**
  - Created: `lib/client/jobsClient.ts`, `lib/client/sseClient.ts`, `components/grid/{BatchGrid,ResultTile,StatusBadge}.tsx`
  - Modified: `lib/client/uploadClient.ts` (Task-3 fix), `lib/client/store.ts` (batch read-model + L1 fix), `components/StudioShell.tsx`, `app/globals.css`
  - Contract sources cross-checked: `lib/types.ts`, `app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`, `app/api/jobs/[id]/stream/route.ts`, `app/api/jobs/[id]/items/[itemId]/retry/route.ts`, `app/api/uploads/route.ts`, `lib/orchestrator/{orchestrator,retry,failover}.ts` (emitted error codes), `lib/providers/errors.ts`.

---

## Verdict

**Approve.** The implementation is correct, matches every server contract end-to-end, and the two highest-risk invariants — SSE reconnect/merge "no already-shown result is lost or downgraded" and the rewritten upload-contract match — both hold under careful tracing. `biome`, `tsc --noEmit`, and `next build` are all green. Findings are limited to Nit/Low (a benign full-grid re-render on `job.progress`, a transient progress-counter flicker on reconnect, and a deliberately reduced §5i affordance). None block.

---

## Findings by severity

### Critical — none

### High — none

### Medium — none

### Low

- **L1 — §5i content-policy affordance is guidance-only, not the full "replace this image → re-enable retry" flow.** `components/grid/ResultTile.tsx:85-88` renders the static text "Adjust the brief or replace this image, then start a new batch." for `content_policy`/`invalid_input` instead of the per-tile re-upload-and-retry path sketched in product-flow §5i. The **critical** half of §5i is satisfied — a guaranteed-to-fail bare Retry is correctly *suppressed* for these input-fatal codes (`INPUT_FATAL_CODES`, `ResultTile.tsx:28`), so there is no pointless retry loop. The interactive per-tile image-replacement flow is a larger uploader/grid integration and is reasonably deferred; flagging so it is tracked, not as a blocker. The code match is verified: the backend emits exactly `content_policy` / `invalid_input` (`lib/orchestrator/orchestrator.ts:433` `outcome.error.kind`; `lib/providers/errors.ts:22-23`), which equals the frontend set.

### Nit

- **N1 — `ResultTile` is not `React.memo`'d, so a `job.progress` event re-renders the whole grid.** `BatchGrid` subscribes to `done`/`failed`/`total` (`components/grid/BatchGrid.tsx:17-19`); every `job.progress` (emitted by the server after each terminal transition) re-renders `BatchGrid`, which re-renders all `ResultTile` children via normal React parent→child propagation. This does **not** break the progressive-render guarantee: an `item.result` event updates only `batch.items[idx]` and does **not** touch `done/failed/total/length`, so `BatchGrid` does not re-render on it — only the one streamed tile does (verified against `store.ts:_applyEvent`). The extra re-render on `job.progress` is benign at N≤20 (React diffs to near-zero DOM work). Optional: wrap `ResultTile` in `React.memo` to fully realize the "only one tile re-renders" aspiration.
- **N2 — Transient progress-counter flicker on reconnect.** On every (re)connect the snapshot sets `done/failed` via `countTerminals` (`store.ts:504-505`), then the stream replays buffered `job.progress` events from `Last-Event-ID+1`; a replayed *older* progress value can momentarily display a lower count before the replay/live tail converges to the authoritative value. Purely cosmetic, sub-second, and never affects a *result* tile (those are idempotent and never downgraded). Not worth fixing for MVP.

---

## What was traced (the load-bearing scenarios)

### 1. SSE client correctness (most important) — PASS

- **Frame parse (`sseClient.ts:65-89`).** Splits the buffer on `\n\n` (`:159-174`), parses `id:`/`event:`/`data:` per line, strips a single leading space from each value, joins multi-line `data` with `\n`, and skips comment/heartbeat lines (`line.startsWith(":")`). The server only ever writes single-line JSON `data` and `\n\n`-terminated frames (`stream/route.ts:42-44`, heartbeat `": heartbeat\n\n"`), so the parser is an exact match. Chunk-boundary safety: `TextDecoder({stream:true})` + leaving the partial tail in `buffer` until a complete `\n\n` arrives.
- **Manual `Last-Event-ID` on every (re)connect (`sseClient.ts:139-143`).** Sent as `String(lastEventId)` whenever `lastEventId > 0`; the cursor advances on each parsed `id:` (`:170`). This is the documented reason a fetch-reader was chosen over `EventSource` (a post-terminal `reopen()` must seed the cursor on a *fresh* connection so the server replays only events after the old `job.done`).
- **Snapshot-first MERGE on every connect (`sseClient.ts:122-134`).** `runOnce` always `getSnapshot` → `onSnapshot` (→ `_mergeSnapshot`) *before* opening the stream, so `itemIndexById` is repopulated and all already-produced results are reasserted as the authoritative base before any delta is applied.
- **No-loss / no-downgrade invariant (the key one) — holds.** Verified in `store.ts`:
  - `mergeServerItem` (`:222-232`): a `srv.result` → `done`; otherwise `if (tile.status === "done") return base` preserves the shown result (base carries the prior `result`). A snapshot can never downgrade a done tile.
  - `reduceItemEvent` (`:235-267`): `item.result` always sets `done`; **`item.status` and `item.error` short-circuit with `if (tile.status === "done") return tile`** — a replayed `running`/`error` cannot revert a done tile.
  - Traced a mid-batch disconnect with items 1–5 done and the server having advanced to 6–7 while disconnected: snapshot reasserts 1–5 and gains 6–7; replay of `id > cursor` re-applies 6–7 idempotently; a replayed `item.status running` for an already-done tile is dropped by the guard. Prior results preserved, delta applied exactly once in visible effect.
- **Backoff / terminal / 404 (`sseClient.ts:190-214`, `:131`, `:147`).** Drop → exponential backoff (`base·2^(n-1)`, capped 15 s) + jitter; `job.done` → `settled`, stop; 404 snapshot → `gone` (no loop); `reopen()` (`:220-227`) restarts only from a settled `done` (ignored when `stopped` or `gone`). `close()` sets `stopped` before `abort()`, and `runOnce`'s abort branches return `"done"` which the loop discards under `if (stopped) return` — clean teardown, no spurious connection-state callback.

### 2. Upload contract match (Task-3 fix) — PASS

`uploadClient.ts:59-66` calls `upload(\`uploads/${kind}/${file.name}\`, file, { access:"public", handleUploadUrl:"/api/uploads", contentType, clientPayload: JSON.stringify({ kind }), abortSignal })` and returns `result.url`. This satisfies exactly what `app/api/uploads/route.ts` validates: pathname prefix `uploads/${kind}/` (`route.ts:122-124`), `clientPayload === JSON.stringify({ kind })` with `kind ∈ {product,reference}` (`route.ts:83-98`), and the content-type allowlist + 10 MB cap baked into the minted token (`route.ts:126-132`). The obsolete `{uploadUrl,blobUrl}` type, `requestSignedUpload`, and the raw-`PUT` path are fully removed — a repo-wide grep finds the strings only in explanatory doc-comments, never in executable code. `@vercel/blob@^2.5.0` is present in `package.json`.

### 3. Jobs client contract — PASS

- `createJob` (`jobsClient.ts:44-70`) POSTs `{ productImageUrls, referenceImageUrls, params:{aspectRatio,brief?,perImageHints?} }` with an `Idempotency-Key` header; treats any 2xx as success (server returns `201 {jobId}`, `app/api/jobs/route.ts:190`). Body type `CreateJobRequest` (`store.ts:63-71`) matches the route's `ValidBody`.
- `retryItem` (`jobsClient.ts:95-116`) treats `200` as success/idempotent and `404` as `JobApiError(404)`; **no 409 path** — exactly matching the now-idempotent retry route (`retry/route.ts:46-54,81`).
- `getSnapshot` (`jobsClient.ts:78-87`) maps `404 → JobApiError(404)` (consumed by `sseClient` as `gone`).

### 4. Progressive rendering + tiles — PASS

- Each `ResultTile` subscribes to `s.batch.items[index]` (`ResultTile.tsx:31`); `_applyEvent` replaces only `items[idx]` and rebuilds the array, so unchanged indices keep their object identity and Zustand skips their re-render — one `item.result` re-renders one tile (see N1 for the `job.progress` caveat).
- Optimistic placeholders: one per product URL in submission order, with the matching preview thumbnail (`store.ts:384-413`).
- Prompt-only badge when `result.usedImageReference === false` (`ResultTile.tsx:63-70`, §5c).
- Failed tile shows message + last provider + Retry; `content_policy`/`invalid_input` swap Retry for the §5i text (`ResultTile.tsx:78-101`).
- Global `X of N done · K errors` with correct pluralization (`BatchGrid.tsx:31-34`).
- **itemId↔tile reconciliation (`store.ts:480-506`):** by submission index with a `productImageUrl` equality check, falling back to a first-URL-match map. Product blobUrls are unique per batch (`addRandomSuffix` on every minted token), so the index path always wins and the fallback is pure defense — **no realistic mismatch risk**.

### 5. L1 fix + store authority — PASS

`isReadyToGenerate` now enforces the product UPPER bound (`store.ts:185-190`: `products <= MAX_PRODUCT_IMAGES`) — the L1 fix. Authoritative tile state is written only from `_mergeSnapshot` / `_applyEvent` (server authority). Client-authored state is limited to optimistic placeholders and the retry optimistic `item.status{queued}` flip, which mirrors the event the server is about to emit; the retry-failure `item.error` synthesis (`store.ts:454-465`) is necessary UI recovery (the POST failed, so no server event will arrive to un-stick the optimistic `queued`) and reuses the captured `prevError` — no fabricated success.

### 6. Visual language + responsive — PASS

`.grid` uses `repeat(auto-fill, minmax(220px,1fr))` with media queries to 2-col (641–900 px) and 1-col (≤640 px) — `globals.css:468-581`, NFR-7. Editorial/charcoal tokens reused, ALL-CAPS status labels (`.status` text-transform, `StatusBadge`), tiles keep a fixed per-`aspectRatio` box and render the image as the hero with no card chrome.

### 7. Boundary compliance — PASS (with no-commits caveat)

Every Task-7 file lives in `lib/client/**`, `components/**`, or `app/globals.css`. No client module imports `app/api/**`, `lib/orchestrator/**`, `lib/state/**`, `lib/providers/**`, or `lib/blob/**`; the API is consumed only over HTTP `fetch`; `@vercel/blob/client` is the browser entrypoint; no `process.env`/secret access in any client file. The repo has no git commits, so this is established by file-domain inspection rather than a diff; the API route files read as backend Tasks 3/6 output (consistent doc headers, no frontend fingerprint).

---

## Acceptance-criteria check

| Acceptance criterion (Task 7) | Status | Evidence |
|---|---|---|
| Tiles render progressively from SSE | PASS | Per-tile subscription `ResultTile.tsx:31`; `item.result` updates only `items[idx]` (`store.ts:240-252,508-536`); does not re-render `BatchGrid` |
| Reconnect loses no results | PASS | Snapshot-first merge + no-downgrade guards (`sseClient.ts:122-134`; `store.ts:230,254`); traced mid-batch drop/reconnect |
| Targeted retry works | PASS | `retry` → `retryItem` (200 idempotent / 404 gone) + `reopen()` for terminal job (`store.ts:442-471`; `sseClient.ts:220-227`) |
| Responsive reflow (NFR-7) | PASS | `globals.css:468-581` auto-fill grid + tablet/phone breakpoints |
| Prompt-only badge | PASS | `ResultTile.tsx:63-70` on `usedImageReference === false` |
| Global `X of N done · K errors` | PASS | `BatchGrid.tsx:31-34` |
| Optimistic placeholders + rollback (§5j) | PASS | `store.ts:384-425` (seat N, roll back to `EMPTY_BATCH` + `launchError` on failure) |
| 404 snapshot → non-hanging `gone` (§5n) | PASS | `sseClient.ts:131`; `BatchGrid.tsx:39-43` |
| §5i input-fatal affordance | PARTIAL (Low L1) | Bare retry suppressed for `content_policy`/`invalid_input`; full per-tile replace-and-retry deferred (`ResultTile.tsx:85-88`) |

---

## Verification runs

| Command | Result |
|---|---|
| `./node_modules/.bin/biome check .` | **exit 0** — "Checked 51 files in 49ms. No fixes applied." (the rtk-proxied `pnpm exec biome check .` falsely reported an abnormal/OOM termination; the raw binary is authoritative) |
| `./node_modules/.bin/tsc --noEmit` | **exit 0** — no diagnostics |
| `pnpm build` (`next build`, Next 16.2.9 / Turbopack) | **success** — "Compiled successfully in 1637ms", TypeScript pass, all 5 API routes + `/` built |
