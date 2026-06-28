/**
 * Shared prompt / style-text builder (owner: providers — PV).
 *
 * One template across the whole batch — the basis of style consistency
 * (architecture §4 / §6.3, spec §6.3). Invoked by the composition root per Item
 * (a declared backend -> providers dependency); the returned string is placed in
 * `GenerateInput.prompt`. The builder only RECEIVES the already-resolved inputs:
 *   - the per-image caption hint = `Job.params.perImageHints?.[productImageUrl]`,
 *     resolved by the composition root (decisions.md 2026-06-26);
 *   - the textual description of the extracted reference style (produced once per
 *     job by the style-text extractor, architecture §5c) — included so prompt-only
 *     fallback models can still approximate the look.
 */
import type { AspectRatio } from "./types";

export type BuildPromptArgs = {
  /** Batch-level creative brief (`Job.params.brief`). */
  brief?: string;
  /** Resolved per-image caption hint (`params.perImageHints?.[productImageUrl]`). */
  captionHint?: string;
  /** Textual description of the extracted reference style (architecture §5c). */
  referenceStyleText?: string;
  /** Target output ratio; instructed in text so non-native models still aim for it. */
  aspectRatio?: AspectRatio;
  /**
   * Whether the target model will receive the reference image(s) as image input.
   * When false (a `supportsImageReference: false` fallback) the builder leans on
   * `referenceStyleText` instead of image conditioning (product-flow §5c).
   */
  usesImageReference?: boolean;
};

const ASPECT_GUIDANCE: Record<AspectRatio, string> = {
  "1:1": "a square 1:1 composition",
  "4:5": "a vertical 4:5 portrait composition",
  "9:16": "a tall 9:16 vertical composition",
};

/** Compose the cohesive batch prompt for one item. */
export function buildPrompt(args: BuildPromptArgs): string {
  const { brief, captionHint, referenceStyleText, aspectRatio, usesImageReference = true } = args;
  const lines: string[] = [];

  // Drive a real transformation (this is an image-EDIT/img2img instruction) while
  // PRESERVING the product's identity. "Keep everything intact" made edit models
  // return the input nearly unchanged, so the product is kept exactly but the
  // scene/lighting/atmosphere around it are restyled. (Live-validated wording.)
  lines.push(
    "Transform this product photo into a polished, professional social-media post. " +
      "Keep the product itself exactly accurate and recognizable — its real shape, " +
      "proportions, colors, materials, and any branding — as the clear hero.",
  );

  const style = referenceStyleText?.trim();
  if (style) {
    // The reference's MOOD as text — the primary style signal for a product-only
    // edit. Validated phrasing: explicitly RE-LIGHT/RE-STAGE to this mood so the
    // model actually applies it instead of returning the input.
    lines.push(
      `Re-light and re-stage the scene, background, and atmosphere to match this mood: ${style}`,
    );
    if (usesImageReference) {
      // An image-conditioned fallback ALSO receives the reference image(s).
      lines.push("Stay consistent with the provided reference image(s).");
    }
  } else if (usesImageReference) {
    // Reference image(s) sent but no extracted text → lean on the image alone.
    lines.push(
      "Match the visual style, palette, lighting, and mood of the provided reference " +
        "image(s) so this post stays visually consistent with the rest of the batch.",
    );
  }

  const briefText = brief?.trim();
  if (briefText) {
    lines.push(`Scene and style direction: ${briefText}.`);
  } else if (!usesImageReference && !style) {
    // No brief and no reference signal → give the edit model a concrete default so it
    // actually restyles (otherwise an edit model leaves the photo nearly unchanged).
    lines.push(
      "Use a clean, modern lifestyle setting: soft studio lighting, tasteful props, a " +
        "cohesive color palette, and a shallow depth of field.",
    );
  }

  const hint = captionHint?.trim();
  if (hint) lines.push(`For this specific item: ${hint}.`);

  if (aspectRatio) {
    lines.push(`Frame the image as ${ASPECT_GUIDANCE[aspectRatio]} (aspect ratio ${aspectRatio}).`);
  }

  return lines.join(" ");
}
