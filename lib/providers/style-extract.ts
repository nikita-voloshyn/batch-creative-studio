/**
 * Reference MOOD extractor (owner: providers — PV).
 *
 * FLUX.1-Kontext is a SINGLE-image edit, so the reference image's mood cannot be
 * fed to the image model as a second input. The earlier approach — compositing the
 * product and reference SIDE BY SIDE into one Kontext input ("stitching") — proved
 * unreliable in live tests: the model intermittently ignored the reference, echoed
 * its objects into the output, or returned a collage / side-by-side.
 *
 * Instead we read the reference ONCE per job with a vision-language model and turn
 * its MOOD (lighting, color grade, setting, atmosphere — never specific objects)
 * into a short text description. That text is threaded into the per-item prompt
 * (`buildPrompt({ referenceStyleText })`), so a product-ONLY Kontext edit re-lights
 * the product in the reference's mood with NO second object in the frame: the
 * product is always preserved, the same style is applied across the whole batch,
 * and there is no reference-leak (live-validated 2026-06-28 — see decisions.md).
 *
 * Runs on HuggingFace chat-completion (the same `HF_TOKEN` as the image path; a
 * once-per-job text call is cheap). Best-effort: any failure returns `undefined`
 * and the prompt falls back to the brief alone — extraction never fails a job.
 */

import { InferenceClient } from "@huggingface/inference";
import { huggingfaceToken, huggingfaceVisionModels } from "./config";
import { fetchImageAsInlineData } from "./reference-normalize";

/**
 * VLM instruction: describe ONLY the transferable mood (light/color/setting/
 * atmosphere), never the concrete objects — so the description re-styles a
 * different product without dragging the reference's furniture into the output.
 */
const VISION_PROMPT =
  "You are an art director. Describe ONLY the visual MOOD of the reference image(s) so it can be used to " +
  "re-light and re-stage a DIFFERENT product photo in the same style. In 2-3 sentences cover: lighting " +
  "(direction, hardness, warmth), color palette / color grade, the type of background setting, and the " +
  "overall atmosphere. Do NOT name or describe any specific objects, furniture, or items shown. Output " +
  "only the mood description, nothing else.";

/** Per-model timeout; the VLM is a small text response, so this is generous. */
const PER_CALL_TIMEOUT_MS = 45_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("vision call timeout")), ms)),
  ]);
}

/**
 * Extract a short MOOD description from the job's reference image(s). Returns
 * `undefined` (best-effort) when there are no references, the HF token is missing,
 * the references can't be fetched, or every VLM attempt fails — the caller then
 * leans on the brief alone. Tries the configured VLMs in order until one answers
 * (availability of any single HF Inference-Providers VLM varies, so a small
 * fallback list makes extraction robust).
 */
export async function extractReferenceStyleText(
  referenceImageUrls: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (referenceImageUrls.length === 0) return undefined;
  const token = huggingfaceToken();
  if (!token) return undefined;

  let dataUrls: string[];
  try {
    const images = await Promise.all(
      referenceImageUrls.slice(0, 2).map((url) => fetchImageAsInlineData(url, signal)),
    );
    dataUrls = images.map((img) => `data:${img.mimeType};base64,${img.base64}`);
  } catch {
    return undefined;
  }

  const client = new InferenceClient(token);
  const content = [
    { type: "text", text: VISION_PROMPT },
    ...dataUrls.map((url) => ({ type: "image_url", image_url: { url } })),
  ];

  for (const model of huggingfaceVisionModels()) {
    if (signal?.aborted) return undefined;
    try {
      const res = await withTimeout(
        client.chatCompletion(
          {
            model,
            // The SDK accepts OpenAI-style multimodal content parts (text + image_url).
            messages: [{ role: "user", content: content as never }],
            max_tokens: 400,
          },
          { signal },
        ),
        PER_CALL_TIMEOUT_MS,
      );
      const text = res?.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 20) {
        console.info(
          JSON.stringify({
            level: "info",
            event: "reference_style_extracted",
            model,
            chars: text.length,
          }),
        );
        return text;
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "reference_style_extract_failed",
          model,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return undefined;
}
