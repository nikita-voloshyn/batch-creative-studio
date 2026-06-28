---
component: StudioShell
source: components/StudioShell.tsx
agent: frontend
updated: 2026-06-28
---

# StudioShell

## Purpose
Client-side composition root (components C1–C4) that lays out the uploader, params form, the Generate action, and the SSE-driven batch grid in the editorial content column. It is the single place where the "ready to generate" gate and the in-flight lock are wired to the store.

## Public Interface
- `StudioShell(): JSX.Element` — top-level client island; takes no props, reads everything from `useBatchStore`.

## Inputs and Outputs
- Reads from store: `entries`, `batch.status`, `batch.launchError`, and the `generate` action.
- Derives `ready = isReadyToGenerate(entries)` (≥1 product, 1–2 references, all uploaded) and `busy` (status is `connecting`/`open`/`reconnecting`).
- On Generate click: calls `generate()` (fire-and-forget via `void`). Uploads already happened eagerly per file, so this only builds the `CreateJobRequest`, renders N optimistic placeholder tiles, creates the job, and opens the SSE stream — all inside the store action.
- Renders: `Uploader` and `ParamsForm` (both passed `disabled={busy}`), the Generate button (`disabled={!ready || busy}`), a contextual hint, an optional `launchError` message, and `BatchGrid`.

## Dependencies
- `Uploader` — file selection surface.
- `ParamsForm` — batch params capture.
- `BatchGrid` — progressive results.
- `useBatchStore` / `isReadyToGenerate` (`lib/client/store`) — state + readiness predicate.

## Key Decisions
- Generate is gated on readiness AND not busy so a second batch can't be launched over a live one; the button label flips to "Generating…" while busy.
- `busy` is derived from connection status rather than a separate flag, keeping the lock in sync with the SSE lifecycle.

## Known Limitations
- Single batch at a time; no queueing of a new batch while one runs.
- No explicit error surface beyond `launchError`; per-tile errors are handled inside `BatchGrid`/`ResultTile`.
