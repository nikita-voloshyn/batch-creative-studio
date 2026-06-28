---
component: ReferenceNormalize
source: lib/providers/reference-normalize.ts
agent: providers
updated: 2026-06-28
---

# ReferenceNormalize

## Purpose
One-time-per-job preprocessing plus the low-level image-fetch helper shared by every adapter. The composition root normalizes the 1..2 reference images once into reusable inline `data:` URLs, avoiding per-item fetch cost.

## Public Interface
- `type InlineImage` — `{ mimeType, base64, bytes: Uint8Array, byteLength }`.
- `class ReferenceNormalizationError extends Error` — job-level precondition failure.
- `sniffMime(b: Uint8Array): string | undefined` — magic-byte sniff for png/jpeg/webp.
- `fetchImageAsInlineData(url, signal?): Promise<InlineImage>` — fetch one HTTP(S) or `data:` image into an `InlineImage`.
- `normalizeReferences(referenceImageUrls, signal?): Promise<string[]>` — validate + inline the batch's references as `data:` URLs.

## Inputs and Outputs
- `fetchImageAsInlineData`: `data:` URL → decoded locally (no network); else `fetch` (honors `signal`), non-2xx → throws plain `Error`; MIME resolved from header then `sniffMime` then `application/octet-stream`.
- `normalizeReferences`: requires 1..2 URLs (else `ReferenceNormalizationError`); per URL validates MIME ∈ {png, jpeg, webp} and size ≤ 8 MiB; returns `data:{mime};base64,{...}` strings. Fetch failure → wrapped in `ReferenceNormalizationError`.
- The backend maps `ReferenceNormalizationError` to `Job.status = "failed"` with code `reference_normalization_failed` — no items run.

## Dependencies
- None (Node `Buffer`/`fetch` only). Consumed by the Gemini/Cloudflare/HuggingFace adapters (`fetchImageAsInlineData`, `sniffMime`) and the composition root (`normalizeReferences`).

## Key Decisions
- Deliberately dependency-light: no native image lib. `sharp` is blocked by pnpm's build-script policy and a pure-JS codec would be heavy. MVP normalization = fetch-once + validate (type/size) + inline-encode, so the SAME bytes are reused by every item with no per-item round-trip.
- `normalizeMime` folds `image/jpg` → `image/jpeg`; `sniffMime` backstops a missing/wrong `Content-Type`.

## Known Limitations
- No true pixel downscale/crop — deferred until an image lib is approved (`pnpm approve-builds` for `sharp`, or a WASM codec). Oversized references can be rejected/cropped downstream (e.g. Cloudflare 512×512 cap).
- Fetches trust already-validated app-origin Blob URLs; SSRF validation of user-supplied URLs is the backend's responsibility.
