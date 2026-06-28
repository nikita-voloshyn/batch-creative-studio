---
component: export (single-post download)
source: lib/client/export.ts
agent: frontend
updated: 2026-06-28
---

# export (single-post download)

## Purpose
Downloads a single succeeded post at full resolution by fetching the cross-origin Blob image and saving it via a same-origin object URL. Exists because a bare `<a download>` is unreliable cross-origin — browsers ignore `download` on cross-origin navigation and open the image in the tab instead of saving it.

## Public Interface
- `downloadSinglePost(imageUrl, index) → Promise<void>` — saves one post as `post-{index+1}.{ext}`.
- `fetchImageBlob(url) → Promise<{ blob, ext }>` — fetch a Blob URL as a `Blob` + filename extension.
- `fetchImageBytes(url) → Promise<{ bytes: Uint8Array, ext }>` — fetch as raw bytes (used by the zip path).
- `saveBlob(blob, filename)` — trigger a download via a synthetic `<a download>` against a same-origin object URL.
- `extFromContentType(contentType, url?) → string` — derive a file extension from content-type, falling back to the URL extension then `png`.
- `class ExportError extends Error` — user-facing fetch/CORS/non-200 failure.

## Inputs and Outputs
- `fetchOk` (internal): `fetch`es the URL; network/CORS failure → `ExportError` ("couldn't reach the image"); non-ok → `ExportError("HTTP {status}")`.
- `extFromContentType`: strips charset params, maps known image content-types, else parses the URL pathname extension, else `png`.
- `saveBlob`: creates an object URL, clicks a hidden `<a download rel=noopener>`, removes it, and defers `revokeObjectURL` by 1s so the in-flight download isn't cancelled.

## Dependencies
- Browser APIs only — `fetch`, `Blob`, `URL.createObjectURL`, DOM. No provider calls, no secrets. (`"use client"`.)
- Consumed by `zip.ts` (`fetchImageBytes`, `saveBlob`, `ExportError`).

## Key Decisions
- Fetch-then-object-URL is required for reliable cross-origin saves.
- Filename `post-{index+1}` lines up the single download with the same post inside a whole-batch zip.
- Deferred (not synchronous) revoke avoids cancelling the started download.

## Known Limitations
- Depends on the result Blob bucket serving permissive CORS (allows the app origin) — a CORS failure is a deploy-config (Task 13) concern, not a server route.
- Loads the full image into memory before saving (no streaming to disk).
