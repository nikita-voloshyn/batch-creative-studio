---
component: CloudflareProvider
source: lib/providers/cloudflare.ts
agent: providers
updated: 2026-06-28
---

# CloudflareProvider

## Purpose
`ImageProvider` adapter for Cloudflare Workers AI over the REST API (plain `fetch`, no SDK). Secondary in the failover chain. The request/response shape and `supportsImageReference` are driven by the configured model's capabilities.

## Public Interface
- `createCloudflareProvider(): ImageProvider` — build the adapter (`id: "cloudflare"`). Throws `ProviderError("auth", ...)` when account id / token are missing. `supportsImageReference` = `caps.acceptsImageInput` (true only for the FLUX.2 edit family).

## Inputs and Outputs
- Endpoint: `POST {API_BASE}/{accountId}/ai/run/{model}`, `Authorization: Bearer {token}`.
- `generate(input, signal)`:
  - `useReference` = model accepts image input AND ≥1 reference present.
  - Multipart path (FLUX.2 edit): `prompt`, optional `width`/`height`, optional `seed`, plus binary `input_image_0` (product) and `input_image_1..` (references), capped at 4 (`MAX_INPUT_IMAGES`). `fetch` sets the boundary, so `Content-Type` is not set manually.
  - JSON path (text-only): `{ prompt, [width, height], [seed] }`.
  - Response decode branches on `Content-Type`: `image/*` → binary stream; otherwise a JSON envelope `{ result: { image: "<base64>" }, success, errors }`.
- Returns `GenerateResult` with `usedImageReference = useReference`, `contentType` from `sniffMime` (fallback to header / `image/png`), `meta { latencyMs, model }`.
- Errors: non-2xx → `mapHttpError` (reads `Retry-After`, refines by body); `success: false` / missing/zero-byte image → `server`; abort → `timeout`; network → `server`.

## Dependencies
- `lib/providers/config.ts` — `cloudflareAccountId/ApiToken/Model`, `cloudflareModelCaps`, `aspectRatioDimensions`, `CloudflareModelCaps`.
- `lib/providers/errors.ts` — `ProviderError`, `kindFromHttpStatus`, `errorMessageOf`, `isAbortError`, `retryAfterMsFromHeader`, `ProviderErrorKind`.
- `lib/providers/reference-normalize.ts` — `fetchImageAsInlineData`, `InlineImage`, `sniffMime`.
- `lib/providers/types.ts` — `GenerateInput`, `GenerateResult`, `ImageProvider`.

## Key Decisions
- Single adapter handles both encodings and both response forms by branching on `cloudflareModelCaps` (request) and `Content-Type` (response), so swapping the env model flips image-reference support without a code change.
- `input_image_0` = product (subject), `input_image_1..` = style references — product-first conditioning.
- `refineKind`: 429 naming daily/neuron/quota/exhaust → `quota_exhausted`; 400/422 naming safety/nsfw/moderation → `content_policy`; "unavailable"/"overloaded"/"capacity" → `unavailable`.

## Known Limitations
- FLUX.2 caps each `input_image_N` at 512×512, but MVP normalization does NOT pixel-downscale (no `sharp`), so oversized references may be rejected/cropped by Cloudflare — a known constraint to revisit when an image lib lands.
- Error body detail is truncated to 500 chars.
