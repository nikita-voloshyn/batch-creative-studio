/**
 * Client export — whole-batch ZIP (component C6, frontend).
 *
 * Zips the batch ENTIRELY in the browser (product-flow §2 step 14, §5e): the
 * server only ever hands us `result.imageUrl`s, so there is no server route that
 * holds all the bytes — the client `fetch`es each SUCCEEDED post's image and
 * packs them with `fflate`. Failed / unfinished items are skipped; a
 * `MANIFEST.txt` lists what's included and notes the skips.
 *
 * `fflate` (not jszip) is the zip lib — it is the lighter dependency. Images are
 * already compressed (PNG/JPEG/WebP), so each entry is STORED (`level: 0`) — no
 * wasted CPU trying to recompress pixels; only the text manifest is deflated.
 *
 * CORS: the per-image `fetch` is cross-origin to Vercel Blob; it works because
 * public result URLs allow the app origin. A CORS failure here is a Task 13
 * (deploy config) concern, never a server route (see `export.ts` for the note).
 *
 * Browser-only. No provider calls, no secrets.
 */

"use client";

import { strToU8, type Zippable, zipSync } from "fflate";
import { ExportError, fetchImageBytes, saveBlob } from "./export";

/** A single succeeded post to include in the zip (gathered from `batch.items`). */
export type ExportPost = {
  /** Zero-based tile index in the batch grid; the filename uses `index+1`. */
  index: number;
  imageUrl: string;
  providerId: string;
  /** `false` ⇒ the prompt-only style-degradation badge (§5c). */
  usedImageReference: boolean;
};

/** Right-pad to a fixed column so the manifest's listing stays aligned. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Build the human-readable `MANIFEST.txt` (only-succeeded note + per-post list). */
function buildManifest(args: {
  jobId: string | undefined;
  rows: string[];
  totalIncluded: number;
  totalItems: number;
}): string {
  const { jobId, rows, totalIncluded, totalItems } = args;
  const omitted = Math.max(0, totalItems - totalIncluded);
  return [
    "Batch Creative Studio — export manifest",
    `Job: ${jobId ?? "(unknown)"}`,
    `Exported: ${new Date().toISOString()}`,
    "",
    "This archive contains ONLY successfully generated posts.",
    "Failed or unfinished items are omitted from this export.",
    "",
    `Included posts: ${totalIncluded} of ${totalItems} total`,
    ...rows,
    "",
    omitted > 0
      ? `Omitted: ${omitted} item(s) did not succeed and were skipped.`
      : "Omitted: none — every item in the batch succeeded.",
    "",
  ].join("\n");
}

/**
 * Fetch every succeeded post's image, pack them + a `MANIFEST.txt` into a zip,
 * and trigger the download as `batch-{jobId}.zip`.
 *
 * @param posts      Only the SUCCEEDED items (caller filters by status).
 * @param jobId      Names the archive; `(unknown)` in the manifest if absent.
 * @param totalItems The whole batch size, so the manifest can report skips.
 */
export async function downloadBatchZip(
  posts: ExportPost[],
  jobId: string | undefined,
  totalItems: number,
): Promise<void> {
  if (posts.length === 0) {
    throw new ExportError("No finished posts to download yet.");
  }

  // Fetch all images in parallel; a single failure rejects the whole export
  // (surfaced as a retryable "zip failed" in the control).
  const fetched = await Promise.all(
    posts.map(async (post) => {
      const { bytes, ext } = await fetchImageBytes(post.imageUrl);
      return { post, bytes, ext };
    }),
  );

  const files: Zippable = {};
  const rows: string[] = [];
  for (const { post, bytes, ext } of fetched) {
    const name = `post-${post.index + 1}.${ext}`;
    // STORE (no deflate) — the bytes are already a compressed image.
    files[name] = [bytes, { level: 0 }];
    const style = post.usedImageReference ? "image-reference" : "prompt-only";
    rows.push(
      `  ${pad(name, 16)} provider: ${pad(post.providerId.toUpperCase(), 12)} style: ${style}`,
    );
  }

  files["MANIFEST.txt"] = strToU8(
    buildManifest({ jobId, rows, totalIncluded: posts.length, totalItems }),
  );

  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: "application/zip" });
  saveBlob(blob, jobId ? `batch-${jobId}.zip` : "batch.zip");
}
