/**
 * Upload client (component C2, frontend).
 *
 * Direct-to-Blob client upload via `@vercel/blob/client`'s `upload()` helper.
 *
 * ── Why this differs from architecture §7.2's idealized contract ──
 * Architecture §7.2 / product-flow §7 sketch a presigned-`PUT` flow returning
 * `{ uploadUrl, blobUrl }`. The REAL `@vercel/blob` (v2.5.0, Context7-verified)
 * has no such flow: client uploads are a TWO-PHASE token exchange driven by the
 * `upload()` helper, which POSTs a token-generate body to our `/api/uploads`
 * route (server-side `handleUpload`), receives a short-lived client token, then
 * PUTs the bytes straight to Blob and resolves to a `PutBlobResult`. The durable
 * handle is `result.url`. This is the cross-task fix actioned from
 * `docs/state/open-questions.md` (2026-06-26, raised by T3 backend).
 *
 * Contract the server route (`app/api/uploads/route.ts`) enforces:
 *   • `pathname` MUST start with `uploads/${kind}/` (path-namespace guard);
 *   • `clientPayload` MUST be `JSON.stringify({ kind })`, `kind ∈ {product, reference}`;
 *   • content-type allowlist + 10 MB cap are baked authoritatively into the
 *     minted token at Blob (the request carries no client-declared size).
 *
 * No secrets are read here — the Blob write token never leaves the server; the
 * browser only ever holds the short-lived, scoped client token minted per upload.
 */

import { upload } from "@vercel/blob/client";

/** Upload bucket — product image vs. style/mood reference (architecture §7.2). */
export type UploadKind = "product" | "reference";

/** Allowed content types, mirrored on the minted token (architecture §7.2). */
export type UploadContentType = "image/png" | "image/jpeg" | "image/webp";

/** Typed error surfaced to the uploader UI so each file can show a reason / retry. */
export class UploadError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/**
 * Upload one validated file directly to Blob and return its durable `blobUrl`.
 *
 * The caller validates the file first (`lib/client/fileValidation.ts`), so by the
 * time this runs `file.type` is guaranteed to be an allowed `UploadContentType`.
 * The pathname namespace (`uploads/${kind}/…`) and `clientPayload` ({ kind })
 * are exactly what the server route requires to mint the token.
 */
/**
 * Re-encode a WebP upload to JPEG in the browser (which decodes WebP natively via
 * canvas). Server-side image tooling — notably the `jimp` stitcher used for HF
 * Kontext reference style-transfer — cannot DECODE WebP, so an unconverted WebP
 * product image silently fails the whole item. Converting here keeps every provider
 * fed a format it can read. Non-WebP files pass through untouched; on any failure we
 * fall back to the original file rather than block the upload.
 */
async function toUploadable(file: File): Promise<File> {
  if (file.type !== "image/webp") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.92),
    );
    if (!blob) return file;
    const base = file.name.replace(/\.webp$/i, "") || file.name;
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export async function uploadFile(
  file: File,
  kind: UploadKind,
  signal?: AbortSignal,
): Promise<string> {
  const uploadable = await toUploadable(file);
  const contentType = uploadable.type as UploadContentType;
  try {
    const result = await upload(`uploads/${kind}/${uploadable.name}`, uploadable, {
      access: "public",
      handleUploadUrl: "/api/uploads",
      contentType,
      clientPayload: JSON.stringify({ kind }),
      abortSignal: signal,
    });
    return result.url;
  } catch (err) {
    // `upload()` throws when the token mint is rejected (bad kind/pathname/type),
    // when the network fails, or when Blob rejects the PUT (oversize/wrong type).
    const message = err instanceof Error && err.message ? err.message : "Upload failed.";
    throw new UploadError(message);
  }
}
