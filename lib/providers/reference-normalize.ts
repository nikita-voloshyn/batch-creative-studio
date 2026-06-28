/**
 * Reference-image normalization + low-level image fetching (owner: providers — PV).
 *
 * One-time-per-job preprocessing reused across every Item (architecture §4):
 * the composition root calls `normalizeReferences` once and threads the result
 * into each Item's `GenerateInput.referenceImageUrls`, avoiding per-Item fetch
 * cost (spec risk §16).
 *
 * Dependency choice (deliberately dependency-light): no native image library.
 * `sharp` is blocked by pnpm's build-script policy (task note / decisions.md),
 * and a pure-JS PNG/JPEG codec would be heavy. MVP normalization is therefore
 * fetch-once + validate (type/size) + inline-encode as a `data:` URL, so the
 * SAME bytes are reused by every Item with NO per-Item network round-trip. True
 * pixel downscale/crop is deferred until an image lib is approved (run
 * `pnpm approve-builds` for `sharp`, or adopt a lighter WASM codec).
 *
 * Note: these fetches trust already-validated app-origin Blob URLs; SSRF
 * validation of user-supplied URLs is the backend's responsibility (architecture §9).
 */

/** Decoded inline image: base64 + raw bytes + the resolved MIME type. */
export type InlineImage = {
  mimeType: string;
  base64: string;
  bytes: Uint8Array;
  byteLength: number;
};

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024; // 8 MiB

/**
 * Job-level precondition failure raised when a reference image cannot be
 * fetched/validated. The backend maps this to `Job.status = "failed"` with code
 * `reference_normalization_failed` (architecture §4 / §5.1) — no Items run.
 */
export class ReferenceNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceNormalizationError";
  }
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function normalizeMime(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "image/jpg") return "image/jpeg";
  return lower.startsWith("image/") ? lower : undefined;
}

/** Minimal magic-byte sniff for when a Content-Type header is missing/wrong. */
export function sniffMime(b: Uint8Array): string | undefined {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function decodeDataUrl(url: string): InlineImage {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  if (!match) throw new Error("Malformed data: URL");
  const mimeType = normalizeMime(match[1]) ?? match[1]?.trim() ?? "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const bytes = isBase64
    ? new Uint8Array(Buffer.from(payload, "base64"))
    : new Uint8Array(Buffer.from(decodeURIComponent(payload), "utf8"));
  return {
    mimeType,
    base64: isBase64 ? payload : toBase64(bytes),
    bytes,
    byteLength: bytes.byteLength,
  };
}

/**
 * Fetch a single image (HTTP(S) Blob URL or `data:` URL) into an `InlineImage`.
 * Used by adapters to build inline parts and by `normalizeReferences`. Honors
 * the optional `AbortSignal`. Throws a plain `Error` on fetch/decode failure;
 * each caller maps it to the appropriate typed error.
 */
export async function fetchImageAsInlineData(
  url: string,
  signal?: AbortSignal,
): Promise<InlineImage> {
  if (url.startsWith("data:")) return decodeDataUrl(url);

  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(`Image fetch failed with HTTP ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headerMime = normalizeMime(response.headers.get("content-type")?.split(";")[0]);
  const mimeType = headerMime ?? sniffMime(bytes) ?? "application/octet-stream";
  return { mimeType, base64: toBase64(bytes), bytes, byteLength: bytes.byteLength };
}

/**
 * Normalize the batch's 1..2 reference images once. Returns inline `data:` URLs
 * (bytes carried so adapters reuse them without re-fetching). Throws
 * `ReferenceNormalizationError` on any precondition failure so the backend can
 * fail the whole job before any Item runs.
 */
export async function normalizeReferences(
  referenceImageUrls: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (referenceImageUrls.length < 1 || referenceImageUrls.length > 2) {
    throw new ReferenceNormalizationError(
      `Expected 1-2 reference images, received ${referenceImageUrls.length}.`,
    );
  }

  const normalized: string[] = [];
  for (const url of referenceImageUrls) {
    let image: InlineImage;
    try {
      image = await fetchImageAsInlineData(url, signal);
    } catch (cause) {
      throw new ReferenceNormalizationError(
        `Could not fetch a reference image: ${(cause as Error).message}`,
      );
    }
    if (!ALLOWED_MIME.has(image.mimeType)) {
      throw new ReferenceNormalizationError(
        `Unsupported reference image type "${image.mimeType}" (allowed: png, jpeg, webp).`,
      );
    }
    if (image.byteLength > MAX_REFERENCE_BYTES) {
      throw new ReferenceNormalizationError(
        `Reference image is too large (${image.byteLength} bytes; max ${MAX_REFERENCE_BYTES}).`,
      );
    }
    normalized.push(`data:${image.mimeType};base64,${image.base64}`);
  }
  return normalized;
}
