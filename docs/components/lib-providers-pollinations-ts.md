---
component: PollinationsProvider
source: lib/providers/pollinations.ts
agent: providers
updated: 2026-06-28
---

# PollinationsProvider

## Purpose
`ImageProvider` adapter for the free Pollinations image endpoint over a plain `fetch` GET (no SDK). Default model `gptimage` (img2img, works with a free account token). Part of the free failover chain.

## Public Interface
- `createPollinationsProvider(): ImageProvider` — build the adapter (`id: "pollinations"`, `supportsImageReference: true`). Throws `ProviderError("auth", ...)` when `POLLINATIONS_TOKEN` is absent (the registry gates on it).

## Inputs and Outputs
- Endpoint: `GET {API_BASE}/{encodeURIComponent(prompt)}?model&width&height&seed&nologo=true&image=...`, `Authorization: Bearer {token}`, `Referer: https://pollinations.ai`.
- `buildEndpoint`: prompt in the path; only **http(s)** image URLs are appended as repeated `image=` params, product first then references; `data:` URLs are dropped (server fetches each `image=` URL, and a `data:` URL would blow the ~8 KB request-URI limit → HTTP 414).
- `generate(input, signal)`: on success (`Content-Type: image/*`) reads the binary stream; non-image body → parsed as a `{ error, message }` envelope and mapped.
- Returns `GenerateResult` with `usedImageReference` = "any reference URL is http(s)" (honest: inlined `data:` refs are carried by prompt text only), `contentType` from `sniffMime` (fallback to header), `meta { latencyMs, model }`.
- Errors: empty stream → `server`; abort → `timeout`; HTTP via `mapHttpError`/`errorFromBody`.

## Dependencies
- `lib/providers/config.ts` — `aspectRatioDimensions`, `pollinationsModel`, `pollinationsToken`.
- `lib/providers/errors.ts` — `ProviderError`, `kindFromHttpStatus`, `errorMessageOf`, `isAbortError`, `retryAfterMsFromHeader`, `ProviderErrorKind`.
- `lib/providers/reference-normalize.ts` — `sniffMime`.
- `lib/providers/types.ts` — `GenerateInput`, `GenerateResult`, `ImageProvider`.

## Key Decisions
- `refineKind` handles 429 FIRST and treats it as retryable `rate_limit` (incl. the free-tier concurrency cap "Queue full ... max 1") unless it explicitly names daily/quota exhaustion — because a 429 body usually carries an "...enter.pollinations.ai" upsell that must NOT be misread as auth.
- Premium-model gating ("only available on enter.pollinations.ai", "unauthorized", "invalid token") maps to `auth` (fatal → advance), but a bare "enter.pollinations.ai" upsell is ignored.
- Only http(s) `image=` URLs are sent; `data:` references degrade to prompt-only to avoid 414s.

## Known Limitations
- Premium image-edit models (`nanobanana`/`kontext`/`seedream`) 500 even with the free token, so they are configurable but not default.
- When references are inlined as `data:` URLs by the orchestrator, no reference image is actually conditioned — only the product (http Blob URL) is.
