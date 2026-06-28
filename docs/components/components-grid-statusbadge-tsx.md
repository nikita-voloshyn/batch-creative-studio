---
component: StatusBadge
source: components/grid/StatusBadge.tsx
agent: frontend
updated: 2026-06-28
---

# StatusBadge

## Purpose
Component C4 presentational label that renders a tile's item state as an ALL-CAPS label in the muted/functional status register (product-flow §3).

## Public Interface
- `StatusBadge({ status }: { status: TileStatus }): JSX.Element` — renders `<span class="status status--<status>">LABEL</span>`.

## Inputs and Outputs
- Maps `TileStatus` via `STATUS_LABEL`: `queued`→"Queued", `generating`→"Generating", `done`→"Done", `failed`→"Failed".
- Emits class `status--<status>` for per-state coloring.

## Dependencies
- `TileStatus` (`lib/client/store`) — status union.

## Key Decisions
- Colors live in `app/globals.css` (`.status--*`); the `.status` class applies the uppercase transform — styling is kept out of the component.

## Known Limitations
- Pure label only; no icons or animation (the parent tile owns overlays/placeholders).
