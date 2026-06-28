---
component: FilePreview
source: components/uploader/FilePreview.tsx
agent: frontend
updated: 2026-06-28
---

# FilePreview

## Purpose
Component C2 per-file preview thumbnail showing the selected image (via object URL), its upload status, a remove control, and — on upload error — an inline reason plus a per-file Retry (product-flow §2.4).

## Public Interface
- `FilePreview(props): JSX.Element` where `props` is:
  - `entry: UploadEntry` — the file entry (id, file, previewUrl, status, error).
  - `onRemove: (id: string) => void` — remove handler.
  - `onRetry: (id: string) => void` — retry-upload handler.
  - `disabled?: boolean` — locks remove/retry while a batch is in flight.

## Inputs and Outputs
- Renders `entry.previewUrl` as an `<img>` (object URL of a local file; `next/image` deliberately not used).
- Shows status via `STATUS_LABEL` map (`uploading` → "Uploading", `uploaded` → "Uploaded", `error` → "Error") with class `status--<status>`.
- On `entry.status === "error"`: renders `entry.error` text and a Retry button calling `onRetry(entry.id)`.
- Remove button calls `onRemove(entry.id)`; both controls respect `disabled`.

## Dependencies
- `UploadEntry` / `UploadStatus` (`lib/client/store`) — entry shape and status union.

## Key Decisions
- Plain `<img>` for object-URL previews — a remote-optimized image component adds no value for local blobs.
- `disabled` locks remove/retry because removing an entry mid-run revokes a `previewUrl` still referenced by its queued/generating tile.

## Known Limitations
- Status register is the three upload states only; generation status lives on tiles, not here.
