/**
 * Test fixtures + a fake `ProviderRegistry` (testing agent, Task 10).
 *
 * Builds in-memory `Job` / `Item` graphs and a registry over a fixed fake chain,
 * so orchestrator integration tests can inject a fully deterministic provider
 * chain through `OrchestratorDeps` without touching env or real adapters.
 */

import type { QuotaConfig } from "@/lib/providers/config";
import type { ProviderRegistry } from "@/lib/providers/registry";
import type { ImageProvider } from "@/lib/providers/types";
import type { Item, Job } from "@/lib/types";

let itemSeq = 0;

/** Build one queued `Item`. */
export function makeItem(jobId: string, overrides: Partial<Item> = {}): Item {
  itemSeq += 1;
  return {
    id: overrides.id ?? `item-${itemSeq}`,
    jobId,
    productImageUrl: overrides.productImageUrl ?? `https://blob.example/product-${itemSeq}.png`,
    status: overrides.status ?? "queued",
    attempts: overrides.attempts ?? [],
    result: overrides.result,
    error: overrides.error,
  };
}

/** Build a `Job` with N queued items. */
export function makeJob(
  jobId: string,
  itemCount: number,
  overrides: Partial<Omit<Job, "items">> = {},
): Job {
  const items = Array.from({ length: itemCount }, () => makeItem(jobId));
  return {
    id: jobId,
    status: overrides.status ?? "running",
    seed: overrides.seed ?? 12345,
    params: overrides.params ?? { aspectRatio: "1:1", brief: "test brief" },
    referenceImageUrls: overrides.referenceImageUrls ?? ["data:image/png;base64,AAAA"],
    items,
    createdAt: overrides.createdAt ?? new Date("2026-06-26T00:00:00.000Z").toISOString(),
  };
}

const DEFAULT_QUOTA: QuotaConfig = { dailyCap: 1000, rpm: 1000 };

/**
 * Fake registry over a fixed chain. `quota` returns a generous default (so the
 * token bucket never blocks and `nearDailyQuota` stays false) unless overridden
 * per provider id.
 */
export function createFakeRegistry(
  chain: ImageProvider[],
  quotas: Record<string, QuotaConfig> = {},
): ProviderRegistry {
  return {
    chain: () => [...chain],
    get: (id: string) => chain.find((p) => p.id === id),
    quota: (id: string) => quotas[id] ?? DEFAULT_QUOTA,
  };
}
