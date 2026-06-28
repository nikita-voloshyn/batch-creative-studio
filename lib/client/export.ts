/**
 * Client export — single-post download (component C6, frontend).
 *
 * Result images live in Vercel Blob under a public, CROSS-ORIGIN URL
 * (`result.imageUrl`). A bare `<a download href={blobUrl}>` is unreliable
 * cross-origin: browsers ignore the `download` attribute on a cross-origin
 * navigation and the image opens in the tab instead of saving. So we `fetch`
 * the bytes, wrap them in a same-origin object URL, and click an `<a download>`
 * against THAT — which always saves (product-flow §2 step 13, §5m).
 *
 * Cross-origin `fetch` of the result Blob depends on the result bucket serving
 * permissive CORS (it allows the app origin). Vercel Blob public URLs do this by
 * default; if a deploy ever sees a CORS error here it is a Task 13 (deploy
 * config) concern — NOT a server route (the browser fetches Blob directly).
 *
 * Browser-only module ("use client" consumers): touches `fetch`, `Blob`,
 * `URL.createObjectURL`, and the DOM. No provider calls, no secrets.
 */

"use client";

/** Map a result's content-type to the download-filename extension. */
const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

/** A user-facing export failure (cross-origin fetch / CORS / non-200). */
export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/**
 * Derive a file extension from the response content-type, falling back to the
 * URL's own extension and finally to `png`. Tolerant of `image/png; charset=…`.
 */
export function extFromContentType(contentType: string | null | undefined, url?: string): string {
  const ct = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (ct && CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct];
  if (url) {
    try {
      const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
      if (match?.[1]) return match[1].toLowerCase();
    } catch {
      // Malformed URL — fall through to the default.
    }
  }
  return "png";
}

/** Fetch a cross-origin Blob URL, throwing a user-facing `ExportError` on failure. */
async function fetchOk(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // Network failure OR a CORS rejection both surface here (no readable status).
    throw new ExportError("Couldn't reach the image — check your connection and try again.");
  }
  if (!res.ok) throw new ExportError(`Couldn't fetch the image (HTTP ${res.status}).`);
  return res;
}

/**
 * Fetch a cross-origin Blob image as a `Blob` plus the extension for its
 * filename. Used by the single-post download (where a `Blob` saves directly).
 */
export async function fetchImageBlob(url: string): Promise<{ blob: Blob; ext: string }> {
  const res = await fetchOk(url);
  const blob = await res.blob();
  return { blob, ext: extFromContentType(blob.type || res.headers.get("content-type"), url) };
}

/**
 * Fetch a cross-origin Blob image as raw bytes plus the extension for its
 * filename. Used by the zip path (`fflate` packs `Uint8Array`s).
 */
export async function fetchImageBytes(url: string): Promise<{ bytes: Uint8Array; ext: string }> {
  const res = await fetchOk(url);
  const buffer = await res.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    ext: extFromContentType(res.headers.get("content-type"), url),
  };
}

/**
 * Save a Blob to disk via a same-origin object URL + a synthetic `<a download>`
 * click. Revokes the object URL shortly after so the started download keeps it.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Defer revoke: revoking synchronously can cancel the in-flight download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * Download one succeeded post at full resolution. `index` is the tile's
 * zero-based grid position; the saved filename is `post-{index+1}.{ext}` so it
 * lines up with the same post inside a whole-batch zip.
 */
export async function downloadSinglePost(imageUrl: string, index: number): Promise<void> {
  const { blob, ext } = await fetchImageBlob(imageUrl);
  saveBlob(blob, `post-${index + 1}.${ext}`);
}
