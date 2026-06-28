---
component: DropZone
source: components/uploader/DropZone.tsx
agent: frontend
updated: 2026-06-28
---

# DropZone

## Purpose
Component C2 presentational drag&drop surface + file picker. It only collects `File[]` and hands them to `onFiles`; validation, caps, and upload all live in the store.

## Public Interface
- `DropZone(props): JSX.Element` where `props` is:
  - `label: string` — accessible label for the zone.
  - `hint: string` — muted helper line under the label.
  - `multiple: boolean` — whether the picker accepts multiple files.
  - `disabled?: boolean` — disables click/drag/drop.
  - `disabledLabel?: string` — message shown in place of the drop prompt while disabled (e.g. "Limit reached" vs "Locked while generating").
  - `onFiles: (files: File[]) => void` — callback with collected files.

## Inputs and Outputs
- Accepts files via native picker (`<input type="file" hidden>`) or drag&drop; both paths call `onFiles` only when `files.length > 0`.
- `accept` is `ALLOWED_CONTENT_TYPES.join(",")`.
- After a picker selection, resets `input.value = ""` so re-selecting the same file fires `onChange` again.
- `active` highlight state tracks drag-over; cleared only when the pointer truly leaves the zone (checks `relatedTarget` containment to avoid child-element flicker).

## Dependencies
- `ALLOWED_CONTENT_TYPES` (`lib/client/fileValidation`) — picker `accept` list.

## Key Decisions
- Rendered as a native `<button>` so it is keyboard- and screen-reader-accessible for free; drop handlers ride on the same element.
- Drag-leave guard via `currentTarget.contains(relatedTarget)` prevents flicker when hovering child elements.

## Known Limitations
- No client-side type/size filtering here by design — it forwards everything; rejection happens in the store.
