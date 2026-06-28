---
component: SharedTypes
source: lib/types.ts
agent: backend
updated: 2026-06-28
---

# SharedTypes

## Purpose
The single, dependency-free source of truth for the app's domain entities (Job / Item / Attempt) and the SSE event payload contract. Isomorphic — one of the only modules permitted to cross the client↔server boundary (architecture §3 / §7).

## Public Interface
- `type AspectRatio = "1:1" | "4:5" | "9:16"` — output aspect ratio; canonical home (re-exported by `lib/providers/types.ts`).
- `type JobStatus = "running" | "completed" | "completed_with_errors" | "failed"` — job-level status.
- `type ItemStatus = "queued" | "running" | "succeeded" | "failed"` — item-level status.
- `type AttemptOutcome = "success" | "retryable_error" | "fatal_error"` — outcome of one provider attempt.
- `type Job` — batch run: `id`, `status`, `seed` (per-batch deterministic), `params` (`aspectRatio`, optional `brief`, optional `perImageHints` keyed by `productImageUrl`), `referenceImageUrls`, `items`, `createdAt` (ISO-8601).
- `type Item` — one product image → one post: `id`, `jobId`, `productImageUrl`, `status`, `attempts`, optional `result` (`imageUrl`, `providerId`, `usedImageReference`), optional `error` (`code`, `message`, `lastProviderId`).
- `type Attempt` — one provider call: `providerId`, `startedAt`, optional `finishedAt`, `outcome`, optional `errorMessage`.
- SSE payloads: `ItemStatusEvent`, `ItemResultEvent`, `ItemErrorEvent`, `JobProgressEvent` (`done`/`failed`/`total`), `JobDoneEvent`.
- `type SseEventName` — union of the five event names.
- `type SseEventMap` — maps each SSE event name to its `data:` payload type.

## Inputs and Outputs
Pure type declarations — no runtime code, no I/O. Consumed at compile time by every layer (route handlers, orchestrator, state stores, SSE client).

## Dependencies
None (intentionally dependency-free).

## Key Decisions
- `failed` (JobStatus) is reserved for JOB-LEVEL precondition failures only (empty provider chain, batch reference-normalization failure). All-items-failed is `completed_with_errors` (done=0, failed=N), never `failed`.
- Status/outcome unions are extracted into named aliases referenced by entities; wire literals are unchanged — aliases just give SSE payloads and downstream code a shared name.
- `perImageHints` lives on `Job.params` (keyed by `productImageUrl`), resolved at the composition root when building each Item's `GenerateInput`; there is deliberately NO `Item.captionHint` field.
- The monotonic SSE frame `id:` (for `Last-Event-ID` replay) is a transport concern, NOT part of any payload type.

## Known Limitations
- Mirrors architecture §7 / product-flow §0 / §8 by hand; drift must be reconciled manually.
