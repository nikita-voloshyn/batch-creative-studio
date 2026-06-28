---
component: HuggingFaceProvider
source: lib/providers/huggingface.ts
agent: providers
updated: 2026-06-28
---

# HuggingFaceProvider

## Purpose
`ImageProvider` adapter for the free, product-preserving path: FLUX.1-Kontext-dev (a true img2img edit model) over the `@huggingface/inference` SDK, routed through an Inference Provider (default `fal-ai`). Heads the free chain because it keeps the product intact while restyling per the prompt.

## Public Interface
- `createHuggingFaceProvider(): ImageProvider` — build the adapter (`id: "huggingface"`, `supportsImageReference: false` — Kontext conditions on the PRODUCT image + a text prompt, never on the reference image). Throws `ProviderError("auth", ...)` when `HF_TOKEN` is absent (the registry gates on it).

## Inputs and Outputs
- `generate(input, signal)`:
  - Loads ONLY the product image as a `Blob` (single-image edit; the reference image is never sent). The reference's *mood* reaches the prompt as text: the composition root extracts it once per job via `lib/providers/style-extract.ts` and threads it through `buildPrompt({ referenceStyleText })`. No stitching/compositing — there is never a second object in the frame.
  - Calls `client.imageToImage({ model, provider, inputs: productBlob, parameters: { prompt, num_inference_steps: 28 } }, { signal })`.
  - The call is RACED via `raceWithBound` against the per-attempt `AbortSignal` AND an internal `huggingfaceTimeoutMs()` backstop.
  - Reads the returned `Blob` bytes; empty → `server`.
- Returns `GenerateResult` with `usedImageReference = input.referenceImageUrls.length > 0` (the job supplied a reference whose extracted mood shaped this output; the image call itself conditions on the product only), `contentType` = Blob MIME if `image/*` else `sniffMime` else `image/jpeg`, `meta { latencyMs, model }`.
- Errors: exhausted free credit (HTTP 402 / "exceeded your ... credits", quota/billing wording) → `quota_exhausted` (fatal failover); 401/403/permission wording → `auth`; safety/moderation → `content_policy`; 429/rate-limit → `rate_limit`; abort/hang → `timeout`; network/unknown → `server`.

## Dependencies
- `@huggingface/inference` — `InferenceClient`, `InferenceClientProviderApiError`, `InferenceClientHubApiError`, `InferenceProviderOrPolicy`.
- `lib/providers/config.ts` — `huggingfaceModel/Provider/TimeoutMs/Token` (the same `HF_TOKEN` also powers the vision extractor in `style-extract.ts`).
- `lib/providers/errors.ts` — `ProviderError`, `kindFromHttpStatus`, `errorMessageOf`, `isAbortError`, `ProviderErrorKind`.
- `lib/providers/reference-normalize.ts` — `fetchImageAsInlineData`, `sniffMime`.
- `lib/providers/types.ts` — `GenerateInput`, `GenerateResult`, `ImageProvider`.

## Key Decisions
- Cold-start hang guard (`raceWithBound`): the first call to a cold inference provider can hang without ever settling. Racing against the AbortSignal + a backstop timer turns a hang into a retryable `timeout`; a late rejection from the orphaned work promise is consumed (no unhandled rejection).
- `provider` is passed on the FIRST SDK argument (`BaseArgs.provider`) where the SDK actually reads it — passing it in `Options` would be a silent no-op.
- Exhausted monthly credit is classified `quota_exhausted` (fatal) so the engine fails over cleanly instead of burning retries.

## Known Limitations
- Kontext is single-image: the reference is never image-conditioned, only carried as the vision-extracted mood text in the prompt. Pixel-exact reference matching would need an image-conditioned model (Gemini / IP-Adapter), a config swap behind the same interface.
- No seed parameter is exposed, so output is not deterministic across this provider.
