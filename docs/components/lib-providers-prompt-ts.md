---
component: BuildPrompt
source: lib/providers/prompt.ts
agent: providers
updated: 2026-06-28
---

# BuildPrompt

## Purpose
The shared prompt/style-text builder — one template across the whole batch, which is the basis of style consistency. The composition root invokes it per item; the returned string becomes `GenerateInput.prompt`.

## Public Interface
- `type BuildPromptArgs` — `{ brief?, captionHint?, referenceStyleText?, aspectRatio?, usesImageReference? }`.
- `buildPrompt(args: BuildPromptArgs): string` — compose the cohesive batch prompt for one item.

## Inputs and Outputs
- Receives already-resolved inputs (the builder does no resolution): `brief` = `Job.params.brief`; `captionHint` = resolved `params.perImageHints?.[productImageUrl]`; `referenceStyleText` = the once-per-job extracted reference-style description; `aspectRatio`; `usesImageReference` (default true).
- Returns a single space-joined string assembled from: a product-preservation instruction; (when `usesImageReference`) a style-match-the-reference instruction; reference style cues — phrased as image cues when `usesImageReference`, else "reproduce this style from the description"; the creative brief; the per-item hint; and an aspect-ratio framing line.

## Dependencies
- `lib/providers/types.ts` — `AspectRatio`.

## Key Decisions
- Pure function of resolved inputs — keeps prompt assembly deterministic and testable, with all resolution (per-image hints, style extraction) done upstream by the composition root.
- `usesImageReference: false` (a `supportsImageReference: false` fallback model) leans on `referenceStyleText` instead of image conditioning, so prompt-only degradation still approximates the look.
- Aspect ratio is instructed in text (`ASPECT_GUIDANCE`) so even models that do not apply it natively still aim for the ratio.

## Known Limitations
- All fields are optional; with none supplied the prompt is just the base product-preservation instruction.
- The reference-style text quality depends entirely on the upstream extractor (architecture §5c), which this module does not own.
