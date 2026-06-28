---
component: DownloadPostButton
source: components/export/DownloadPostButton.tsx
agent: frontend
updated: 2026-06-28
---

# DownloadPostButton

## Purpose
Component C6 single-post download control shown on a DONE tile. It saves that post at full resolution by fetching the cross-origin Blob image and forcing an `<a download>` save.

## Public Interface
- `DownloadPostButton({ imageUrl, index }: { imageUrl: string; index: number }): JSX.Element` — `imageUrl` is the result Blob URL; `index` names the saved file / orders it within the batch.

## Inputs and Outputs
- On click: sets local `state` to `working`, calls `downloadSinglePost(imageUrl, index)`, then resets to `idle`; on throw, sets `error`.
- Guards re-entry while `working`.
- Label reflects state: "Saving…" / "Retry download" / "Download". Sets `aria-busy` while saving.

## Dependencies
- `downloadSinglePost` (`lib/client/export`) — fetch + forced-download helper.

## Key Decisions
- Local UI state only — the store stays the read-model authority and is not touched here.
- Fetch-then-`<a download>` (rather than a direct link) is required because the image is cross-origin Blob storage and must be saved, not navigated to.

## Known Limitations
- No progress indication for large images; only the working/error/idle states.
