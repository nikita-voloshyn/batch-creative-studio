/**
 * Provider / model / quota configuration (owner: providers — PV).
 *
 * Env-driven per decisions.md (2026-06-26): chain order, RPM, daily quota, and
 * model ids change WITHOUT a redeploy. SERVER-SIDE ONLY: secrets such as
 * `GEMINI_API_KEY` are read here and must never reach the client or appear in a
 * `GenerateResult`. The accessor below is intentionally not re-exported from the
 * package barrel.
 */

/** Per-provider quota + rate-limit knobs consumed by the backend (architecture §5.4 / §6.4). */
export type QuotaConfig = {
  /** Soft daily cap, used for the quota pre-switch (architecture §5.4). */
  dailyCap: number;
  /** Requests-per-minute ceiling for the per-provider token bucket. */
  rpm: number;
};

import type { AspectRatio } from "./types";

const DEFAULT_PROVIDER_CHAIN = "huggingface,cloudflare";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";
const DEFAULT_GEMINI_RPM = 10;
const DEFAULT_GEMINI_DAILY_QUOTA = 500;

// ── Cloudflare Workers AI (secondary) ─────────────────────────────────────
// Default = FLUX.2 [klein], the unified gen+EDIT model that accepts input
// (reference) images via multipart `input_image_N`, so the secondary can keep
// image-reference conditioning (product-flow §5.2 / §5b). Switching the env to a
// text-only model (FLUX.1 [schnell] / SDXL) flips `supportsImageReference` off
// and the chain degrades to prompt-only (product-flow §5c) — see `cloudflareModelCaps`.
const DEFAULT_CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";
const DEFAULT_CLOUDFLARE_RPM = 30;
const DEFAULT_CLOUDFLARE_DAILY_QUOTA = 200;

// ── Replicate (optional tertiary, gated by REPLICATE_ENABLED) ─────────────
const DEFAULT_REPLICATE_MODEL = "black-forest-labs/flux-dev";
const DEFAULT_REPLICATE_IMAGE_INPUT_KEY = "image";
const DEFAULT_REPLICATE_RPM = 10;
const DEFAULT_REPLICATE_DAILY_QUOTA = 100;

// ── Pollinations (free, gated by POLLINATIONS_TOKEN) ──────────────────────
// Default = `gptimage`, the image-INPUT (img2img) model that actually works with
// a free account token (live-verified: token + `image=<url>` → 200, conditions
// on the input image). `nanobanana` / `kontext` / `seedream` are PREMIUM-tier on
// enter.pollinations.ai — they 500 ("only available on enter.pollinations.ai")
// even WITH the free token, so they are not the default (set POLLINATIONS_MODEL
// only if you hold premium access). All require the free token
// (https://enter.pollinations.ai). RPM defaults conservatively because the
// anonymous tier is ~1 req/15s; a token raises it (env-overridable).
const DEFAULT_POLLINATIONS_MODEL = "gptimage";
const DEFAULT_POLLINATIONS_RPM = 6;
const DEFAULT_POLLINATIONS_DAILY_QUOTA = 100;

// ── HuggingFace (free, product-PRESERVING; gated by HF_TOKEN) ──────────────
// Default = FLUX.1-Kontext-dev, a TRUE image-editing (img2img) model that
// conditions on the PRODUCT image and restyles it per the prompt while preserving
// the scene (decisions.md 2026-06-28) — the only free option that keeps the
// product intact, so it heads the free chain. Routed through an Inference Provider
// (default `fal-ai`, the live-verified provider; env-overridable). No seed param is
// exposed by HF img2img here. RPM defaults conservatively (free monthly credit).
const DEFAULT_HUGGINGFACE_MODEL = "black-forest-labs/FLUX.1-Kontext-dev";
const DEFAULT_HUGGINGFACE_PROVIDER = "fal-ai";
const DEFAULT_HUGGINGFACE_RPM = 6;
const DEFAULT_HUGGINGFACE_DAILY_QUOTA = 100;
// Vision-language models (in fallback order) used ONCE per job to turn the
// reference image's MOOD into text for the product-only Kontext edit (see
// `style-extract.ts`). `gemma-3-27b-it` leads because it was the live-verified
// available VLM (2026-06-28) when the Qwen2.5-VL / Llama-3.2-Vision routes 503'd;
// the rest are fallbacks. `HUGGINGFACE_VISION_MODEL` prepends a preferred id.
const DEFAULT_HUGGINGFACE_VISION_MODELS = [
  "google/gemma-3-27b-it",
  "Qwen/Qwen2.5-VL-7B-Instruct",
  "meta-llama/Llama-3.2-11B-Vision-Instruct",
];
// Backstop bound for the cold-start hang (the SDK's first cold-provider call can
// hang without resolving): the adapter races the call against this AND the
// per-attempt AbortSignal, turning a hang into a retryable `timeout`.
const DEFAULT_HUGGINGFACE_TIMEOUT_MS = 120_000;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Ordered provider ids from `PROVIDER_CHAIN` (the failover order). */
export function providerChainIds(): string[] {
  const raw = process.env.PROVIDER_CHAIN ?? DEFAULT_PROVIDER_CHAIN;
  return raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
}

/**
 * Gemini API key — SERVER-SIDE ONLY. Returns `undefined` when unset so the
 * registry can omit the uncredentialed provider from the chain (architecture §4).
 */
export function geminiApiKey(): string | undefined {
  const key = process.env.GEMINI_API_KEY;
  return key && key.trim() !== "" ? key : undefined;
}

/** Gemini model id; overridable via `GEMINI_MODEL`. */
export function geminiModel(): string {
  const model = process.env.GEMINI_MODEL;
  return model && model.trim() !== "" ? model.trim() : DEFAULT_GEMINI_MODEL;
}

function geminiQuota(): QuotaConfig {
  return {
    dailyCap: positiveIntFromEnv("GEMINI_DAILY_QUOTA", DEFAULT_GEMINI_DAILY_QUOTA),
    rpm: positiveIntFromEnv("GEMINI_RPM", DEFAULT_GEMINI_RPM),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Cloudflare Workers AI
 * ────────────────────────────────────────────────────────────────────────── */

/** Cloudflare account id — SERVER-SIDE ONLY. `undefined` when unset. */
export function cloudflareAccountId(): string | undefined {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID;
  return id && id.trim() !== "" ? id.trim() : undefined;
}

/** Cloudflare API token — SERVER-SIDE ONLY. `undefined` when unset. */
export function cloudflareApiToken(): string | undefined {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  return token && token.trim() !== "" ? token.trim() : undefined;
}

/** Cloudflare Workers AI model id; overridable via `CLOUDFLARE_MODEL`. */
export function cloudflareModel(): string {
  const model = process.env.CLOUDFLARE_MODEL;
  return model && model.trim() !== "" ? model.trim() : DEFAULT_CLOUDFLARE_MODEL;
}

/**
 * Per-model capabilities for the Cloudflare adapter, classified by model id so
 * the adapter sends the RIGHT request shape and reports `supportsImageReference`
 * ACCURATELY (Context7-verified against the Workers AI changelog/model docs):
 *
 *  - FLUX.2 family (`@cf/black-forest-labs/flux-2-*`): unified gen+EDIT. Takes
 *    `multipart/form-data` with binary `input_image_0..3` reference images,
 *    plus `width`/`height`/`seed`. => acceptsImageInput, multipart, seed, dims.
 *  - FLUX.1 [schnell] (`@cf/black-forest-labs/flux-1-schnell`): TEXT-ONLY JSON
 *    (`{ prompt, steps }`); no image input, no seed/dims params in its schema.
 *  - SDXL / other diffusion (`@cf/stabilityai/...`, etc.): TEXT-ONLY JSON
 *    (`{ prompt, width, height, seed, ... }`); no reference image input.
 */
export type CloudflareModelCaps = {
  /** Model accepts input/reference image(s) as conditioning (drives `supportsImageReference`). */
  acceptsImageInput: boolean;
  /** Request encoding: FLUX.2 edit family is multipart; text-only models are JSON. */
  encoding: "multipart" | "json";
  /** Model honors a `seed` parameter. */
  supportsSeed: boolean;
  /** Model honors `width`/`height` parameters. */
  supportsDimensions: boolean;
};

export function cloudflareModelCaps(model: string = cloudflareModel()): CloudflareModelCaps {
  const id = model.toLowerCase();
  if (id.includes("flux-2") || id.includes("flux.2")) {
    return {
      acceptsImageInput: true,
      encoding: "multipart",
      supportsSeed: true,
      supportsDimensions: true,
    };
  }
  if (id.includes("flux-1-schnell") || id.includes("flux-schnell")) {
    return {
      acceptsImageInput: false,
      encoding: "json",
      supportsSeed: false,
      supportsDimensions: false,
    };
  }
  // SDXL and other text-only diffusion models: JSON, no reference image.
  return {
    acceptsImageInput: false,
    encoding: "json",
    supportsSeed: true,
    supportsDimensions: true,
  };
}

function cloudflareQuota(): QuotaConfig {
  return {
    dailyCap: positiveIntFromEnv("CLOUDFLARE_DAILY_QUOTA", DEFAULT_CLOUDFLARE_DAILY_QUOTA),
    rpm: positiveIntFromEnv("CLOUDFLARE_RPM", DEFAULT_CLOUDFLARE_RPM),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Replicate (optional tertiary)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Whether the Replicate adapter is enabled. Default FALSE (decisions.md
 * 2026-06-26): the registry omits Replicate from the chain unless this is true.
 */
export function replicateEnabled(): boolean {
  return (process.env.REPLICATE_ENABLED ?? "").trim().toLowerCase() === "true";
}

/** Replicate API token — SERVER-SIDE ONLY. `undefined` when unset. */
export function replicateApiToken(): string | undefined {
  const token = process.env.REPLICATE_API_TOKEN;
  return token && token.trim() !== "" ? token.trim() : undefined;
}

/** Replicate model ref (`owner/name` for latest, or `owner/name:version`). */
export function replicateModel(): string {
  const model = process.env.REPLICATE_MODEL;
  return model && model.trim() !== "" ? model.trim() : DEFAULT_REPLICATE_MODEL;
}

/**
 * Which Replicate model input key receives the reference (style) image. FLUX
 * img2img uses `image`; an IP-Adapter / Redux model would use `redux_image` /
 * `image_prompt`. Configurable so the gated adapter adapts to the chosen model
 * without a code change (exact schema confirmed at live validation, Task 13).
 */
export function replicateImageInputKey(): string {
  const key = process.env.REPLICATE_IMAGE_INPUT_KEY;
  return key && key.trim() !== "" ? key.trim() : DEFAULT_REPLICATE_IMAGE_INPUT_KEY;
}

function replicateQuota(): QuotaConfig {
  return {
    dailyCap: positiveIntFromEnv("REPLICATE_DAILY_QUOTA", DEFAULT_REPLICATE_DAILY_QUOTA),
    rpm: positiveIntFromEnv("REPLICATE_RPM", DEFAULT_REPLICATE_RPM),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Pollinations (free)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Pollinations free account token — SERVER-SIDE ONLY. Returns `undefined` when
 * unset so the registry omits the uncredentialed provider (the image-editing
 * models require it; without it the `image` param is ignored). Intentionally NOT
 * re-exported from the package barrel — it stays internal, like `geminiApiKey`.
 */
export function pollinationsToken(): string | undefined {
  const token = process.env.POLLINATIONS_TOKEN;
  return token && token.trim() !== "" ? token.trim() : undefined;
}

/** Pollinations model id; overridable via `POLLINATIONS_MODEL` (default `gptimage`). */
export function pollinationsModel(): string {
  const model = process.env.POLLINATIONS_MODEL;
  return model && model.trim() !== "" ? model.trim() : DEFAULT_POLLINATIONS_MODEL;
}

function pollinationsQuota(): QuotaConfig {
  return {
    dailyCap: positiveIntFromEnv("POLLINATIONS_DAILY_QUOTA", DEFAULT_POLLINATIONS_DAILY_QUOTA),
    rpm: positiveIntFromEnv("POLLINATIONS_RPM", DEFAULT_POLLINATIONS_RPM),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 * HuggingFace (free, product-preserving FLUX.1-Kontext-dev img2img)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * HuggingFace fine-grained token (the "Inference Providers" permission) —
 * SERVER-SIDE ONLY. Returns `undefined` when unset so the registry omits the
 * uncredentialed provider from the chain. Intentionally NOT re-exported from the
 * package barrel — it stays internal, like `geminiApiKey` / `pollinationsToken`.
 */
export function huggingfaceToken(): string | undefined {
  const token = process.env.HF_TOKEN;
  return token && token.trim() !== "" ? token.trim() : undefined;
}

/** HuggingFace model id; overridable via `HUGGINGFACE_MODEL`. */
export function huggingfaceModel(): string {
  const model = process.env.HUGGINGFACE_MODEL;
  return model && model.trim() !== "" ? model.trim() : DEFAULT_HUGGINGFACE_MODEL;
}

/** Inference Provider that runs the model (default `fal-ai`); via `HUGGINGFACE_PROVIDER`. */
export function huggingfaceProvider(): string {
  const provider = process.env.HUGGINGFACE_PROVIDER;
  return provider && provider.trim() !== "" ? provider.trim() : DEFAULT_HUGGINGFACE_PROVIDER;
}

/** Backstop timeout (ms) for the cold-start hang guard; via `HUGGINGFACE_TIMEOUT_MS`. */
export function huggingfaceTimeoutMs(): number {
  return positiveIntFromEnv("HUGGINGFACE_TIMEOUT_MS", DEFAULT_HUGGINGFACE_TIMEOUT_MS);
}

/**
 * Ordered VLM model ids for reference-mood extraction (`style-extract.ts`). The
 * extractor tries them in order until one answers. `HUGGINGFACE_VISION_MODEL`
 * prepends a preferred id (deduped) without dropping the built-in fallbacks.
 */
export function huggingfaceVisionModels(): string[] {
  const preferred = process.env.HUGGINGFACE_VISION_MODEL?.trim();
  const list = [...DEFAULT_HUGGINGFACE_VISION_MODELS];
  if (preferred && !list.includes(preferred)) list.unshift(preferred);
  return list;
}

function huggingfaceQuota(): QuotaConfig {
  return {
    dailyCap: positiveIntFromEnv("HUGGINGFACE_DAILY_QUOTA", DEFAULT_HUGGINGFACE_DAILY_QUOTA),
    rpm: positiveIntFromEnv("HUGGINGFACE_RPM", DEFAULT_HUGGINGFACE_RPM),
  };
}

/**
 * Map the canonical output `AspectRatio` to concrete pixel dimensions for models
 * that take `width`/`height` (Cloudflare FLUX.2 / SDXL). Values stay within the
 * Workers AI 256–1920 range. Text-only models that ignore dimensions still aim
 * for the ratio via the prompt text (`buildPrompt` adds aspect guidance).
 */
export function aspectRatioDimensions(ratio: AspectRatio): { width: number; height: number } {
  switch (ratio) {
    case "1:1":
      return { width: 1024, height: 1024 };
    case "4:5":
      return { width: 1024, height: 1280 };
    case "9:16":
      return { width: 1080, height: 1920 };
  }
}

const FALLBACK_QUOTA: QuotaConfig = {
  dailyCap: DEFAULT_GEMINI_DAILY_QUOTA,
  rpm: DEFAULT_GEMINI_RPM,
};

/** Whether a provider can honor a deterministic seed (architecture §5.6). */
export function providerSupportsSeed(id: string): boolean {
  switch (id) {
    case "gemini":
      return true;
    case "cloudflare":
      // Depends on the configured model: FLUX.2 / SDXL accept a seed; FLUX.1
      // [schnell] does not (its schema is `prompt` + `steps` only).
      return cloudflareModelCaps().supportsSeed;
    case "replicate":
      // FLUX (dev/schnell) on Replicate honors `seed`.
      return true;
    case "pollinations":
      // Pollinations honors a `seed` query param for deterministic output.
      return true;
    case "huggingface":
      // FLUX.1-Kontext-dev via the HF img2img task exposes no seed parameter.
      return false;
    default:
      return false;
  }
}

/** Quota + RPM config by provider id (backs `ProviderRegistry.quota`). */
export function quotaFor(id: string): QuotaConfig {
  switch (id) {
    case "gemini":
      return geminiQuota();
    case "cloudflare":
      return cloudflareQuota();
    case "replicate":
      return replicateQuota();
    case "pollinations":
      return pollinationsQuota();
    case "huggingface":
      return huggingfaceQuota();
    default:
      return FALLBACK_QUOTA;
  }
}
