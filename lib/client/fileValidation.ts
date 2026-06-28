/**
 * Client-side file validation (component C2, frontend).
 *
 * Enforces, before a file is ever uploaded: format (`png/jpg/webp`), size
 * (≤ 10 MB), and resolution bounds (FR-1.3 / product-flow §2.2). This is a UX
 * convenience and a defense-in-depth first line — the server re-validates
 * content-type + size authoritatively via the signed Blob token (architecture
 * §8.1 / §9); client validation is never a trust boundary.
 *
 * The N (product ≤ 20) and R (reference 1–2) caps are enforced in the store /
 * uploader, not here — this module validates a single file in isolation.
 */

import type { UploadContentType } from "./uploadClient";

/** Accepted MIME types (architecture §7.2 / README §3). */
export const ALLOWED_CONTENT_TYPES: readonly UploadContentType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Max upload size — 10 MB (README §3 / architecture §9). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Resolution bounds. The docs require a "resolution check" (FR-1.3 / product-flow
 * §2.2) but do not pin exact numbers, so these are chosen defaults: reject images
 * too small to make a usable post and absurdly large ones that would bloat the
 * batch. They are constants here so a future task can lift them to config.
 */
export const MIN_IMAGE_DIMENSION = 256;
export const MAX_IMAGE_DIMENSION = 8192;

/** Caps (product-flow §0: 1 ≤ N ≤ 20 product, 1 ≤ R ≤ 2 reference). */
export const MAX_PRODUCT_IMAGES = 20;
export const MAX_REFERENCE_IMAGES = 2;

export type FileValidationResult =
  | { ok: true; contentType: UploadContentType; width: number; height: number }
  | { ok: false; reason: string };

function isAllowedContentType(type: string): type is UploadContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(type);
}

/** Human-readable MB for messages. */
function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Read an image's natural dimensions via an object URL. Resolves to `null` if
 * the bytes do not decode as an image (a corrupt/disguised file).
 */
function readImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Validate one file: format → size → decodes-as-image → resolution bounds.
 * The first failing check produces a file-named-friendly reason.
 */
export async function validateImageFile(file: File): Promise<FileValidationResult> {
  if (!isAllowedContentType(file.type)) {
    return { ok: false, reason: "unsupported format (png/jpg/webp only)" };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, reason: `too large (${mb(file.size)} > 10 MB)` };
  }

  const dims = await readImageDimensions(file);
  if (!dims) {
    return { ok: false, reason: "could not be read as an image" };
  }
  if (dims.width < MIN_IMAGE_DIMENSION || dims.height < MIN_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `resolution too small (${dims.width}×${dims.height}, min ${MIN_IMAGE_DIMENSION}px)`,
    };
  }
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    return {
      ok: false,
      reason: `resolution too large (${dims.width}×${dims.height}, max ${MAX_IMAGE_DIMENSION}px)`,
    };
  }

  return { ok: true, contentType: file.type, width: dims.width, height: dims.height };
}
