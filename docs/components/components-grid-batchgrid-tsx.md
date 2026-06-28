---
component: BatchGrid
source: components/grid/BatchGrid.tsx
agent: frontend
updated: 2026-06-28
---

# BatchGrid

## Purpose
Component C4: a responsive CSS grid of N result tiles that reflows desktop → tablet → phone (NFR-7 / architecture §2.1). It hosts the batch toolbar (whole-batch zip export + "New batch" reset) and surfaces reconnecting/gone batch notices.

## Public Interface
- `BatchGrid(): JSX.Element | null` — returns `null` when there are no items; takes no props.

## Inputs and Outputs
- Reads from store: `batch.items.length` (count), `batch.total`, `batch.done`, `batch.failed`, `batch.status`, and the `resetBatch` action.
- Renders a header with an `aria-live="polite"` progress line ("X of Y done · N error(s)").
- Status notices: `reconnecting` → reassurance note; `gone` → "batch no longer available" rejection note (finished images stay visible).
- Renders `count` `ResultTile`s keyed by fixed index `0..count-1`.
- Toolbar: always renders `DownloadAllButton`; renders a "New batch" button (calls `resetBatch`) only once the batch is settled (`status` is `done` or `gone`).

## Dependencies
- `ResultTile` — per-tile progressive result.
- `DownloadAllButton` — whole-batch zip export.
- `useBatchStore` (`lib/client/store`).

## Key Decisions
- The container subscribes ONLY to the item count and global progress counters, so a streamed result re-renders its single tile, not the whole grid.
- Tiles key on a fixed index because the list is append-only at launch and never reordered (justifies the array-index key).

## Known Limitations
- No empty/skeleton state beyond `null`; the grid only appears once items exist.
