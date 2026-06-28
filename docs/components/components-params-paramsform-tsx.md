---
component: ParamsForm
source: components/params/ParamsForm.tsx
agent: frontend
updated: 2026-06-28
---

# ParamsForm

## Purpose
Component C3: captures the batch params that mirror `Job.params` (architecture §7.1) — aspect ratio (`1:1` default), an optional batch-wide brief, and optional per-image caption hints (one row per product image).

## Public Interface
- `ParamsForm({ disabled?: boolean }): JSX.Element` — `disabled` locks every control while a batch is in flight so params can't drift from what the running batch launched with.

## Inputs and Outputs
- Reads from store: `params.aspectRatio`, `params.brief`, `entries`; actions `setAspectRatio`, `setBrief`, `setEntryHint`.
- Aspect ratio: segmented control over `["1:1", "4:5", "9:16"]`; selected option marked with `aria-pressed`, calls `setAspectRatio(ratio)`.
- Brief: `<textarea>` bound to `params.brief` via `setBrief`.
- Per-image hints: only rendered when `selectProducts(entries)` is non-empty; one row per product with a thumbnail and a text input bound to `entry.hint` via `setEntryHint(entry.id, value)`.

## Dependencies
- `useBatchStore` / `selectProducts` (`lib/client/store`).
- `AspectRatio` (`lib/types`).

## Key Decisions
- Per-image hints live on the product entry, not on an `Item`; they are resolved into `perImageHints` keyed by the product's `blobUrl` at submit time (product-flow §0/§2.5, decisions.md 2026-06-26). There is no `Item.captionHint`.
- `useId()` ties the brief label to its textarea for accessibility.

## Known Limitations
- No validation/length cap on brief or hints in this component; constraints (if any) are applied at submit/store level.
