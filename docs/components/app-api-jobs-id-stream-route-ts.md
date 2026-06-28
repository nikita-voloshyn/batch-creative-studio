---
component: JobStreamRoute
source: app/api/jobs/[id]/stream/route.ts
agent: backend
updated: 2026-06-28
---

# JobStreamRoute

## Purpose
Long-lived SSE endpoint that both **drives** generation and streams progress. The first opener claims a run-once start, emits the initial progress event, and hosts `runJob` inline (held alive by Vercel Fluid Compute); all streams forward the per-job event bus to the client as SSE frames. Concurrent / reconnecting streams subscribe and replay but never start a second run.

## Public Interface
- `GET /api/jobs/:id/stream` → `Response` — `text/event-stream` body, or `404 { error }` if the job is unknown.
- `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`, `export const maxDuration = 300` (static literal; covers an N≤20 batch).

## Inputs and Outputs
- **Accepts:** route param `id`; optional `Last-Event-ID` request header (reconnect cursor); `request.signal` (aborts on client disconnect and on `maxDuration`).
- **Emits SSE frames:** `id: <n>\nevent: <name>\ndata: <json>\n\n` for each bus event (`job.progress`, `item.*`, `job.done`, …), plus `: heartbeat` comments every 15s.
- **Reconnect:** replays buffered events with `id > Last-Event-ID`, then subscribes LIVE-ONLY from `bus.lastEventId` (both synchronous — no event lost or duplicated). If a terminal `job.done` is in the replay, it closes immediately without subscribing.
- **Start-once:** `claimJobStart(jobId)` returns `true` for exactly one caller. The winner emits `job.progress{0,0,N}` and calls `runJob(jobId, { signal })`; the signal drives the orchestrator's graceful sweep on disconnect / timeout. An already-aborted open never claims the start (avoids stranding the job).
- **Returns:** `404 { error: "Job not found." }` if `getJob` misses; otherwise the streaming `Response` with `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- **Teardown:** shared `cleanup()` (idempotent via `closed` flag) clears the heartbeat, unsubscribes, removes the abort listener, and closes the controller on disconnect, terminal event, or write failure.

## Dependencies
- `@/lib/orchestrator/event-bus` (`getJobEventBus`, `JobEvent`) — per-job in-process pub/sub with monotonic ids + replay.
- `@/lib/orchestrator/orchestrator` (`runJob`) — the hosted generation run.
- `@/lib/state` (`getStateStore`) — `getJob` existence check.
- `@/lib/state/redis-store` (`getRedisClient`, `isRedisConfigured`) — cross-instance start claim.

## Key Decisions
- **Exactly-once start across instances:** with Redis the claim is `SET bcs:started:{jobId} 1 NX EX 600` — only the `NX` winner hosts `runJob`; without Redis it falls back to a process-global `startedJobs` Set (single-instance dev/test). The 600s TTL self-heals a crashed host.
- **Claim before opening the stream**, and skip the claim for an already-aborted request, so there is no window where a dead opener wins and strands the job (`start()` runs the same-tick abort check).
- **Monotonic event ids + `Last-Event-ID` replay** guarantee reconnect loses/duplicates nothing; replay then live-subscribe run with no `await` between them.
- Heartbeat (15s) keeps the connection warm and detects a dead peer.

## Known Limitations
- The event bus is **in-process**: live delivery only works because the orchestrator and the winning stream run in the same instance. Cross-instance pub/sub (delivering live events to a reconnect that landed on a different instance than the host) is full-product scope — such a reconnect relies on replay/snapshot.
- `maxDuration = 300` caps a single run; very large/slow batches could be cut off (the orchestrator's abort sweep handles teardown).
- No auth.
