---
component: openJobStream
source: lib/client/sseClient.ts
agent: frontend
updated: 2026-06-28
---

# openJobStream (SSE client + reconnect)

## Purpose
Drives `GET /api/jobs/:id/stream` as a manual fetch-stream reader (not native `EventSource`) and dispatches its named SSE events into the batch store, owning reconnect/backoff and frame parsing. Exists to support a snapshot-first, cursor-controlled reconnect that survives post-terminal retries.

## Public Interface
- `openJobStream(jobId, handlers) → JobStreamController` — starts the connect loop in the background, returns immediately.
- `JobStreamController` — `{ reopen(), close() }`. `reopen()` restarts the loop only after it settled on `done`; `close()` aborts in-flight requests and cancels pending reconnects.
- `JobStreamHandlers` — `{ onSnapshot(job), onEvent(name, data), onConnection(state) }` callbacks; the client is transport-only.
- `StreamConnectionState` — `"connecting" | "open" | "reconnecting" | "done" | "gone"`.

## Inputs and Outputs
- Per attempt (`runOnce`): (1) `getSnapshot(jobId, signal)` first and emit `onSnapshot` (authoritative base); a 404 → `gone`, abort → `done`, other error → `drop`. (2) `fetch` the stream with a manual `Last-Event-ID` header (only when cursor > 0), `cache: no-store`; 404 → `gone`, non-ok/no-body → `drop`, else emit `onConnection("open")`. (3) Read the body reader, split frames on `\n\n`, `parseFrame`, advance `lastEventId` on each `id:`, dispatch typed events; `job.done` marks `sawDone`.
- `parseFrame`: parses one SSE frame; ignores comments/heartbeats (`:`-prefixed and blank lines); returns `{ id?, event?, data }` or null.
- `dispatch`: validates the event name against `SSE_EVENT_NAMES`, `JSON.parse`s data (drops on parse failure), forwards to `onEvent`; returns true only for `job.done`.
- Loop: emits `connecting`/`reconnecting`, runs `runOnce`; `gone`/`done` settle and stop; `drop` triggers exponential backoff (`base 1s`, cap `15s`, `2^(attempt-1)` + up to 1s jitter) and retries.

## Dependencies
- `jobsClient` — `getSnapshot`, `JobApiError`.
- `@/lib/types` — `Job`, `SseEventMap`, `SseEventName`.

## Key Decisions
- Fetch reader over `EventSource`: native `EventSource` can't seed `Last-Event-ID` on a fresh connection, so a post-terminal reopen would replay the old `job.done` and immediately close. Manual header sends the cursor on every (re)open so the server replays only events after it.
- Snapshot-before-stream on every (re)connect guarantees no shown result is lost (architecture §6.3); replayed + live deltas are idempotent by `itemId`.
- A 404 snapshot terminates as `gone` rather than looping forever (process recycle / different instance).
- Cursor retained after `job.done` so `reopen()` resumes from the right point.

## Known Limitations
- `gone` is irrecoverable in MVP; `reopen()` is a no-op unless the loop settled on `done`.
- Backoff/parsing/reconnect are hand-rolled (the trade-off of not using `EventSource`).
- No max-attempt ceiling — it reconnects on `drop` indefinitely until `close()`.
