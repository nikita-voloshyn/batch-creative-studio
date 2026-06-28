---
component: zip (whole-batch export)
source: lib/client/zip.ts
agent: frontend
updated: 2026-06-28
---

# zip (whole-batch export)

## Purpose
Zips an entire batch's succeeded posts in the browser and triggers the download as `batch-{jobId}.zip`. Exists because the server only ever hands the client `result.imageUrl`s — there's no server route holding all bytes — so the client fetches each succeeded image and packs them with `fflate`.

## Public Interface
- `downloadBatchZip(posts, jobId, totalItems) → Promise<void>` — fetch all succeeded posts, pack them + a `MANIFEST.txt`, download the zip.
- `ExportPost` — `{ index, imageUrl, providerId, usedImageReference }` (one succeeded post; caller filters by status).

## Inputs and Outputs
- `downloadBatchZip`: throws `ExportError` if `posts` is empty; otherwise `fetchImageBytes` for every post in parallel (any single failure rejects the whole export); packs each as `post-{index+1}.{ext}` STORED (`level: 0`); generates a deflated `MANIFEST.txt`; `zipSync` → `Blob(application/zip)` → `saveBlob`. Archive named `batch-{jobId}.zip` or `batch.zip` when jobId absent.
- `buildManifest` (internal): header (job id, ISO export time), the only-succeeded note, an `Included posts: X of Y` line, per-post rows (`post-N.ext`, uppercased provider, style `image-reference`|`prompt-only`), and an omitted-count footer.

## Dependencies
- `fflate` — `strToU8`, `zipSync`, `Zippable`.
- `export.ts` — `fetchImageBytes`, `saveBlob`, `ExportError`.
- Browser-only (`"use client"`); no provider calls, no secrets.

## Key Decisions
- `fflate` over `jszip` — lighter dependency.
- Images are STORED (`level: 0`), not deflated — they're already compressed; only the text manifest is deflated (`level: 6`).
- Manifest documents that only succeeded posts are included and how many were skipped.
- Parallel fetch with all-or-nothing semantics — surfaced as a retryable "zip failed" in the control.

## Known Limitations
- One failed image fails the entire zip (no partial archive).
- Depends on cross-origin Blob CORS allowing the app origin — a CORS failure is a deploy-config (Task 13) concern.
- Builds the whole zip in memory; large batches are memory-bound.
