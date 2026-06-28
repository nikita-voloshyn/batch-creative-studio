/**
 * Cloudflare Workers AI adapter (owner: providers — PV).
 *
 * Secondary in the failover chain (architecture §5.2). Implements `ImageProvider`
 * over the Workers AI REST API — plain `fetch`, no SDK. Grounded in Context7
 * against the current Workers AI docs/changelog:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}
 *   Authorization: Bearer {CLOUDFLARE_API_TOKEN}
 *
 * Request shape depends on the configured model (`cloudflareModelCaps`):
 *   - FLUX.2 [klein] (default, gen+EDIT): `multipart/form-data` with `prompt`,
 *     `width`/`height`, `seed`, and binary `input_image_0..3` reference images.
 *     => `supportsImageReference: true`.
 *   - FLUX.1 [schnell] / SDXL (text-only): JSON `{ prompt, ... }`, no image input.
 *     => `supportsImageReference: false` (prompt-only degradation, product-flow §5c).
 *
 * Response shape also varies (Context7-verified):
 *   - FLUX family returns JSON `{ result: { image: "<base64>" }, success: true }`;
 *   - SDXL / older diffusion models stream a BINARY image (`Content-Type: image/*`).
 * The adapter branches on the response `Content-Type` so both are handled.
 *
 * Errors map to NEUTRAL facts (`ProviderError`); the retry/fatal POLICY lives in
 * the backend retry engine (see `errors.ts`).
 *
 * NOTE (input-image size): FLUX.2 caps each `input_image_N` at 512×512. MVP
 * normalization (`reference-normalize.ts`) validates type/size but does NOT
 * pixel-downscale (no `sharp`), so oversized references may be rejected/cropped
 * by Cloudflare. This is a known constraint to revisit once an image lib lands;
 * surfaced in the Task 9 handoff note. Live validation is Task 13.
 */

import {
  aspectRatioDimensions,
  type CloudflareModelCaps,
  cloudflareAccountId,
  cloudflareApiToken,
  cloudflareModel,
  cloudflareModelCaps,
} from "./config";
import {
  errorMessageOf,
  isAbortError,
  kindFromHttpStatus,
  ProviderError,
  type ProviderErrorKind,
  retryAfterMsFromHeader,
} from "./errors";
import { fetchImageAsInlineData, type InlineImage, sniffMime } from "./reference-normalize";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types";

const PROVIDER_ID = "cloudflare";
const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
/** Workers AI accepts at most `input_image_0..3` reference images. */
const MAX_INPUT_IMAGES = 4;

/**
 * Build a Cloudflare adapter. Throws `ProviderError("auth", ...)` when account
 * id / token are missing — the registry omits the uncredentialed provider, so in
 * practice both are present here. `supportsImageReference` reflects the CONFIGURED
 * model: true only for the FLUX.2 edit family, false for schnell/SDXL.
 */
export function createCloudflareProvider(): ImageProvider {
  const accountId = cloudflareAccountId();
  const apiToken = cloudflareApiToken();
  if (!accountId || !apiToken) {
    throw new ProviderError(
      "auth",
      PROVIDER_ID,
      "CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not configured.",
    );
  }
  const model = cloudflareModel();
  const caps = cloudflareModelCaps(model);
  const endpoint = `${API_BASE}/${accountId}/ai/run/${model}`;

  return {
    id: PROVIDER_ID,
    supportsImageReference: caps.acceptsImageInput,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      const startedAt = Date.now();
      throwIfAborted(signal);

      // Send the reference image(s) ONLY when the configured model accepts image
      // input AND at least one reference is present; otherwise this is an honest
      // prompt-only call. `usedImageReference` is set from what was ACTUALLY sent.
      const useReference = caps.acceptsImageInput && input.referenceImageUrls.length > 0;

      let response: Response;
      try {
        const { body, headers } = useReference
          ? await buildMultipartRequest(input, caps, apiToken, signal)
          : buildJsonRequest(input, caps, apiToken);
        response = await fetch(endpoint, { method: "POST", headers, body, signal });
      } catch (cause) {
        throw mapThrown(cause, signal, "Cloudflare request failed");
      }

      if (!response.ok) {
        throw await mapHttpError(response);
      }

      const decoded = await decodeImageResponse(response, signal);

      return {
        imageBytes: decoded.bytes,
        providerId: PROVIDER_ID,
        usedImageReference: useReference,
        contentType: decoded.contentType,
        meta: { latencyMs: Date.now() - startedAt, model },
      };
    },
  };
}

/** JSON request for text-only models (FLUX.1 [schnell] / SDXL). */
function buildJsonRequest(
  input: GenerateInput,
  caps: CloudflareModelCaps,
  apiToken: string,
): { body: string; headers: HeadersInit } {
  const payload: Record<string, unknown> = { prompt: input.prompt };
  if (caps.supportsDimensions) {
    const { width, height } = aspectRatioDimensions(input.aspectRatio);
    payload.width = width;
    payload.height = height;
  }
  if (caps.supportsSeed) payload.seed = input.seed;
  return {
    body: JSON.stringify(payload),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  };
}

/**
 * `multipart/form-data` request for the FLUX.2 edit family. Sends the product
 * image plus the normalized reference image(s) as binary `input_image_N`. The
 * boundary is set by `fetch` from the `FormData` body, so we DON'T set
 * `Content-Type` ourselves.
 */
async function buildMultipartRequest(
  input: GenerateInput,
  caps: CloudflareModelCaps,
  apiToken: string,
  signal: AbortSignal,
): Promise<{ body: FormData; headers: HeadersInit }> {
  let product: InlineImage;
  let references: InlineImage[];
  try {
    product = await fetchImageAsInlineData(input.productImageUrl, signal);
    references = await Promise.all(
      input.referenceImageUrls.map((url) => fetchImageAsInlineData(url, signal)),
    );
  } catch (cause) {
    throw mapThrown(cause, signal, "Failed to load input images for Cloudflare");
  }

  const form = new FormData();
  form.append("prompt", input.prompt);
  if (caps.supportsDimensions) {
    const { width, height } = aspectRatioDimensions(input.aspectRatio);
    form.append("width", String(width));
    form.append("height", String(height));
  }
  if (caps.supportsSeed) form.append("seed", String(input.seed));

  // input_image_0 = product (subject), input_image_1.. = style reference(s).
  const images = [product, ...references].slice(0, MAX_INPUT_IMAGES);
  images.forEach((image, index) => {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mimeType });
    form.append(`input_image_${index}`, blob, `input_${index}.${extFor(image.mimeType)}`);
  });

  return { body: form, headers: { Authorization: `Bearer ${apiToken}` } };
}

/** Decode the generated image from a binary stream OR a base64 JSON envelope. */
async function decodeImageResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  // Binary image stream (SDXL / older diffusion models).
  if (contentType.startsWith("image/")) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new ProviderError("server", PROVIDER_ID, "Cloudflare returned an empty image stream.");
    }
    return { bytes, contentType: sniffMime(bytes) ?? contentType.split(";")[0].trim() };
  }

  // JSON envelope: { result: { image: "<base64>" }, success, errors }.
  let json: CloudflareEnvelope;
  try {
    json = (await response.json()) as CloudflareEnvelope;
  } catch (cause) {
    if (signal.aborted || isAbortError(cause)) {
      throw new ProviderError("timeout", PROVIDER_ID, "Cloudflare response read aborted.");
    }
    throw new ProviderError(
      "server",
      PROVIDER_ID,
      `Cloudflare returned an unparseable response: ${errorMessageOf(cause)}`,
    );
  }

  if (json.success === false) {
    throw new ProviderError(
      "server",
      PROVIDER_ID,
      `Cloudflare reported failure: ${describeErrors(json)}`,
    );
  }

  const base64 = extractBase64(json.result);
  if (!base64) {
    throw new ProviderError(
      "server",
      PROVIDER_ID,
      "Cloudflare returned no image data in the response.",
    );
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.byteLength === 0) {
    throw new ProviderError("server", PROVIDER_ID, "Cloudflare returned a zero-byte image.");
  }
  return { bytes, contentType: sniffMime(bytes) ?? "image/png" };
}

type CloudflareEnvelope = {
  success?: boolean;
  result?: unknown;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
};

/** The base64 image can sit at `result.image` (FLUX) or be the `result` string. */
function extractBase64(result: unknown): string | undefined {
  if (typeof result === "string" && result.length > 0) return result;
  if (result && typeof result === "object") {
    const image = (result as { image?: unknown }).image;
    if (typeof image === "string" && image.length > 0) return image;
  }
  return undefined;
}

/** Map a non-2xx HTTP response to a neutral `ProviderError`, refining by body. */
async function mapHttpError(response: Response): Promise<ProviderError> {
  const status = response.status;
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    // ignore — body may be unavailable
  }
  const retryAfterMs = retryAfterMsFromHeader(response.headers.get("retry-after"));
  const kind = refineKind(status, bodyText);
  const detail = bodyText ? `: ${bodyText.slice(0, 500)}` : "";
  return new ProviderError(
    kind,
    PROVIDER_ID,
    `Cloudflare HTTP ${status}${detail}`,
    status,
    retryAfterMs,
  );
}

function refineKind(status: number, body: string): ProviderErrorKind {
  const lower = body.toLowerCase();
  // A 429 is a per-minute rate limit UNLESS it names a daily / neuron / quota
  // exhaustion, which is a hard cap (fatal -> advance to the next provider).
  if (status === 429 && /\bdaily\b|neuron|quota|exhaust|exceeded/.test(lower)) {
    return "quota_exhausted";
  }
  if ((status === 400 || status === 422) && /safety|nsfw|moderat|blocked|policy/.test(lower)) {
    return "content_policy";
  }
  if (/unavailable|overloaded|capacity/.test(lower)) return "unavailable";
  return kindFromHttpStatus(status);
}

/** Map any thrown value (network / abort / load failure) to a neutral error. */
function mapThrown(cause: unknown, signal: AbortSignal, context: string): ProviderError {
  if (cause instanceof ProviderError) return cause;
  if (signal.aborted || isAbortError(cause)) {
    return new ProviderError("timeout", PROVIDER_ID, `${context}: aborted (timeout or cancel).`);
  }
  // Network / unknown -> retryable, so the engine retries then fails over.
  return new ProviderError("server", PROVIDER_ID, `${context}: ${errorMessageOf(cause)}`);
}

function describeErrors(json: CloudflareEnvelope): string {
  const parts = (json.errors ?? json.messages ?? [])
    .map((e) => (e.code != null ? `[${e.code}] ${e.message ?? ""}` : (e.message ?? "")))
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts.join("; ") : "no error detail";
}

function extFor(mimeType: string): string {
  switch (mimeType) {
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError(
      "timeout",
      PROVIDER_ID,
      "Aborted before the Cloudflare call (timeout/cancel).",
    );
  }
}
