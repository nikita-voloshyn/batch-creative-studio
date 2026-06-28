---
component: ItemRetryRoute
source: app/api/jobs/[id]/items/[itemId]/retry/route.ts
agent: backend
updated: 2026-06-28
---

# ItemRetryRoute

## Purpose
Targeted retry of a single `failed` Item: atomically flips it back to `queued` and re-drives only that item through the orchestrator's per-item path, emitting live `item.*` / `job.*` events so any open stream updates. Idempotent by contract.

## Public Interface
- `POST /api/jobs/:id/items/:itemId/retry` → `NextResponse` — `200 { ok: true }` on success or no-op, `404 { error }` for unknown job/item.
- `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`, `export const maxDuration = 300`.

## Inputs and Outputs
- **Accepts:** route params `id` (job) and `itemId` (`params` is a `Promise`). No request body.
- **Flow:**
  1. `getJob` / `getItem` miss → `404`.
  2. Item not `failed` (succeeded/running/queued) → idempotent `200 { ok: true }`, no work.
  3. `casItemStatus(jobId, itemId, "failed", "queued")` — atomic CAS; loser of a concurrent double-click returns idempotent `200`.
  4. Winner: if the job was terminal, `setJobStatus(jobId, "running")` (so a snapshot taken right after reflects `running`); emit `item.status { itemId, status: "queued" }` to the bus.
  5. Schedule `retryItem(jobId, itemId)` via `after()` (background; Fluid Compute keeps the function alive); return `200 { ok: true }`.
- **Writes:** item status `failed → queued` (CAS), optional job status → `running`.
- **Emits:** `item.status` (queued) immediately; subsequent `item.*` / `job.*` events come from `retryItem`, carried by the open SSE stream — **not** this response.
- **Errors:** only `404`. Retry never returns a conflict; a `retryItem` crash is logged (structured JSON) but not surfaced.

## Dependencies
- `@/lib/state` (`getStateStore`) — `getJob`, `getItem`, `casItemStatus`, `setJobStatus`.
- `@/lib/orchestrator/event-bus` (`getJobEventBus`) — emit `item.status`.
- `@/lib/orchestrator/orchestrator` (`retryItem`) — per-item re-drive.
- `next/server` (`after`, `NextResponse`) — background work + response.

## Key Decisions
- **Idempotent by contract:** the only error is `404`; any existing item returns `200`. A non-`failed` item or a lost CAS (concurrent double-click) is a no-op, so double-clicks are safe.
- **Atomic CAS dedups concurrent retries** — with the Redis store it is a server-side Lua flip, so two requests on different instances cannot both transition `failed → queued`.
- **Re-drive in `after()`** so the response returns promptly while generation continues; progress is delivered over the existing stream, keeping this endpoint a thin trigger.
- Re-opens a terminal job to `running` before responding so an immediately-following snapshot is consistent.

## Known Limitations
- Live progress requires an **open SSE stream** on the same instance; this response carries none.
- In-memory state means retry only works while the hosting instance still holds the job.
- No auth.
