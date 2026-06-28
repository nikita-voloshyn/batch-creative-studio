---
component: ProviderRegistry
source: lib/providers/registry.ts
agent: providers
updated: 2026-06-28
---

# ProviderRegistry

## Purpose
Builds the ordered failover chain from env, omitting any provider that is unimplemented, uncredentialed, or disabled. The backend composition root injects the resolved `ImageProvider[]` into the failover engine — the engine never names the registry or a concrete adapter.

## Public Interface
- `interface ProviderRegistry` — `chain(): ImageProvider[]`, `get(id): ImageProvider | undefined`, `quota(id): QuotaConfig`.
- `createRegistry(): ProviderRegistry` — construct a registry with lazy, cached adapter instantiation.
- `const registry: ProviderRegistry` — process-wide default consumed by the composition root.

## Inputs and Outputs
- `chain()`: reads `providerChainIds()`; when `REPLICATE_ENABLED` and `replicate` not already listed, appends it as tertiary; instantiates each id once (cached), dedups, and drops any factory that returns `undefined`.
- `get(id)`: returns the cached/instantiated adapter or `undefined`.
- `quota(id)`: delegates to `quotaFor(id)`.
- Per-provider gating: gemini needs `geminiApiKey()`; cloudflare needs account id + token; huggingface needs `huggingfaceToken()`; pollinations needs `pollinationsToken()`; replicate needs `replicateEnabled()` AND `replicateApiToken()`.

## Dependencies
- `lib/providers/config.ts` — chain ids, credential accessors, `replicateEnabled`, `quotaFor`.
- `lib/providers/{gemini,cloudflare,huggingface,pollinations,replicate}.ts` — adapter factories.
- `lib/providers/types.ts` — `ImageProvider`.

## Key Decisions
- Factories are lazy and the result (including `undefined`) is cached in a `Map`, so an uncredentialed provider is resolved once and a credentialed adapter is constructed at most once per process.
- A `seen` set dedups repeated ids in `PROVIDER_CHAIN`; the Replicate append guards against double-listing.
- The registry is the only DI seam — it is the single place where concrete adapters and env credentials meet, keeping the engine adapter-agnostic.

## Known Limitations
- The cache is process-lifetime: an env credential change is not picked up until the process restarts.
- An adapter factory that throws (rather than returning `undefined`) would propagate out of `chain()`; in practice the credential guards prevent the adapters' own auth-throw paths from being reached.
