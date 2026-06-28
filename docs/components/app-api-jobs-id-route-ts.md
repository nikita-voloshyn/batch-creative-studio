---
component: JobSnapshotRoute
source: app/api/jobs/[id]/route.ts
agent: backend
updated: 2026-06-28
---

# JobSnapshotRoute

## Purpose
Returns a deep-cloned `Job` snapshot for reconnect recovery and direct open (e.g. re-loading a batch by URL), giving the client the current state of every item without subscribing to the stream.

## Public Interface
- `GET /api/jobs/:id` → `NextResponse` — `200` with the `Job` snapshot JSON, or `404 { error }` if unknown.
- `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`.

## Inputs and Outputs
- **Accepts:** route param `id` (job id; `params` is a `Promise` per Next.js App Router).
- **Reads:** `stateStore.snapshot(id)` — a deep clone of the Job (safe to serialize).
- **Returns:** `200 Job` snapshot, or `404 { error: "Job not found." }`.

## Dependencies
- `@/lib/state` (`getStateStore`) — `snapshot(id)`.
- `next/server` (`NextResponse`).

## Key Decisions
- **404 on unknown job covers the MVP process-recycle / different-instance case** (product-flow §5n): when the in-memory store no longer holds the job, the client treats the 404 as "batch no longer available" and stops reconnecting rather than looping.
- Returns a deep clone (via `snapshot`) so the response cannot leak live mutable store state.

## Known Limitations
- A job only exists for the lifetime of the instance that created it; with the in-memory store a snapshot may 404 after a recycle. The shared Redis store (when configured) makes snapshots resolvable across instances.
- Read-only — no mutation; no auth.
