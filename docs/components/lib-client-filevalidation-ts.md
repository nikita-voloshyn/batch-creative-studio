---
component: fileValidation
source: lib/client/fileValidation.ts
agent: frontend
updated: 2026-06-28
---

# fileValidation

## Purpose
Client-side, pre-upload validation of a single image: format, size, decodes-as-image, and resolution bounds. A UX convenience and defense-in-depth first line — never a trust boundary (the server re-validates content-type + size authoritatively via the signed Blob token).

## Public Interface
- `validateImageFile(file) → Promise<FileValidationResult>` — async (decodes the image for dimensions).
- `FileValidationResult` — `{ ok: true; contentType; width; height } | { ok: false; reason: string }`.
- Constants: `ALLOWED_CONTENT_TYPES` (png/jpeg/webp), `MAX_FILE_BYTES` (10 MB), `MIN_IMAGE_DIMENSION` (256), `MAX_IMAGE_DIMENSION` (8192), `MAX_PRODUCT_IMAGES` (20), `MAX_REFERENCE_IMAGES` (2).

## Inputs and Outputs
- `validateImageFile` runs checks in order — format → size → decodes-as-image → resolution bounds — returning the first failing reason as a human-readable string, else `{ ok: true, ... }` with detected dimensions.
- `readImageDimensions` (internal): loads the file via an object URL into an `Image`; resolves dimensions on load, `null` on decode error (corrupt/disguised file); always revokes the object URL.

## Dependencies
- `uploadClient` — `UploadContentType` (type-only).

## Key Decisions
- Resolution bounds (256–8192px) are chosen defaults — docs require a check but don't pin numbers; kept as exported constants so a future task can lift them to config.
- N/R caps live in the store/uploader, not here — this module validates one file in isolation; the caps are merely re-exported as constants for convenience.
- Dimension check decodes the actual bytes, catching files with a faked MIME type.

## Known Limitations
- Not a security boundary; the server is authoritative.
- Validates one file at a time; cannot enforce batch-level caps.
