---
component: JobsCreateRoute
source: app/api/jobs/route.ts
agent: backend
updated: 2026-06-28
---

# JobsCreateRoute

## Purpose
Creates a Job plus N `queued` Items from a validated batch request and returns `{ jobId }`. It does **not** start generation — orchestration is hosted by `GET /api/jobs/:id/stream`, which the client opens immediately after.

## Public Interface
- `POST /api/jobs` → `NextResponse` — create a batch job. `201 { jobId }` on success.
- `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`.

## Inputs and Outputs
- **Accepts (JSON body):**
  - `productImageUrls: string[]` — 1..`maxItems()` entries.
  - `referenceImageUrls: string[]` — 1..2 entries.
  - `params: { aspectRatio: "1:1"|"4:5"|"9:16", brief?: string, perImageHints?: Record<string,string> }`.
  - Optional `Idempotency-Key` request header.
- **Guard order (mirrors product-flow §2.7):**
  1. Per-IP rate limit → `429` with `Retry-After` header.
  2. Idempotency: same `Idempotency-Key` in-window returns the existing `jobId` (`201`). Re-checked a second time just before the synchronous create to collapse concurrent duplicates atomically (no `await` between check and reserve).
  3. Shape / count / enum validation → `400 { error }`.
  4. SSRF validation of every product + reference URL (https + Vercel Blob host allowlist + private-range block) → `400`.
  5. Materialize Job + Items, persist via the state store.
- **Writes:** one `Job` (`status: "running"`, `seed = deriveSeed(jobId)`, `createdAt`) and N `Item`s (`status: "queued"`, empty `attempts`) into the state store; remembers the idempotency key → jobId.
- **Returns:** `201 { jobId }`. Errors: `400` (bad JSON/shape/SSRF), `429` (rate limited).

## Dependencies
- `@/lib/api/job-idempotency` (`lookupIdempotentJob`, `rememberIdempotentJob`) — in-window dedup.
- `@/lib/api/rate-limit` (`checkJobRateLimit`, `clientIp`) — per-IP abuse guard.
- `@/lib/api/ssrf` (`checkUserImageUrls`) — URL allowlist / SSRF block.
- `@/lib/orchestrator/config` (`maxItems`) — upper bound on product images.
- `@/lib/orchestrator/orchestrator` (`deriveSeed`) — deterministic per-batch seed.
- `@/lib/state` (`getStateStore`) — Job/Item persistence.
- `@/lib/types` (`AspectRatio`, `Item`, `Job`).

## Key Decisions
- **Does not call `runJob`** — start-once orchestration is owned by the stream handler (architecture §6); this route only persists state, keeping creation cheap and idempotent.
- **Double idempotency check** brackets the synchronous create so a duplicate that races past the first check still collapses onto one Job (single-threaded JS, no `await` in the critical section).
- `seed` is derived once per batch (`deriveSeed(jobId)`) to drive style consistency across all items.

## Known Limitations
- In-memory state: the created job survives only within one function lifetime / instance (durable persistence is full-product scope).
- `referenceImageUrls` capped at 2; `productImageUrls` capped at `maxItems()` (env-driven `MAX_ITEMS`).
- No auth.
