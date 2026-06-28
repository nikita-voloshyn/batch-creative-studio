/**
 * Provider registry (owner: providers — PV).
 *
 * Builds the ordered failover chain from env (`PROVIDER_CHAIN`), omitting any
 * provider whose adapter is not implemented or that lacks credentials
 * (architecture §4). The backend composition root (`orchestrator.ts`) is the DI
 * seam: it calls `registry.chain()` once per Job and injects the resolved
 * `ImageProvider[]` into the failover engine — the engine never names the
 * registry or a concrete adapter.
 */
import { createCloudflareProvider } from "./cloudflare";
import {
  cloudflareAccountId,
  cloudflareApiToken,
  geminiApiKey,
  huggingfaceToken,
  pollinationsToken,
  providerChainIds,
  type QuotaConfig,
  quotaFor,
  replicateApiToken,
  replicateEnabled,
} from "./config";
import { createGeminiProvider } from "./gemini";
import { createHuggingFaceProvider } from "./huggingface";
import { createPollinationsProvider } from "./pollinations";
import { createReplicateProvider } from "./replicate";
import type { ImageProvider } from "./types";

export interface ProviderRegistry {
  /** Ordered failover chain from env; absent/uncredentialed providers omitted. */
  chain(): ImageProvider[];
  get(id: string): ImageProvider | undefined;
  quota(id: string): QuotaConfig;
}

/** Returns an adapter instance, or `undefined` when the provider is uncredentialed. */
type ProviderFactory = () => ImageProvider | undefined;

export function createRegistry(): ProviderRegistry {
  // Lazily instantiate and cache each adapter. Each factory returns `undefined`
  // when the provider is uncredentialed (or, for Replicate, disabled), so the
  // chain omits it.
  const factories: Record<string, ProviderFactory> = {
    gemini: () => (geminiApiKey() ? createGeminiProvider() : undefined),
    cloudflare: () =>
      cloudflareAccountId() && cloudflareApiToken() ? createCloudflareProvider() : undefined,
    // Free, product-PRESERVING provider (FLUX.1-Kontext-dev img2img), GATED on the
    // HF token: an uncredentialed HuggingFace is omitted from the chain.
    huggingface: () => (huggingfaceToken() ? createHuggingFaceProvider() : undefined),
    // Free provider, GATED on the account token: the image-input models require
    // it, so an uncredentialed Pollinations is omitted from the chain.
    pollinations: () => (pollinationsToken() ? createPollinationsProvider() : undefined),
    // Tertiary, OFF by default: only when REPLICATE_ENABLED=true AND credentialed.
    replicate: () =>
      replicateEnabled() && replicateApiToken() ? createReplicateProvider() : undefined,
  };
  const cache = new Map<string, ImageProvider | undefined>();

  function instantiate(id: string): ImageProvider | undefined {
    if (cache.has(id)) return cache.get(id);
    const factory = factories[id];
    const instance = factory ? factory() : undefined;
    cache.set(id, instance);
    return instance;
  }

  return {
    chain(): ImageProvider[] {
      // Failover order from `PROVIDER_CHAIN` (default `gemini,cloudflare`). When
      // REPLICATE_ENABLED=true, append `replicate` as the tertiary if the chain
      // env did not already list it (decisions.md 2026-06-26).
      const ids = providerChainIds();
      if (replicateEnabled() && !ids.includes("replicate")) ids.push("replicate");

      const providers: ImageProvider[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const provider = instantiate(id);
        if (provider) providers.push(provider);
      }
      return providers;
    },
    get(id: string): ImageProvider | undefined {
      return instantiate(id);
    },
    quota(id: string): QuotaConfig {
      return quotaFor(id);
    },
  };
}

/** Process-wide default registry consumed by the composition root. */
export const registry: ProviderRegistry = createRegistry();
