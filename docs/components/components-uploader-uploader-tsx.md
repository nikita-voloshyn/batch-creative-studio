---
component: Uploader
source: components/uploader/Uploader.tsx
agent: frontend
updated: 2026-06-28
---

# Uploader

## Purpose
Component C2: the upload surface with two clearly separated buckets — product images (N ≤ `MAX_PRODUCT_IMAGES`) and style/mood references (1–`MAX_REFERENCE_IMAGES`). Each bucket has drag&drop + picker, per-file previews/removal, a count badge, and inline client-validation rejection messages.

## Public Interface
- `Uploader({ disabled?: boolean }): JSX.Element` — `disabled` locks the entire input surface (add + remove + retry) while a batch is in flight.

## Inputs and Outputs
- Reads from store: `entries`, plus actions `addFiles`, `removeEntry`, `retryUpload`.
- Splits entries via `selectProducts` / `selectReferences` (memoized).
- `handleFiles(files, kind)`: awaits `addFiles(files, kind)`, then stores the returned `rejected: Rejection[]` in local product/reference rejection state for inline display.
- Renders two `DropZone`s (each disabled when its cap is reached or globally disabled, with a contextual `disabledLabel`), rejection lists (`name — reason`), and a `FilePreview` per entry.

## Dependencies
- `DropZone` — drag&drop + picker surface.
- `FilePreview` — per-file thumbnail with status/remove/retry.
- `useBatchStore` / `selectProducts` / `selectReferences` / `Rejection` (`lib/client/store`).
- `MAX_PRODUCT_IMAGES` / `MAX_REFERENCE_IMAGES` (`lib/client/fileValidation`).
- `UploadKind` (`lib/client/uploadClient`).

## Key Decisions
- Caps and validation are enforced in the store; this component only renders the surface and the rejection reasons — keeping a single validation authority.
- `disabled` locks removal mid-run so a removed entry can't revoke a `previewUrl` still referenced by a live tile (which would blank that tile).

## Known Limitations
- Rejection state is local and per-bucket; it is replaced on the next `addFiles`, not accumulated.
