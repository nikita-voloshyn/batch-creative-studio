---
component: DownloadAllButton
source: components/export/DownloadAllButton.tsx
agent: frontend
updated: 2026-06-28
---

# DownloadAllButton

## Purpose
Component C6 whole-batch "Download all (zip)" control in the batch toolbar. It gathers every succeeded tile, packs them client-side into a zip with a `MANIFEST.txt`, and is available progressively (no need to wait for the whole batch to settle).

## Public Interface
- `DownloadAllButton(): JSX.Element` — no props; reads succeeded items from the store.

## Inputs and Outputs
- Reads from store: `batch.items`, `batch.jobId`.
- Builds `succeeded: ExportPost[]` from items with `status === "done"` and a `result.imageUrl`, capturing `index`, `imageUrl`, `providerId`, `usedImageReference`.
- Disabled when `count === 0` or while `state === "working"`.
- On click: sets `working`, calls `downloadBatchZip(succeeded, jobId, items.length)`, then resets to `idle`; on throw, sets `error`.
- Label reflects state: "Zipping…" / "Zip failed — retry" / "Download all · N post(s)" (live count).
- Sets `aria-busy` while zipping.

## Dependencies
- `useBatchStore` (`lib/client/store`).
- `downloadBatchZip` / `ExportPost` (`lib/client/zip`) — client-side zip packing.

## Key Decisions
- Zip is assembled client-side (no server round-trip) and includes a `MANIFEST.txt`.
- Enabled the moment ≥1 item succeeds rather than after the full batch settles, matching progressive delivery.

## Known Limitations
- Local UI state only; failure surfaces solely as a retry label, with no detailed error reason.
