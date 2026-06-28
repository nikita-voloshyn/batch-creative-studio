---
component: useBatchStore
source: lib/client/store.ts
agent: frontend
updated: 2026-06-28
---

# useBatchStore

## Purpose
The single Zustand store backing the whole client UI: it holds the user's file selection (uploads + per-file status/blobUrl/hint), the batch params, and the SSE-driven batch read-model behind the progressive grid. It is the authoritative client state hub that wires uploads → job creation → SSE stream into one place.

## Public Interface
- `useBatchStore` — Zustand hook exposing `BatchStore` (state + actions below).
- Actions: `addFiles(files, kind) → Promise<{ rejected: Rejection[] }>`, `removeEntry(id)`, `retryUpload(id)`, `setEntryHint(id, hint)`, `setAspectRatio(ar)`, `setBrief(s)`, `reset()`, `buildCreateJobRequest() → CreateJobRequest | null`, `generate() → Promise<void>`, `runExample() → Promise<void>`, `retry(itemId) → Promise<void>`, `resetBatch()`.
- State flag: `exampleLoading: boolean` — true while the bundled example batch is being fetched + uploaded (before `generate`).
- Internal (SSE client → store) actions, prefixed `_`: `_mergeSnapshot(job)`, `_applyEvent(name, data)`, `_setConnection(state)`, `_upload(id)`.
- Pure selectors: `selectProducts(entries)`, `selectReferences(entries)`, `isReadyToGenerate(entries) → boolean`.
- Exported types: `UploadStatus`, `UploadEntry`, `Rejection`, `BatchParams`, `CreateJobRequest`, `TileStatus`, `BatchConnection`, `BatchItem`, `BatchState`, `BatchStore`.

## Inputs and Outputs
- `addFiles`: validates each file (`validateImageFile`), enforces the per-kind cap (`MAX_PRODUCT_IMAGES`=20 / `MAX_REFERENCE_IMAGES`=2) against the live count, creates an `UploadEntry` with an object-URL preview, then eagerly fires `_upload`. Returns rejected files with reasons; never throws.
- `_upload`: calls `uploadFile`, patches entry to `uploaded` + `blobUrl` on success or `error` + message on `UploadError`.
- `buildCreateJobRequest`: returns `null` unless `isReadyToGenerate`; otherwise assembles `{ productImageUrls, referenceImageUrls, params }` from uploaded blobUrls; `perImageHints` keyed by product `blobUrl` (trimmed, omitted if empty); `brief` omitted if blank.
- `generate`: builds request (no-op if null), renders N optimistic `queued` placeholders (preview from matching entry), `createJob(request, randomUUID)`, then `openJobStream`. On create failure rolls grid back to empty with `launchError` (uploads/params kept).
- `runExample`: one-click demo — `reset()`, fetches the bundled assets from `/examples/` (3 products + 1 reference), feeds them through the same `addFiles` → eager-upload path, waits for the uploads to settle, then `generate()`. Best-effort: surfaces `launchError` on any failure; toggles `exampleLoading`.
- `retry(itemId)`: optimistically flips the tile to `queued`, calls `retryItem`; on failure re-applies an `item.error` (404 → "no longer available"). If the stream already settled `done`, calls `streamController.reopen()`.
- `_mergeSnapshot`: merges an authoritative `Job`, reconciling `itemId → index` by submission order (fallback: productImageUrl match), rebuilds `itemIndexById`, recomputes `total/done/failed`.
- `_applyEvent`: routes `job.progress` to counters, ignores `job.done` (terminal UI driven by connection), and applies item events idempotently via `reduceItemEvent` — never clobbers an already-shown result.
- Writes: object URLs are created on add and revoked on `removeEntry`/`reset`. Module-level `streamController` and `itemIndexById` map.

## Dependencies
- `fileValidation` — `validateImageFile`, caps.
- `uploadClient` — `uploadFile`, `UploadError`, `UploadKind`.
- `jobsClient` — `createJob`, `retryItem`, `JobApiError`.
- `sseClient` — `openJobStream`, `JobStreamController`, `StreamConnectionState`.
- `@/lib/types` — `AspectRatio`, `Item`, `ItemStatus`, `Job`, `SseEventMap`, `SseEventName` (backend-owned contract).
- `zustand` — store factory.

## Key Decisions
- Module-level store is intentional: state starts empty, only mutates from client interaction, never read during SSR — so no cross-request leakage.
- `CreateJobRequest` is defined here (not in backend-owned `lib/types.ts`) as the FE→BE request contract.
- Server is the single writer for the grid; the only client-authored state is the optimistic placeholders, reconciled away by the first snapshot/events.
- `isReadyToGenerate` is stricter than the task floor: requires every file fully uploaded AND product/reference counts within caps.
- Reconciliation prefers positional (submission order, preserved by the create route) with a productImageUrl fallback for divergence.
- Merge/reduce helpers never downgrade a `done` tile — result-preservation across snapshots, replays, and live deltas.

## Known Limitations
- One batch in view at a time (single module-level `streamController`); generating a new batch tears down the prior stream.
- `gone` streams are not reopenable (MVP); only post-`done` streams can `reopen`.
- Hints are product-only; reference entries ignore the `hint` field.
