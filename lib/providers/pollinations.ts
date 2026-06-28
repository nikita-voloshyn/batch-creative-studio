/**
 * Pollinations adapter (owner: providers — PV).
 *
 * Free image provider behind the `ImageProvider` contract. Implements the API
 * over a plain `fetch` GET, no SDK — the closest sibling of `cloudflare.ts`.
 * Live-tested against the current Pollinations image endpoint:
 *
 *   GET https://image.pollinations.ai/prompt/{encodeURIComponent(prompt)}
 *       ?model={model}&width={w}&height={h}&seed={seed}&nologo=true
 *       &image={productUrl}&image={refUrl}...
 *   Authorization: Bearer {POLLINATIONS_TOKEN}   (free account token)
 *   Referer:       https://pollinations.ai
 *
 * The default image-INPUT (img2img) model is `gptimage`, which is live-verified
 * to work with a FREE account token (token + `image=<url>` → 200, conditioning on
 * the input image). The premium models (`nanobanana` = Google Nano Banana /
 * Gemini 2.5 Flash Image, `kontext` = Flux Kontext, `seedream`) 500 with "only
 * available on enter.pollinations.ai" even WITH the free token, so they are not
 * the default. Every image-input model REQUIRES a token; without one the `image`
 * param is silently ignored, so the registry GATES this adapter on
 * `POLLINATIONS_TOKEN` (omitted when unset) — exactly like Cloudflare is gated on
 * account id + token. Therefore the token is always present here.
 *
 * The `image` query param accepts an ARRAY (repeat the key). We pass the PRODUCT
 * image first (the subject to preserve) then the style reference(s): if a model
 * honors only one, product-first is the correct conditioning.
 *
 * Response: success → a binary image (`Content-Type: image/*`); failure → JSON
 * `{ "error": ..., "message": ... }`. A 5xx whose message says the model "is only
 * available on enter.pollinations.ai" means the token is missing/invalid — that
 * is mapped to a NEUTRAL `auth` fact (fatal → advance provider), NOT a retryable
 * server error. The retry/fatal POLICY itself lives in the backend retry engine
 * (see `errors.ts`).
 */

import { aspectRatioDimensions, pollinationsModel, pollinationsToken } from "./config";
import {
  errorMessageOf,
  isAbortError,
  kindFromHttpStatus,
  ProviderError,
  type ProviderErrorKind,
  retryAfterMsFromHeader,
} from "./errors";
import { sniffMime } from "./reference-normalize";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types";

const PROVIDER_ID = "pollinations";
const API_BASE = "https://image.pollinations.ai/prompt";
/** Sent so Pollinations honors the per-account token rate limit + model access. */
const REFERER = "https://pollinations.ai";

/**
 * Build a Pollinations adapter. Throws `ProviderError("auth", ...)` when the
 * token is absent — the registry omits the uncredentialed provider, so the token
 * is present here in practice. `supportsImageReference: true`: the configured
 * image-editing model conditions on the supplied product + reference image(s).
 */
export function createPollinationsProvider(): ImageProvider {
  const token = pollinationsToken();
  if (!token) {
    throw new ProviderError("auth", PROVIDER_ID, "POLLINATIONS_TOKEN is not configured.");
  }
  const model = pollinationsModel();

  return {
    id: PROVIDER_ID,
    supportsImageReference: true,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      const startedAt = Date.now();
      throwIfAborted(signal);

      const endpoint = buildEndpoint(input, model);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: REFERER,
          },
          signal,
        });
      } catch (cause) {
        throw mapThrown(cause, signal, "Pollinations request failed");
      }

      if (!response.ok) {
        throw await mapHttpError(response);
      }

      const decoded = await decodeImageResponse(response, signal);

      return {
        imageBytes: decoded.bytes,
        providerId: PROVIDER_ID,
        // The product is always image-conditioned. `usedImageReference` is honest
        // about the STYLE references: only http(s) reference URLs are sent to
        // Pollinations as `image=` (see buildEndpoint) — inlined `data:` refs are
        // dropped and carried by the prompt text, so they are NOT image-conditioned.
        usedImageReference: input.referenceImageUrls.some((u) => /^https?:\/\//i.test(u)),
        contentType: decoded.contentType,
        meta: { latencyMs: Date.now() - startedAt, model },
      };
    },
  };
}

/**
 * Build the request URL: the prompt sits in the PATH (`encodeURIComponent`), the
 * rest are query params. `image` is repeated — product FIRST, then the style
 * reference(s) — so the array the server parses is `[productUrl, ...refUrls]`.
 *
 * IMPORTANT: only **http(s)** image URLs go into `image=`. Pollinations FETCHES
 * each `image=` URL server-side, and the param lives in the GET query — so a
 * `data:` URL is both unfetchable and catastrophic for URL length (the orchestrator
 * inlines references to base64 `data:` URLs for the inline-conditioning providers;
 * a single one blows past the ~8 KB request-URI limit → HTTP 414). The product
 * stays an http Blob URL, so it is always conditioned; `data:` references are
 * dropped here and their style is carried by the prompt text instead.
 */
function buildEndpoint(input: GenerateInput, model: string): string {
  const { width, height } = aspectRatioDimensions(input.aspectRatio);
  const params = new URLSearchParams();
  params.set("model", model);
  params.set("width", String(width));
  params.set("height", String(height));
  params.set("seed", String(input.seed));
  params.set("nologo", "true");
  for (const imageUrl of [input.productImageUrl, ...input.referenceImageUrls]) {
    if (/^https?:\/\//i.test(imageUrl)) params.append("image", imageUrl);
  }
  return `${API_BASE}/${encodeURIComponent(input.prompt)}?${params.toString()}`;
}

/** Decode the generated image from the binary stream, or map a JSON error body. */
async function decodeImageResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  // Success path: a binary image stream.
  if (contentType.startsWith("image/")) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      if (signal.aborted || isAbortError(cause)) {
        throw new ProviderError("timeout", PROVIDER_ID, "Pollinations response read aborted.");
      }
      throw new ProviderError(
        "server",
        PROVIDER_ID,
        `Pollinations image stream read failed: ${errorMessageOf(cause)}`,
      );
    }
    if (bytes.byteLength === 0) {
      throw new ProviderError(
        "server",
        PROVIDER_ID,
        "Pollinations returned an empty image stream.",
      );
    }
    return { bytes, contentType: sniffMime(bytes) ?? contentType.split(";")[0].trim() };
  }

  // A 2xx with a non-image body is an error envelope: parse + map it.
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (cause) {
    if (signal.aborted || isAbortError(cause)) {
      throw new ProviderError("timeout", PROVIDER_ID, "Pollinations response read aborted.");
    }
  }
  throw errorFromBody(response.status, bodyText);
}

/** Map a non-2xx HTTP response to a neutral `ProviderError`, refining by body. */
async function mapHttpError(response: Response): Promise<ProviderError> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // ignore — body may be unavailable
  }
  const retryAfterMs = retryAfterMsFromHeader(response.headers.get("retry-after"));
  return errorFromBody(response.status, bodyText, retryAfterMs);
}

/** Turn an HTTP status + error body into a typed `ProviderError`. */
function errorFromBody(status: number, bodyText: string, retryAfterMs?: number): ProviderError {
  const message = describeError(bodyText);
  const kind = refineKind(status, `${bodyText} ${message}`);
  const detail = message ? `: ${message}` : "";
  return new ProviderError(
    kind,
    PROVIDER_ID,
    `Pollinations HTTP ${status}${detail}`,
    status,
    retryAfterMs,
  );
}

/** Extract a human message from a `{ error, message }` JSON body (best-effort). */
function describeError(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (trimmed === "") return "";
  try {
    const json = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
    const parts = [stringify(json.message), stringify(json.error)].filter((s) => s.length > 0);
    if (parts.length > 0) return parts.join(" — ").slice(0, 500);
  } catch {
    // Not JSON — fall back to the raw text.
  }
  return trimmed.slice(0, 500);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return "";
}

function refineKind(status: number, body: string): ProviderErrorKind {
  const lower = body.toLowerCase();
  // A 429 is a rate limit and is RETRYABLE — incl. the free-tier concurrency cap
  // ("Queue full for IP ...: max 1"). Handle it FIRST: a 429 body usually carries
  // an "...enter.pollinations.ai" UPSELL ("Get unlimited access at ..."), which
  // must NOT be misread as an auth/gating error. Only an explicit daily / quota
  // exhaustion is a hard cap (fatal → advance provider).
  if (status === 429) {
    return /\bdaily\b|quota|exhaust|exceeded/.test(lower) ? "quota_exhausted" : "rate_limit";
  }
  // Premium-model gating: the image-editing models (nanobanana / kontext /
  // seedream) are token/tier-gated. Pollinations surfaces this as a 5xx whose
  // message says the model "is only available on enter.pollinations.ai" — an AUTH
  // fact (fatal → advance provider). Match "only available on" (and explicit auth
  // wording), NOT a bare "enter.pollinations.ai" which appears in benign upsells.
  if (
    /only available on|unauthor|forbidden|invalid token|invalid api key|missing token|requires a token/.test(
      lower,
    )
  ) {
    return "auth";
  }
  if (/nsfw|safety|moderat|blocked|policy|prohibited|flagged/.test(lower)) {
    return "content_policy";
  }
  if (/unavailable|overloaded|capacity|busy/.test(lower)) return "unavailable";
  return kindFromHttpStatus(status);
}

/** Map any thrown value (network / abort) to a neutral error. */
function mapThrown(cause: unknown, signal: AbortSignal, context: string): ProviderError {
  if (cause instanceof ProviderError) return cause;
  if (signal.aborted || isAbortError(cause)) {
    return new ProviderError("timeout", PROVIDER_ID, `${context}: aborted (timeout or cancel).`);
  }
  // Network / unknown → retryable, so the engine retries then fails over.
  return new ProviderError("server", PROVIDER_ID, `${context}: ${errorMessageOf(cause)}`);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError(
      "timeout",
      PROVIDER_ID,
      "Aborted before the Pollinations call (timeout/cancel).",
    );
  }
}
