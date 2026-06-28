---
component: ProviderConfig
source: lib/providers/config.ts
agent: providers
updated: 2026-06-28
---

# ProviderConfig

## Purpose
Env-driven provider/model/quota configuration: chain order, model ids, RPM, daily caps, and secret accessors. Server-side only — secrets read here must never reach the client or a `GenerateResult`. Lets the chain, models, and quotas change without a redeploy.

## Public Interface
- `type QuotaConfig` — `{ dailyCap: number; rpm: number }`.
- `type CloudflareModelCaps` — `{ acceptsImageInput, encoding: "multipart" | "json", supportsSeed, supportsDimensions }`.
- `providerChainIds(): string[]` — ordered ids from `PROVIDER_CHAIN` (default `huggingface,pollinations,cloudflare`), lowercased/trimmed.
- Secret accessors (return `undefined` when unset, NOT re-exported from the barrel): `geminiApiKey()`, `cloudflareAccountId()`, `cloudflareApiToken()`, `replicateApiToken()`, `pollinationsToken()`, `huggingfaceToken()`.
- Model accessors: `geminiModel()`, `cloudflareModel()`, `replicateModel()`, `replicateImageInputKey()`, `pollinationsModel()`, `huggingfaceModel()`, `huggingfaceProvider()`.
- `cloudflareModelCaps(model?): CloudflareModelCaps` — classify request shape/capabilities by model id.
- `replicateEnabled(): boolean` — `REPLICATE_ENABLED === "true"`, default false.
- `huggingfaceTimeoutMs(): number` — cold-start hang backstop (default 120000).
- `aspectRatioDimensions(ratio): { width, height }` — ratio → pixel dims (Workers AI 256–1920 range).
- `providerSupportsSeed(id): boolean` — whether a provider honors a deterministic seed.
- `quotaFor(id): QuotaConfig` — quota+RPM by provider id (fallback = Gemini defaults).

## Inputs and Outputs
- Reads env: `PROVIDER_CHAIN`, `GEMINI_*`, `CLOUDFLARE_*`, `REPLICATE_*`, `POLLINATIONS_*`, `HF_TOKEN`/`HUGGINGFACE_*`. `positiveIntFromEnv` falls back when unset/empty/non-positive.
- `cloudflareModelCaps`: FLUX.2 family → multipart, image input, seed, dims; FLUX.1 [schnell] → JSON text-only, no seed/dims; SDXL/other → JSON, no image, seed+dims.
- `providerSupportsSeed`: gemini/replicate/pollinations → true; cloudflare → depends on model caps; huggingface → false (Kontext img2img exposes no seed); else false.
- `aspectRatioDimensions`: 1:1→1024×1024, 4:5→1024×1280, 9:16→1080×1920.

## Dependencies
- `lib/providers/types.ts` — `AspectRatio` type.

## Key Decisions
- Defaults reflect live-verified choices (decisions.md 2026-06-28): HF FLUX.1-Kontext-dev via `fal-ai` heads the free chain (only free option that preserves the product); Pollinations default `gptimage` (the free-token img2img model — premium models 500 even with the token); Cloudflare default FLUX.2 [klein] keeps image-reference conditioning.
- Secret accessors are intentionally NOT re-exported from `index.ts` — they stay internal so a credential cannot leak through the package barrel.
- Conservative RPM defaults for free tiers (HF/Pollinations) because free concurrency is tight; all env-overridable.

## Known Limitations
- `cloudflareModelCaps` classifies by substring match on the model id, so an unrecognized model id falls through to the SDXL-style (text-only, no image input) default.
- HF img2img exposes no seed, so deterministic output across that provider is not possible.
