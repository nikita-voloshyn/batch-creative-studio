/**
 * Result-bytes Blob writer (component C19 result-persist, backend — BE).
 *
 * The backend is the SOLE WRITER of result bytes (product-flow §0). After a
 * provider returns, the orchestration calls `persistResult`, which writes the
 * image to Vercel Blob under the PER-ITEM, attempt-independent key
 * `results/{jobId}/{itemId}.{ext}` ({ext} from the result content-type) with
 * LAST-WRITER-WINS semantics — every successful attempt (initial, retry,
 * failover, or post-terminal targeted retry) overwrites the SAME object, so an
 * item never yields more than one distinct result blob and there are no orphans
 * (architecture §5.5 / §8.1, decisions.md 2026-06-26).
 *
 * `@vercel/blob` server `put()` (Context7-verified, v2.5.0):
 *   put(pathname, body, { access, addRandomSuffix, allowOverwrite, contentType,
 *                         token, abortSignal })
 * Last-writer-wins requires `addRandomSuffix: false` (stable key) +
 * `allowOverwrite: true` (overwrite the existing object instead of throwing).
 * The write token `BLOB_READ_WRITE_TOKEN` is read here and stays server-side.
 *
 * `GenerateResult.imageBytes` is `Uint8Array | string`:
 *  - raw bytes  → content-type sniffed from magic bytes, written directly;
 *  - a provider URL (e.g. Replicate, Task 9) → fetched under an SSRF-restricted
 *    guard (https only, no private/link-local hosts, size + type caps), then
 *    written. Adapters never persist; `item.result.imageUrl` therefore always
 *    points at the stable per-item Blob key, never an ephemeral provider URL.
 */
import { put } from "@vercel/blob";

const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_RESULT_BYTES = 25 * 1024 * 1024; // 25 MiB guard for fetched provider URLs
const PROVIDER_FETCH_TIMEOUT_MS = 30_000;

export type PersistResultArgs = {
  jobId: string;
  itemId: string;
  /** Raw image bytes, or a provider URL the backend must re-persist. */
  imageBytes: Uint8Array | string;
  /**
   * Adapter-declared MIME type of the result (`GenerateResult.contentType`), when
   * known. PREFERRED for deriving the result-blob `{ext}` over magic-byte sniffing
   * (and, for a provider-URL result, over an absent/disallowed response header).
   * Threading it keeps `{ext}` stable across a format-changing failover (e.g.
   * Gemini PNG → Cloudflare WEBP) for the per-item last-writer-wins key
   * (decisions.md 2026-06-26; resolves Task-5 review L2 / Task-8 flag).
   */
  contentType?: string;
  /** Job-level abort signal (cancel the Blob write / provider-URL fetch). */
  signal?: AbortSignal;
};

export type PersistedResult = {
  /** Stable public URL of the per-item result object. */
  imageUrl: string;
  /** Resolved content-type written to Blob. */
  contentType: string;
};

/** Map a content-type to the result-key file extension. */
function extForContentType(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    default:
      return "png";
  }
}

/** Minimal magic-byte sniff (png / jpeg / webp); defaults to image/png. */
function sniffContentType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return "image/png";
}

/**
 * Normalize a candidate MIME (strip params, lowercase) and return it only if it is
 * an allowed image type; otherwise `undefined`. Used to vet both the adapter-
 * declared `contentType` and an HTTP `Content-Type` header before trusting them.
 */
function allowedContentType(candidate: string | null | undefined): string | undefined {
  const normalized = candidate?.split(";")[0]?.trim().toLowerCase();
  return normalized && ALLOWED_CONTENT_TYPES.has(normalized) ? normalized : undefined;
}

/** Reject obviously-private / link-local / metadata hosts (SSRF guard). */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true;
  // Literal IPv4 in a private / loopback / link-local range.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  return false;
}

/** Fetch a provider result URL under the SSRF guard; returns bytes + content-type. */
async function fetchProviderResult(
  url: string,
  preferredContentType: string | undefined,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Provider result URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Provider result URL must be https (got ${parsed.protocol}).`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Provider result URL host is not allowed: ${parsed.hostname}`);
  }

  const timeout = AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS);
  const composedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(parsed, { signal: composedSignal, redirect: "error" });
  if (!response.ok) {
    throw new Error(`Provider result fetch failed: HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("Provider result fetch returned zero bytes.");
  if (bytes.byteLength > MAX_RESULT_BYTES) {
    throw new Error(`Provider result is too large (${bytes.byteLength} bytes).`);
  }
  // Trust the response header first (it describes the bytes actually fetched),
  // then the adapter-declared content-type, then magic-byte sniffing.
  const contentType =
    allowedContentType(response.headers.get("content-type")) ??
    allowedContentType(preferredContentType) ??
    sniffContentType(bytes);
  return { bytes, contentType };
}

/**
 * Write one item's result bytes to the stable per-item key (last-writer-wins) and
 * return the public URL + content-type. Throws on an empty/invalid body or a Blob
 * failure; the caller (orchestrator) classifies such failures as retryable
 * (product-flow §5k).
 */
export async function persistResult(args: PersistResultArgs): Promise<PersistedResult> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error("Result store is not configured (missing BLOB_READ_WRITE_TOKEN).");
  }

  let bytes: Uint8Array;
  let contentType: string;
  if (typeof args.imageBytes === "string") {
    ({ bytes, contentType } = await fetchProviderResult(
      args.imageBytes,
      args.contentType,
      args.signal,
    ));
  } else {
    bytes = args.imageBytes;
    if (bytes.byteLength === 0) throw new Error("Result image has zero bytes.");
    // Prefer the adapter-declared content-type; fall back to magic-byte sniffing.
    contentType = allowedContentType(args.contentType) ?? sniffContentType(bytes);
  }

  const ext = extForContentType(contentType);
  const key = `results/${args.jobId}/${args.itemId}.${ext}`;

  const result = await put(key, Buffer.from(bytes), {
    access: "public",
    contentType,
    addRandomSuffix: false, // stable per-item key …
    allowOverwrite: true, // … overwritten last-writer-wins (no orphan blobs)
    token,
    abortSignal: args.signal,
  });

  return { imageUrl: result.url, contentType };
}
