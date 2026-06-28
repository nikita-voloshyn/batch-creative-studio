---
component: JobEventBus
source: lib/orchestrator/event-bus.ts
agent: backend
updated: 2026-06-28
---

# JobEventBus

## Purpose
In-process, per-job pub/sub with a bounded replay ring buffer. The orchestrator emits typed SSE payloads here as items progress; the SSE Route Handler subscribes to the SAME per-job bus, replays buffered events after a `Last-Event-ID`, and pipes live events to the client. Producer and consumer share one stream invocation, so no cross-request sharing is needed for the MVP.

## Public Interface
- `class JobEventBus` — per-job bus.
  - `constructor(jobId: string, bufferLimit = 2000)`.
  - `get lastEventId(): number` — highest event id emitted (0 before first emit).
  - `emit<K>(name: K, data: SseEventMap[K]): JobEvent` — assign next monotonic id, append to buffer (trim to limit), fan out to subscribers; returns the stored envelope.
  - `replaySince(afterId: number): JobEvent[]` — buffered events with id strictly greater than `afterId` (`afterId <= 0` returns the whole buffer).
  - `subscribe(handler, sinceId = 0): () => void` — replays backlog (id > sinceId) synchronously, then registers for live events; returns an unsubscribe fn.
  - `close(): void` — drops all subscribers (buffer retained for late snapshot replay).
- `type JobEvent` — per-name envelope union `{ id; name; data }` keyed by `SseEventName`.
- `getJobEventBus(jobId): JobEventBus` — get-or-create the process-global bus for a job.
- `peekJobEventBus(jobId): JobEventBus | undefined` — get without creating.
- `deleteJobEventBus(jobId): void` — close and forget a job's bus.

## Inputs and Outputs
- Emitted event names (from `lib/types`): `item.status`, `item.result`, `item.error`, `job.progress`, `job.done`.
- Each event carries a monotonic-per-job `id` used as the SSE frame `id:`, enabling precise replay from `Last-Event-ID`.
- A throwing subscriber (e.g. a closed SSE writer) is caught and ignored so it can never break the emit loop or other subscribers.

## Dependencies
- `lib/types` — `SseEventMap`, `SseEventName` (event name → payload mapping).

## Key Decisions
- The `JobEvent` type is a discriminated union of per-name envelopes so a consumer can narrow on `name` to get the exact payload type.
- Default ring-buffer depth 2000 comfortably covers an N≤20 batch's full event log.
- Process-global registry keyed by jobId because producer (orchestrator) and SSE writer must reach the same bus instance within one Vercel Function invocation.
- `close()` retains the buffer so a late snapshot/reconnect can still replay history.

## Known Limitations
- In-memory and process-local: events do not survive a process restart and are not shared across instances. Full product swaps this for KV/Redis pub-sub.
- Ring buffer drops the oldest events past `bufferLimit`; a reconnect after very long history could miss trimmed events.
