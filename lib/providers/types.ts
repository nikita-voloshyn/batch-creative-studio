/**
 * Provider abstraction contract (owner: providers — PV).
 *
 * Verbatim from architecture §4 / §7.1. The failover ENGINE (backend) is built
 * against THIS interface and nothing else; concrete adapters (Gemini, ...) live
 * in this package and implement it. `AspectRatio` has one canonical home in
 * `lib/types.ts` (owner: backend) and is re-exported here so providers never
 * redefine it.
 */
export type { AspectRatio } from "../types";

import type { AspectRatio } from "../types";

/**
 * One image-generation provider. The engine consumes only this surface; it
 * never names a concrete adapter or the registry.
 */
export interface ImageProvider {
  /** Stable id, e.g. "gemini" | "cloudflare" | "replicate". */
  id: string;
  /** Drives style conditioning (image reference) vs prompt-only degradation. */
  supportsImageReference: boolean;
  /**
   * Generate one post. Honors `signal` (per-attempt timeout / cancel owned by
   * the retry engine). On failure throws a `ProviderError` (neutral facts).
   */
  generate(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult>;
}

/** Everything an adapter needs for one item, fully resolved by the composition root. */
export type GenerateInput = {
  /** Trusted app-origin Blob URL (already SSRF-checked by the backend), not bytes. */
  productImageUrl: string;
  /** 1..2 reference images, already normalized (see `reference-normalize.ts`). */
  referenceImageUrls: string[];
  /** Shared template + brief + resolved per-image hint (see `prompt.ts`). */
  prompt: string;
  aspectRatio: AspectRatio;
  /** Per-batch deterministic seed (from `Job.seed`, architecture §5.6). */
  seed: number;
};

/** The result of one provider call. Never carries secrets or the API key. */
export type GenerateResult = {
  /** Raw image bytes OR a provider URL the backend re-persists (architecture §5.5). */
  imageBytes: Uint8Array | string;
  providerId: string;
  /** false => the post was produced prompt-only (degradation badge in the UI). */
  usedImageReference: boolean;
  /**
   * MIME type of `imageBytes` when the adapter knows it (e.g. "image/png" |
   * "image/webp" | "image/jpeg"). The backend result store uses this to derive
   * the per-item result-blob extension `results/{jobId}/{itemId}.{ext}`
   * (decisions.md 2026-06-26) so a failover that yields a DIFFERENT format than
   * the primary (e.g. Cloudflare WEBP vs Gemini PNG) cannot strand a stale-ext
   * blob for the same item. OPTIONAL: when absent (or for a provider-URL result
   * the backend must fetch), the backend falls back to magic-byte sniffing.
   * (Task 9 follow-up — see the providers handoff note.)
   */
  contentType?: string;
  meta: { latencyMs: number; model: string };
};
