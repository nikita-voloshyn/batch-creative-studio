/**
 * Replicate adapter (owner: providers — PV).
 *
 * OPTIONAL tertiary in the failover chain, GATED OFF by default
 * (`REPLICATE_ENABLED=false`, decisions.md 2026-06-26). The registry omits it
 * unless enabled + credentialed, so it never runs in the MVP chain
 * (`[gemini, cloudflare]`) without an explicit opt-in.
 *
 * Implements `ImageProvider` over the Replicate HTTP API — plain `fetch`, no SDK
 * (keeps the dependency surface minimal, mirroring `cloudflare.ts`). Grounded in
 * Context7 against the `replicate` JS client / REST predictions API:
 *
 *   POST https://api.replicate.com/v1/models/{owner}/{name}/predictions   (latest)
 *   POST https://api.replicate.com/v1/predictions  body { version, input }  (pinned)
 *   Authorization: Bearer {REPLICATE_API_TOKEN}
 *   Prefer: wait      -> hold the request open until the prediction settles
 *
 * The prediction `output` is a delivery URL (or array of URLs). We return that
 * URL as `imageBytes: string`; the backend re-persists it under its SSRF guard
 * (`result-store.ts`) — adapters never persist (product-flow §0).
 *
 * `supportsImageReference: true` — the configured model receives the normalized
 * style reference image (FLUX Redux / IP-Adapter / img2img). The input key is
 * `REPLICATE_IMAGE_INPUT_KEY` (default `image`); the exact model schema is
 * confirmed at live validation (Task 13).
 *
 * Errors map to NEUTRAL facts (`ProviderError`); the retry/fatal POLICY lives in
 * the backend retry engine (see `errors.ts`).
 */

import type { AspectRatio } from "../types";
import { replicateApiToken, replicateImageInputKey, replicateModel } from "./config";
import {
  errorMessageOf,
  isAbortError,
  kindFromHttpStatus,
  ProviderError,
  type ProviderErrorKind,
  retryAfterMsFromHeader,
} from "./errors";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types";

const PROVIDER_ID = "replicate";
const API_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 1500;
const OUTPUT_FORMAT = "png";

/** Replicate prediction lifecycle statuses. */
type PredictionStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

type Prediction = {
  id?: string;
  status?: PredictionStatus;
  output?: unknown;
  error?: unknown;
  urls?: { get?: string; cancel?: string };
};

/**
 * Build a Replicate adapter. Throws `ProviderError("auth", ...)` when the token
 * is absent — the registry omits the uncredentialed provider, so the token is
 * present here in practice.
 */
export function createReplicateProvider(): ImageProvider {
  const apiToken = replicateApiToken();
  if (!apiToken) {
    throw new ProviderError("auth", PROVIDER_ID, "REPLICATE_API_TOKEN is not configured.");
  }
  const model = replicateModel();
  const imageInputKey = replicateImageInputKey();

  return {
    id: PROVIDER_ID,
    supportsImageReference: true,

    async generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
      const startedAt = Date.now();
      throwIfAborted(signal);

      // The normalized reference image (a `data:` URL Replicate accepts inline)
      // is the style conditioning input; the product is described in the prompt.
      const reference = input.referenceImageUrls[0];
      const modelInput: Record<string, unknown> = {
        prompt: input.prompt,
        seed: input.seed,
        aspect_ratio: aspectRatioFor(input.aspectRatio),
        output_format: OUTPUT_FORMAT,
        num_outputs: 1,
      };
      if (reference) modelInput[imageInputKey] = reference;
      const usedImageReference = Boolean(reference);

      let prediction = await createPrediction(model, modelInput, apiToken, signal);
      prediction = await waitForSettled(prediction, apiToken, signal);

      if (prediction.status === "canceled") {
        throw new ProviderError("timeout", PROVIDER_ID, "Replicate prediction was canceled.");
      }
      if (prediction.status === "failed") {
        throw mapPredictionError(prediction);
      }

      const url = firstOutputUrl(prediction.output);
      if (!url) {
        throw new ProviderError(
          "server",
          PROVIDER_ID,
          "Replicate prediction succeeded but returned no output URL.",
        );
      }

      return {
        // A provider URL the backend re-persists under its SSRF guard.
        imageBytes: url,
        providerId: PROVIDER_ID,
        usedImageReference,
        contentType: contentTypeForUrl(url),
        meta: { latencyMs: Date.now() - startedAt, model },
      };
    },
  };
}

/** Create a prediction (official-model endpoint, or versioned when `model` pins `:version`). */
async function createPrediction(
  model: string,
  input: Record<string, unknown>,
  apiToken: string,
  signal: AbortSignal,
): Promise<Prediction> {
  const versioned = model.includes(":");
  const url = versioned ? `${API_BASE}/predictions` : `${API_BASE}/models/${model}/predictions`;
  const body = versioned ? { version: model.split(":")[1], input } : { input };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    throw mapThrown(cause, signal, "Replicate prediction create failed");
  }
  if (!response.ok) {
    throw await mapHttpError(response);
  }
  return parsePrediction(response, signal);
}

/** Poll `urls.get` until the prediction reaches a terminal status (honoring `signal`). */
async function waitForSettled(
  initial: Prediction,
  apiToken: string,
  signal: AbortSignal,
): Promise<Prediction> {
  let prediction = initial;
  while (prediction.status === "starting" || prediction.status === "processing") {
    throwIfAborted(signal);
    await delay(POLL_INTERVAL_MS, signal);
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) {
      throw new ProviderError("server", PROVIDER_ID, "Replicate prediction is missing a poll URL.");
    }
    let response: Response;
    try {
      response = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal,
      });
    } catch (cause) {
      throw mapThrown(cause, signal, "Replicate prediction poll failed");
    }
    if (!response.ok) {
      throw await mapHttpError(response);
    }
    prediction = await parsePrediction(response, signal);
  }
  return prediction;
}

async function parsePrediction(response: Response, signal: AbortSignal): Promise<Prediction> {
  try {
    return (await response.json()) as Prediction;
  } catch (cause) {
    if (signal.aborted || isAbortError(cause)) {
      throw new ProviderError("timeout", PROVIDER_ID, "Replicate response read aborted.");
    }
    throw new ProviderError(
      "server",
      PROVIDER_ID,
      `Replicate returned an unparseable response: ${errorMessageOf(cause)}`,
    );
  }
}

/** Replicate `output` is a URL string or an array of URL strings; take the first. */
function firstOutputUrl(output: unknown): string | undefined {
  if (typeof output === "string" && output.length > 0) return output;
  if (Array.isArray(output)) {
    const first = output.find((o) => typeof o === "string" && o.length > 0);
    if (typeof first === "string") return first;
  }
  return undefined;
}

function mapPredictionError(prediction: Prediction): ProviderError {
  const message = errorMessageOf(prediction.error) || "Replicate prediction failed.";
  const lower = message.toLowerCase();
  if (/nsfw|safety|sensitive|moderat|flagged|policy/.test(lower)) {
    return new ProviderError(
      "content_policy",
      PROVIDER_ID,
      `Replicate flagged the request: ${message}`,
    );
  }
  // Otherwise transient -> retryable, then fail over.
  return new ProviderError("server", PROVIDER_ID, `Replicate prediction failed: ${message}`);
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
    `Replicate HTTP ${status}${detail}`,
    status,
    retryAfterMs,
  );
}

function refineKind(status: number, body: string): ProviderErrorKind {
  const lower = body.toLowerCase();
  // 402 Payment Required => out of credit: this provider can't serve -> advance.
  if (status === 402) return "quota_exhausted";
  if (status === 429 && /\bdaily\b|quota|exhaust|exceeded|billing/.test(lower)) {
    return "quota_exhausted";
  }
  if (status === 422 && /nsfw|safety|sensitive|moderat|policy/.test(lower)) {
    return "content_policy";
  }
  if (/unavailable|overloaded|capacity/.test(lower)) return "unavailable";
  return kindFromHttpStatus(status);
}

/** Map any thrown value (network / abort) to a neutral error. */
function mapThrown(cause: unknown, signal: AbortSignal, context: string): ProviderError {
  if (cause instanceof ProviderError) return cause;
  if (signal.aborted || isAbortError(cause)) {
    return new ProviderError("timeout", PROVIDER_ID, `${context}: aborted (timeout or cancel).`);
  }
  return new ProviderError("server", PROVIDER_ID, `${context}: ${errorMessageOf(cause)}`);
}

/** FLUX models accept the canonical ratios directly as `aspect_ratio` enums. */
function aspectRatioFor(ratio: AspectRatio): string {
  return ratio;
}

/** Best-effort content-type hint from the delivery URL extension. */
function contentTypeForUrl(url: string): string | undefined {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  // We requested PNG output; fall back to that hint (backend re-sniffs anyway).
  return OUTPUT_FORMAT === "png" ? "image/png" : undefined;
}

/** Abortable delay used by the poll loop. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("timeout", PROVIDER_ID, "Replicate poll aborted (timeout/cancel)."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new ProviderError("timeout", PROVIDER_ID, "Replicate poll aborted (timeout/cancel)."));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ProviderError(
      "timeout",
      PROVIDER_ID,
      "Aborted before the Replicate call (timeout/cancel).",
    );
  }
}
