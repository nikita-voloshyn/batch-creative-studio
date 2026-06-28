/**
 * SSRF guard for user-supplied image URLs (route/validation layer, backend — BE).
 *
 * `POST /api/jobs` receives `productImageUrls` + `referenceImageUrls` that the
 * server will later hand to provider adapters (which `fetch` them to inline the
 * image bytes). Those URLs are validated HERE, before any Job/Item exists and
 * before any adapter sees them (architecture §9, product-flow §5h). The rules:
 *
 *   • scheme MUST be `https:` (no `http`/`file`/`data`/`blob`/…);
 *   • no embedded credentials (`user:pass@host`);
 *   • host MUST be on the Vercel Blob allowlist (the URL must have come from
 *     `/api/uploads`) — i.e. a `*.public.blob.vercel-storage.com` host
 *     (overridable via `BLOB_ALLOWED_HOST_SUFFIXES`);
 *   • host MUST NOT be a private / loopback / link-local / unique-local /
 *     cloud-metadata address (defense in depth — the allowlist already excludes
 *     them, but an explicit block keeps the intent obvious and survives a looser
 *     allowlist).
 *
 * This module does NOT fetch anything (so there is no redirect to follow); it is
 * a pure, synchronous validator. The provider-result-URL SSRF guard for
 * re-persisting (e.g. Replicate) lives separately in `lib/blob/result-store.ts`.
 */

/** Default allowed Vercel Blob public-host suffix (the bucket subdomain varies). */
const DEFAULT_BLOB_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** Result of validating one user-supplied URL. */
export type SsrfCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Allowed host suffixes — env override (`BLOB_ALLOWED_HOST_SUFFIXES`, CSV) or default. */
function allowedHostSuffixes(): string[] {
  const raw = process.env.BLOB_ALLOWED_HOST_SUFFIXES;
  if (raw && raw.trim() !== "") {
    return raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "");
  }
  return [DEFAULT_BLOB_HOST_SUFFIX];
}

/** True if `hostname` is on the Vercel Blob allowlist. */
function isAllowedBlobHost(hostname: string): boolean {
  return allowedHostSuffixes().some(
    (suffix) =>
      hostname.endsWith(suffix) ||
      // also accept the bare suffix host (without a leading-dot subdomain)
      hostname === suffix.replace(/^\./, ""),
  );
}

/**
 * Reject private / loopback / link-local / unique-local / metadata hosts. Covers
 * literal IPv4 (10/8, 127/8, 0/8, 169.254/16, 172.16-31, 192.168/16, 100.64/10),
 * literal IPv6 (`::1`, `fc..`/`fd..` ULA, `fe80..` link-local), and the well-known
 * loopback / cloud-metadata hostnames.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal" || host.endsWith(".internal")) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  if (host === "::1" || host === "::") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // unique-local
  if (host.startsWith("fe80")) return true; // link-local
  return false;
}

/** Validate one user-supplied image URL against the SSRF policy. */
export function checkUserImageUrl(raw: unknown): SsrfCheck {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "must be a non-empty string" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `scheme must be https (got "${url.protocol}")` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "must not embed credentials" };
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedHost(host)) {
    return { ok: false, reason: "host is a private/loopback/link-local/metadata address" };
  }
  if (!isAllowedBlobHost(host)) {
    return { ok: false, reason: "host is not an allowed Vercel Blob host" };
  }
  return { ok: true, url };
}

/**
 * Validate a whole array of user image URLs. Returns the first failure (with the
 * offending value + index) so the route can answer 400 with a precise reason.
 */
export function checkUserImageUrls(
  values: unknown[],
  label: string,
): { ok: true } | { ok: false; reason: string } {
  for (let i = 0; i < values.length; i++) {
    const check = checkUserImageUrl(values[i]);
    if (!check.ok) {
      return { ok: false, reason: `${label}[${i}] ${check.reason}` };
    }
  }
  return { ok: true };
}
