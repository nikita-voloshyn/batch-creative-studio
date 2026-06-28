---
component: ReferenceStyleExtractor
source: lib/providers/style-extract.ts
agent: providers
updated: 2026-06-28
---

# ReferenceStyleExtractor

## Purpose
Reads the batch's reference image(s) ONCE per job and turns their **mood** (lighting, colour grade, setting, atmosphere — deliberately not the objects) into a short text description. FLUX.1-Kontext is single-image, so this text is how the reference's style reaches a product-only edit: it is threaded into `buildPrompt({ referenceStyleText })`, and the product is then re-styled to that mood with no second image in the frame. Replaces the earlier, unreliable side-by-side "stitch" approach (see `docs/state/decisions.md`, 2026-06-28).

## Public Interface
- `extractReferenceStyleText(referenceImageUrls: string[], signal?: AbortSignal): Promise<string | undefined>` — returns the mood text, or `undefined` (best-effort) when there are no references, `HF_TOKEN` is missing, the references can't be fetched, or every VLM attempt fails. Never throws — extraction can never fail a job; the prompt then leans on the brief alone.

## Inputs and Outputs
- Fetches up to 2 reference images via `fetchImageAsInlineData` and builds base64 `data:` URLs.
- Calls `client.chatCompletion({ model, messages: [{ role: "user", content: [text + image_url(s)] }], max_tokens: 400 })` on HuggingFace, trying each VLM in `huggingfaceVisionModels()` in order until one answers (default `google/gemma-3-27b-it`, then Qwen2.5-VL / Llama-3.2-Vision fallbacks — single-VLM availability on HF Inference Providers varies).
- Each call is bounded by a per-model timeout race.
- Returns the first response longer than ~20 chars; logs `reference_style_extracted` on success and `reference_style_extract_failed` per failed model.

## Dependencies
- `@huggingface/inference` — `InferenceClient` (same `HF_TOKEN` as the image path; a once-per-job text call is cheap).
- `lib/providers/config.ts` — `huggingfaceToken`, `huggingfaceVisionModels`.
- `lib/providers/reference-normalize.ts` — `fetchImageAsInlineData`.

## Key Decisions
- **Mood as text, not the reference image.** Kontext can't take a second image as a style input; the side-by-side composite ("stitch") intermittently ignored the reference, echoed its objects, or returned a collage. Vision-to-text applies the mood consistently across the whole batch with zero reference-leak.
- **Best-effort, never blocking.** Any failure returns `undefined` so the orchestrator's `buildContext` proceeds; the batch never depends on the vision call.
- **Runs on HuggingFace** (not Cloudflare) — Cloudflare's free 10k-neuron/day cap is easily exhausted, and keeping the creative path on one provider is simpler.

## Known Limitations
- The style is text-approximated, not pixel-exact; copying the reference's precise look needs an image-conditioned model (Gemini / IP-Adapter), a config swap behind the same interface.
- Adds a few seconds to job start (one VLM call before the worker pool runs); it is a single call per job, not per item.
