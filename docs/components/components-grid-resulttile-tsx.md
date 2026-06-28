---
component: ResultTile
source: components/grid/ResultTile.tsx
agent: frontend
updated: 2026-06-28
---

# ResultTile

## Purpose
Component C4: a single batch tile that subscribes to its own store slice (`batch.items[index]`) and renders independently the moment its result arrives — progressive, never blocking on the slowest tile.

## Public Interface
- `ResultTile({ index }: { index: number }): JSX.Element | null` — returns `null` if no item exists at `index`.

## Inputs and Outputs
- Reads from store: `batch.items[index]`, `batch.aspectRatio`, and the `retry` action.
- Frame uses `aspect-ratio` CSS from `RATIO_CSS` map (`1:1`/`4:5`/`9:16`).
- States (product-flow §3):
  - QUEUED / GENERATING → dimmed product placeholder (`item.previewUrl`, `aria-hidden`) with a `StatusBadge` overlay.
  - DONE (`status === "done"` and `item.result`) → result image as hero, with provider meta (`providerId` uppercased) and a `DownloadPostButton`.
  - FAILED (`status === "failed"` and `item.error`) → "Failed" label, human-readable `message`, optional `lastProviderId`, and either a Retry button (calls `retry(item.itemId)`) or, for input-fatal causes, an "adjust brief / replace image" hint.
- `INPUT_FATAL_CODES = {content_policy, invalid_input}` selects the §5i affordance instead of a bare retry.

## Dependencies
- `StatusBadge` — overlay status label.
- `DownloadPostButton` — single-post save on DONE tiles.
- `useBatchStore` (`lib/client/store`).
- `AspectRatio` (`lib/types`).

## Key Decisions
- Per-tile store subscription enables progressive rendering without re-rendering siblings.
- Content-policy / invalid-input failures suppress Retry because re-running the same input deterministically fails again (§5i).
- Retry is disabled until `item.itemId` is known (server-assigned), preventing a retry call without a target.

## Known Limitations
- Relies on `item.previewUrl` for the placeholder; if absent, no placeholder image is shown (frame only).
