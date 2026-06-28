---
component: ProvidersBarrel
source: lib/providers/index.ts
agent: providers
updated: 2026-06-28
---

# ProvidersBarrel

## Purpose
The public surface of the providers package. The backend composition root imports from here (or from the individual modules). Secret accessors are deliberately not re-exported so they stay internal.

## Public Interface
Re-exports:
- Adapters: `createCloudflareProvider`, `createGeminiProvider`, `createHuggingFaceProvider`, `createPollinationsProvider`, `createReplicateProvider`.
- Registry: `createRegistry`, `ProviderRegistry`, `registry`.
- Config (non-secret): `aspectRatioDimensions`, `cloudflareModelCaps`, `providerChainIds`, `providerSupportsSeed`, `quotaFor`, `replicateEnabled`; types `CloudflareModelCaps`, `QuotaConfig`.
- Errors: `kindFromHttpStatus`, `ProviderError`, `ProviderErrorKind`.
- Prompt: `buildPrompt`, `BuildPromptArgs`.
- Reference normalization: `fetchImageAsInlineData`, `InlineImage`, `normalizeReferences`, `ReferenceNormalizationError`.
- Types: `AspectRatio`, `GenerateInput`, `GenerateResult`, `ImageProvider`.

## Inputs and Outputs
- Pure re-export module; no runtime logic.

## Dependencies
- Every other module in `lib/providers/**`.

## Key Decisions
- Secret accessors (`geminiApiKey`, `cloudflareApiToken`, `pollinationsToken`, `huggingfaceToken`, `replicateApiToken`, etc.) are intentionally excluded from the barrel — they remain internal to the package so credentials cannot leak to consumers.

## Known Limitations
- None — the only risk is drift if a new public symbol is added to a module but not re-exported here.
