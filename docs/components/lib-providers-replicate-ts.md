---
component: ReplicateProvider
source: lib/providers/replicate.ts
agent: providers
updated: 2026-06-28
---

# ReplicateProvider

## Purpose
`ImageProvider` adapter for Replicate over the HTTP predictions API (plain `fetch`, no SDK). Optional tertiary in the failover chain, gated OFF by default (`REPLICATE_ENABLED=false`) — never runs in the MVP chain without an explicit opt-in.

## Public Interface
- `createReplicateProvider(): ImageProvider` — build the adapter (`id: "replicate"`, `supportsImageReference: true`). Throws `ProviderError("auth", ...)` when `REPLICATE_API_TOKEN` is absent.

## Inputs and Outputs
- Create: `POST {API_BASE}/models/{owner}/{name}/predictions` (latest) or `POST {API_BASE}/predictions` with `{ version, input }` when the model pins `:version`; headers `Authorization: Bearer`, `Prefer: wait`.
- Model input: `{ prompt, seed, aspect_ratio, output_format: "png", num_outputs: 1 }`, plus the first normalized reference under `replicateImageInputKey()` (default `image`) when present.
- `waitForSettled`: polls `urls.get` every `POLL_INTERVAL_MS` (1500) while status is starting/processing, honoring the abort signal.
- Terminal handling: `canceled` → `timeout`; `failed` → `mapPredictionError`; success with no output URL → `server`.
- Returns `GenerateResult` with `imageBytes` = the delivery URL **string** (backend re-persists under its SSRF guard), `usedImageReference = Boolean(reference)`, `contentType` from URL extension (fallback `image/png`), `meta { latencyMs, model }`.
- Errors: non-2xx → `mapHttpError`; 402 → `quota_exhausted`; 429 naming daily/quota/billing → `quota_exhausted`; 422 naming safety → `content_policy`; abort → `timeout`; network → `server`.

## Dependencies
- `lib/types.ts` — `AspectRatio`.
- `lib/providers/config.ts` — `replicateApiToken`, `replicateImageInputKey`, `replicateModel`.
- `lib/providers/errors.ts` — `ProviderError`, `kindFromHttpStatus`, `errorMessageOf`, `isAbortError`, `retryAfterMsFromHeader`, `ProviderErrorKind`.
- `lib/providers/types.ts` — `GenerateInput`, `GenerateResult`, `ImageProvider`.

## Key Decisions
- Returns a provider URL string rather than bytes — adapters never persist; the backend re-fetches under its SSRF guard (`result-store.ts`).
- `Prefer: wait` plus a poll loop: the prediction may settle inline or need polling; the loop honors the per-attempt signal via an abortable `delay`.
- The reference style image is the conditioning input (`data:` URL accepted inline); the product is described in the prompt. The image input key is env-configurable so the adapter fits FLUX Redux / IP-Adapter / img2img schemas without code changes.

## Known Limitations
- Off by default; the exact model input schema (`REPLICATE_IMAGE_INPUT_KEY`) is confirmed only at live validation (Task 13).
- Only the first reference image is used as conditioning.
