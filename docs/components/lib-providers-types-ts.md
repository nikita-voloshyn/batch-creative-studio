---
component: ProviderTypes
source: lib/providers/types.ts
agent: providers
updated: 2026-06-28
---

# ProviderTypes

## Purpose
Defines the `ImageProvider` contract and its input/output shapes — the single surface the backend failover engine is built against. Concrete adapters implement it; the engine never names a concrete adapter or the registry.

## Public Interface
- `interface ImageProvider` — one image-generation provider.
  - `id: string` — stable provider id (e.g. `"gemini"`, `"cloudflare"`).
  - `supportsImageReference: boolean` — true when the adapter conditions on a reference image; false drives prompt-only degradation.
  - `generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult>` — generate one post; honors `signal`; throws `ProviderError` on failure.
- `type GenerateInput` — fully-resolved per-item inputs: `productImageUrl`, `referenceImageUrls` (1..2, already normalized), `prompt`, `aspectRatio`, `seed`.
- `type GenerateResult` — `imageBytes` (`Uint8Array` raw bytes OR a provider URL string), `providerId`, `usedImageReference`, optional `contentType`, `meta { latencyMs, model }`.
- `type AspectRatio` — re-exported from `lib/types.ts` (canonical home; providers never redefine it).

## Inputs and Outputs
- `GenerateInput.productImageUrl` — trusted app-origin Blob URL (SSRF-checked by backend), passed as a URL not bytes.
- `GenerateInput.seed` — per-batch deterministic seed from `Job.seed`.
- `GenerateResult.imageBytes` — bytes the backend persists, OR a provider URL the backend re-fetches and re-persists.
- `GenerateResult.usedImageReference` — `false` => post was produced prompt-only (UI degradation badge).
- `GenerateResult.contentType` — optional MIME so the backend derives the result-blob extension `results/{jobId}/{itemId}.{ext}`; when absent the backend falls back to magic-byte sniffing.

## Dependencies
- `lib/types.ts` — owns the canonical `AspectRatio`; re-exported here.

## Key Decisions
- The interface carries no secrets and no API key — `GenerateResult` is safe to surface.
- `contentType` is optional so a failover that yields a different format than the primary (e.g. Cloudflare WEBP vs Gemini PNG) cannot strand a stale-extension blob for the same item.
- The engine consumes only this surface; the registry/DI seam lives elsewhere to keep the boundary one-directional.

## Known Limitations
- Pure type/interface module — no runtime behavior. `contentType` accuracy depends on each adapter; backend sniffing is the fallback.
