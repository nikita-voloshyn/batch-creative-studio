/**
 * HuggingFace FLUX.1-Kontext-dev adapter (owner: providers — PV).
 *
 * The free, PRODUCT-PRESERVING path (decisions.md 2026-06-28). FLUX.1-Kontext-dev
 * is a TRUE image-editing (img2img) model: it conditions on the PRODUCT image and
 * restyles it per the prompt while preserving the scene (live-verified: an exact
 * scene was preserved and a watercolor style applied). It is the only free option
 * that keeps the product intact, so it sits at the head of the free chain; the
 * other free providers (Pollinations / Cloudflare) are fallbacks for when the HF
 * monthly Inference-Providers credit is exhausted.
 *
 * Implemented over the official `@huggingface/inference` SDK (`InferenceClient`),
 * routed through an Inference Provider (default `fal-ai`, the live-verified
 * provider; env-overridable):
 *
 *   const out: Blob = await client.imageToImage(
 *     { model, provider, inputs: <productBlob>, parameters: { prompt, num_inference_steps } },
 *     { signal },
 *   );
 *
 * NOTE — `provider` lives on the FIRST argument (`BaseArgs.provider`), which is
 * where the SDK actually reads it (`imageToImage` calls `resolveProvider(args.provider …)`);
 * the second `Options` argument has no `provider` field, so passing it there is a
 * runtime no-op and does not type-check.
 *
 * REFERENCE STYLE TRANSFER via TEXT (live-validated 2026-06-28): Kontext is a
 * SINGLE-image edit, so this adapter sends ONLY the product image and re-styles it
 * by prompt. The reference image's MOOD reaches the prompt as text: the composition
 * root extracts it ONCE per job with a vision model (`style-extract.ts`) and threads
 * it through `buildPrompt({ referenceStyleText })`. This REPLACES the earlier
 * side-by-side "stitch" (product + reference composited into one input): stitching
 * was unreliable — Kontext intermittently ignored the reference, echoed its objects,
 * or returned a collage. Product-only has NO second object in the frame, so the
 * product is always preserved, the same mood is applied across the batch, and there
 * is no reference-leak. `usedImageReference` reflects whether the job had a reference
 * whose mood shaped this output — the image call itself conditions on the product only.
 *
 * COLD-START HANG GUARD: the FIRST call to a cold inference provider can HANG
 * without ever resolving or rejecting. The SDK call is therefore RACED against the
 * per-attempt `AbortSignal` (the retry engine fires it at `ATTEMPT_TIMEOUT_MS`) AND
 * an internal backstop timeout (`HUGGINGFACE_TIMEOUT_MS`). Either bound turns a
 * hang into a retryable `timeout` `ProviderError`, so the engine retries — the warm
 * retry resolves in ~10s — instead of stalling the worker forever.
 *
 * Errors map to NEUTRAL facts (`ProviderError`); the retry/fatal POLICY lives in
 * the backend retry engine (see `errors.ts`). In particular, an exhausted free
 * monthly credit (HTTP 402 / "you have exceeded your … credits") maps to
 * `quota_exhausted` — fatal, so the engine fails over cleanly to the next free
 * provider rather than burning retries.
 */

import {
  InferenceClient,
  InferenceClientHubApiError,
  InferenceClientProviderApiError,
  type InferenceProviderOrPolicy,
} from "@huggingface/inference";
import {
  huggingfaceModel,
  huggingfaceProvider,
  huggingfaceTimeoutMs,
  huggingfaceToken,
} from "./config";
import {
  errorMessageOf,
  isAbortError,
  kindFromHttpStatus,
  ProviderError,
  type ProviderErrorKind,
} from "./errors";
import { fetchImageAsInlineData, type InlineImage, sniffMime } from "./reference-normalize";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types";

const PROVIDER_ID = "huggingface";
/** Live-verified denoising-step count for FLUX.1-Kontext-dev img2img edits. */
const NUM_INFERENCE_STEPS = 28;

/**
 * Build a HuggingFace adapter. Throws `ProviderError("auth", ...)` when the token
 * is absent — the registry omits the uncredentialed provider, so in practice the
 * token is always present here. `supportsImageReference: false`: Kontext conditions
 * on the PRODUCT image (preserved) and a TEXT prompt; the reference image's mood is
 * carried in that prompt as text (extracted once per job — see the file note), not
 * conditioned as a second image.
 */
export function createHuggingFaceProvider(): ImageProvider {
  const token = huggingfaceToken();
  if (!token) {
    throw new ProviderError("auth", PROVIDER_ID, "HF_TOKEN is not configured.");
  }
  const model = huggingfaceModel();
  const provider = huggingfaceProvider() as InferenceProviderOrPolicy;
  const client = new InferenceClient(token);

  return {
    id: PROVIDER_ID,
    supportsImageReference: false,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      const startedAt = Date.now();
      throwIfAborted(signal);

      // Kontext is a SINGLE-image edit: send ONLY the product (the image to preserve
      // and restyle). The reference image's mood is already baked into `input.prompt`
      // as text by the composition root (`buildPrompt({ referenceStyleText })`), so no
      // reference image is fetched or composited here — that keeps a second object out
      // of the frame and the product intact (see file note).
      let product: InlineImage;
      try {
        product = await fetchImageAsInlineData(input.productImageUrl, signal);
      } catch (cause) {
        throw mapThrown(cause, signal, "Failed to load the product image for HuggingFace");
      }

      const inputsBlob = new Blob([new Uint8Array(product.bytes)], { type: product.mimeType });
      const prompt = input.prompt;
      // The job supplied a reference whose mood was extracted and applied via the
      // prompt → not a prompt-only degradation. The image call itself conditions on
      // the product only; `supportsImageReference` stays false to reflect that.
      const usedImageReference = input.referenceImageUrls.length > 0;

      // Call the model, RACED against the per-attempt AbortSignal + a backstop
      // timeout so a cold-start hang becomes a retryable `timeout` (see file note).
      let output: Blob;
      try {
        output = await raceWithBound(
          client.imageToImage(
            {
              model,
              provider,
              inputs: inputsBlob,
              parameters: { prompt, num_inference_steps: NUM_INFERENCE_STEPS },
            },
            { signal },
          ),
          signal,
          huggingfaceTimeoutMs(),
        );
      } catch (cause) {
        throw mapThrown(cause, signal, "HuggingFace imageToImage failed");
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await output.arrayBuffer());
      } catch (cause) {
        throw mapThrown(cause, signal, "Failed to read the HuggingFace image response");
      }
      if (bytes.byteLength === 0) {
        throw new ProviderError("server", PROVIDER_ID, "HuggingFace returned an empty image.");
      }

      // Prefer the Blob's MIME (out is typically image/jpeg); sniff magic bytes
      // when it is missing/non-image so the backend derives the result-blob ext
      // from the real format.
      const blobType = output.type?.toLowerCase().split(";")[0].trim();
      const contentType =
        (blobType?.startsWith("image/") ? blobType : undefined) ?? sniffMime(bytes) ?? "image/jpeg";

      return {
        imageBytes: bytes,
        providerId: PROVIDER_ID,
        // true when reference(s) were stitched beside the product and conditioned the
        // edit; false when no reference was sent (product-only, prompt-driven style).
        usedImageReference,
        contentType,
        meta: { latencyMs: Date.now() - startedAt, model },
      };
    },
  };
}

/**
 * Race a provider call against the per-attempt `AbortSignal` AND an internal
 * timeout. The cold-start hang on a cold inference provider can never resolve or
 * reject; both bounds reject with a retryable `timeout` `ProviderError` so the
 * worker is never stalled. A late rejection from the orphaned `work` promise is
 * still consumed by the attached handler (it no-ops once settled), so it never
 * surfaces as an unhandled rejection.
 */
function raceWithBound<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      run();
    };
    function onAbort(): void {
      settle(() =>
        reject(
          new ProviderError(
            "timeout",
            PROVIDER_ID,
            "HuggingFace call aborted (per-attempt timeout or cancel).",
          ),
        ),
      );
    }

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(() =>
        reject(
          new ProviderError(
            "timeout",
            PROVIDER_ID,
            `HuggingFace call exceeded ${timeoutMs}ms (cold-start hang guard).`,
          ),
        ),
      );
    }, timeoutMs);

    work.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

/** Map any thrown value (SDK error / network / abort / hang) to a neutral error. */
function mapThrown(cause: unknown, signal: AbortSignal, context: string): ProviderError {
  if (cause instanceof ProviderError) return cause;
  // Abort / timeout from the retry engine's AbortSignal.
  if (signal.aborted || isAbortError(cause)) {
    return new ProviderError("timeout", PROVIDER_ID, `${context}: aborted (timeout or cancel).`);
  }

  const { status, body } = httpDetailsOf(cause);
  const message = errorMessageOf(cause);
  const kind = refineKind(status, `${message} ${body ?? ""}`);
  return new ProviderError(kind, PROVIDER_ID, `${context}: ${message}`, status);
}

/**
 * Refine an SDK error to a neutral `ProviderErrorKind` from its HTTP status and
 * message/body text. The `@huggingface/inference` SDK throws plain `Error`s
 * (`InferenceClient*Error`); the HTTP variants carry `httpResponse.{status,body}`.
 */
function refineKind(status: number | undefined, text: string): ProviderErrorKind {
  const lower = text.toLowerCase();

  // Exhausted free monthly credit → FATAL quota_exhausted (engine fails over to
  // the next free provider). fal-ai / HF surface this as HTTP 402 ("You have
  // exceeded your monthly included credits …") or a body naming payment/credits.
  if (
    status === 402 ||
    /payment required|exceeded your|monthly included|out of credits|insufficient (?:funds|credit|balance)|\bquota\b|spend limit|billing/.test(
      lower,
    )
  ) {
    return "quota_exhausted";
  }
  // Missing/invalid token, or a fine-grained token lacking the "Inference
  // Providers" permission → FATAL auth (advance provider).
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|forbidden|permission|invalid (?:token|api key|credentials)|not authorized|access token/.test(
      lower,
    )
  ) {
    return "auth";
  }
  // Safety / moderation reject (no provider helps) → fail this item.
  if (/nsfw|safety|moderat|content policy|prohibited|flagged|blocked|sensitive/.test(lower)) {
    return "content_policy";
  }
  // Per-minute rate limit → RETRYABLE.
  if (status === 429 || /rate limit|too many requests/.test(lower)) {
    return "rate_limit";
  }
  if (/unavailable|overloaded|capacity|temporarily/.test(lower)) return "unavailable";
  // Known HTTP status → base mapping; otherwise (network / SDK output error /
  // unknown) → retryable server, so the engine retries then fails over.
  if (status !== undefined) return kindFromHttpStatus(status);
  return "server";
}

/** Pull the HTTP status + body off the SDK's HTTP error variants, when present. */
function httpDetailsOf(cause: unknown): { status?: number; body?: string } {
  if (
    cause instanceof InferenceClientProviderApiError ||
    cause instanceof InferenceClientHubApiError
  ) {
    const rawStatus = cause.httpResponse?.status;
    const rawBody = cause.httpResponse?.body;
    const body =
      typeof rawBody === "string"
        ? rawBody
        : rawBody !== undefined
          ? safeStringify(rawBody)
          : undefined;
    return { status: typeof rawStatus === "number" ? rawStatus : undefined, body };
  }
  return {};
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError(
      "timeout",
      PROVIDER_ID,
      "Aborted before the HuggingFace call (timeout/cancel).",
    );
  }
}
