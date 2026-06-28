/**
 * Gemini 2.5 Flash Image ("Nano Banana") adapter (owner: providers — PV).
 *
 * Implements `ImageProvider` (architecture §4 table). Grounded in Context7 against
 * the current Google Gen AI JS SDK (`@google/genai`):
 *   - call `ai.models.generateContent({ model, contents, config })`;
 *   - `contents` is a list of Parts: a `{ text }` prompt part plus one
 *     `{ inlineData: { mimeType, data } }` part per input image (base64) — the
 *     product image and the 1..2 normalized references, for image-conditioned
 *     editing;
 *   - `config` carries `responseModalities: ["IMAGE"]`, `imageConfig.aspectRatio`,
 *     `seed`, and `abortSignal`;
 *   - the generated image returns as a part with `inlineData.data` (base64).
 *
 * Errors are mapped to NEUTRAL facts (`ProviderError`); the retry/fatal POLICY
 * lives in the backend retry engine (see `errors.ts`).
 */

import type { Content, GenerateContentResponse, Part } from "@google/genai";
import { ApiError, GoogleGenAI } from "@google/genai";
import { geminiApiKey, geminiModel } from "./config";
import { kindFromHttpStatus, ProviderError, type ProviderErrorKind } from "./errors";
import { fetchImageAsInlineData } from "./reference-normalize";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types";

const PROVIDER_ID = "gemini";

/** Candidate `finishReason` values that mean a content-policy / safety stop. */
const CONTENT_POLICY_FINISH = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "SPII",
]);

/**
 * Build a Gemini adapter. Throws `ProviderError("auth", ...)` if the key is
 * absent — the registry guards against this by omitting the provider when
 * uncredentialed, so in practice the key is always present here.
 */
export function createGeminiProvider(): ImageProvider {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new ProviderError("auth", PROVIDER_ID, "GEMINI_API_KEY is not configured.");
  }
  const model = geminiModel();
  const ai = new GoogleGenAI({ apiKey });

  return {
    id: PROVIDER_ID,
    supportsImageReference: true,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      const startedAt = Date.now();
      throwIfAborted(signal);

      // 1. Fetch the product image + already-normalized references as inline
      //    base64 parts. References arrive as `data:` URLs (normalized once per
      //    job), so this does not re-hit the network for them.
      let parts: Part[];
      try {
        const product = await fetchImageAsInlineData(input.productImageUrl, signal);
        const references = await Promise.all(
          input.referenceImageUrls.map((url) => fetchImageAsInlineData(url, signal)),
        );
        parts = [
          { text: input.prompt },
          { inlineData: { mimeType: product.mimeType, data: product.base64 } },
          ...references.map((ref) => ({
            inlineData: { mimeType: ref.mimeType, data: ref.base64 },
          })),
        ];
      } catch (cause) {
        throw mapThrown(cause, signal, "Failed to load input images for Gemini");
      }

      const contents: Content[] = [{ role: "user", parts }];

      // 2. Call the model. `imageConfig.aspectRatio` applies the ratio natively
      //    (the prompt text also instructs it, per task "natively if supported,
      //    else post-process/instruct"). `abortSignal` honors the per-attempt
      //    timeout/cancel owned by the retry engine.
      let response: GenerateContentResponse;
      try {
        response = await ai.models.generateContent({
          model,
          contents,
          config: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: input.aspectRatio },
            seed: input.seed,
            abortSignal: signal,
          },
        });
      } catch (cause) {
        throw mapThrown(cause, signal, "Gemini generateContent failed");
      }

      // 3. Extract the generated image bytes (or map a 200-with-no-image / policy block).
      const image = extractImage(response);

      return {
        imageBytes: image.bytes,
        providerId: PROVIDER_ID,
        // Gemini always conditions on the supplied reference image(s); under the
        // R>=1 invariant (product-flow §0) this is always true.
        usedImageReference: input.referenceImageUrls.length > 0,
        // Carry the model-reported MIME so the backend derives the result-blob
        // ext from the real format (uniform across the failover chain).
        contentType: image.mimeType,
        meta: { latencyMs: Date.now() - startedAt, model },
      };
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError(
      "timeout",
      PROVIDER_ID,
      "Aborted before the Gemini call (timeout/cancel).",
    );
  }
}

function extractImage(response: GenerateContentResponse): { bytes: Uint8Array; mimeType?: string } {
  // Prompt-level moderation block (200 with a blockReason).
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) {
    throw new ProviderError(
      "content_policy",
      PROVIDER_ID,
      `Gemini blocked the prompt: ${blockReason}`,
    );
  }

  const candidate = response.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason && CONTENT_POLICY_FINISH.has(String(finishReason))) {
    throw new ProviderError(
      "content_policy",
      PROVIDER_ID,
      `Gemini stopped for a policy reason: ${finishReason}`,
    );
  }

  for (const part of candidate?.content?.parts ?? []) {
    const data = part.inlineData?.data;
    if (data) {
      return {
        bytes: new Uint8Array(Buffer.from(data, "base64")),
        mimeType: part.inlineData?.mimeType ?? undefined,
      };
    }
  }

  // 200 but no image bytes -> treat as a transient provider anomaly so the retry
  // engine retries and then fails over (product-flow §5k).
  throw new ProviderError("server", PROVIDER_ID, "Gemini returned no image data in the response.");
}

/** Map any thrown value to a neutral `ProviderError`. */
function mapThrown(cause: unknown, signal: AbortSignal, context: string): ProviderError {
  if (cause instanceof ProviderError) return cause;

  // Abort / timeout from the retry engine's AbortSignal.
  if (signal.aborted || isAbortError(cause)) {
    return new ProviderError("timeout", PROVIDER_ID, `${context}: aborted (timeout or cancel).`);
  }

  const status = httpStatusOf(cause);
  const message = errorMessage(cause);

  if (status !== undefined) {
    return new ProviderError(
      refineKind(status, message),
      PROVIDER_ID,
      `${context}: ${message}`,
      status,
      retryAfterMsOf(message),
    );
  }

  // Network / unknown -> retryable, so the engine retries then fails over.
  return new ProviderError("server", PROVIDER_ID, `${context}: ${message}`);
}

function refineKind(status: number, message: string): ProviderErrorKind {
  const lower = message.toLowerCase();
  // A 429 is a per-minute rate limit (retryable) UNLESS it names a daily/per-day
  // quota, which is a hard exhaustion (fatal -> advance provider). Heuristic:
  // Gemini surfaces both as 429 + RESOURCE_EXHAUSTED, so this leans on wording.
  if (status === 429 && /\bdaily\b|per[-\s]?day/.test(lower)) return "quota_exhausted";
  if (status === 400 && /safety|blocked|policy|prohibited|moderat/.test(lower)) {
    return "content_policy";
  }
  if (/unavailable|overloaded/.test(lower)) return "unavailable";
  return kindFromHttpStatus(status);
}

function httpStatusOf(cause: unknown): number | undefined {
  if (cause instanceof ApiError && typeof cause.status === "number") return cause.status;
  if (cause && typeof cause === "object") {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === "number") return status;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}

/** Best-effort parse of a server-suggested retry delay (e.g. "retryDelay: 12s"). */
function retryAfterMsOf(message: string): number | undefined {
  const match = /retry(?:delay|[-\s]?after)["':\s]+(\d+(?:\.\d+)?)s/i.exec(message);
  if (!match) return undefined;
  return Math.round(Number.parseFloat(match[1]) * 1000);
}
