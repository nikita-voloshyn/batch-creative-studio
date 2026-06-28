/**
 * Public surface of the providers package (owner: providers — PV).
 *
 * The backend composition root imports from here (or from the individual
 * modules). Secret accessors (e.g. `geminiApiKey`) are intentionally NOT
 * re-exported — they stay internal to the package.
 */
export { createCloudflareProvider } from "./cloudflare";
export type { CloudflareModelCaps, QuotaConfig } from "./config";
export {
  aspectRatioDimensions,
  cloudflareModelCaps,
  providerChainIds,
  providerSupportsSeed,
  quotaFor,
  replicateEnabled,
} from "./config";
export { kindFromHttpStatus, ProviderError, type ProviderErrorKind } from "./errors";
export { createGeminiProvider } from "./gemini";
export { createHuggingFaceProvider } from "./huggingface";
export { createPollinationsProvider } from "./pollinations";
export { type BuildPromptArgs, buildPrompt } from "./prompt";
export {
  fetchImageAsInlineData,
  type InlineImage,
  normalizeReferences,
  ReferenceNormalizationError,
} from "./reference-normalize";
export { createRegistry, type ProviderRegistry, registry } from "./registry";
export { createReplicateProvider } from "./replicate";
export { extractReferenceStyleText } from "./style-extract";
export type { AspectRatio, GenerateInput, GenerateResult, ImageProvider } from "./types";
