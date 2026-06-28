"use client";

import { DownloadPostButton } from "@/components/export/DownloadPostButton";
import { useBatchStore } from "@/lib/client/store";
import type { AspectRatio } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

/**
 * Result tile (component C4, frontend). Each tile subscribes to its OWN slice of
 * the batch store (`batch.items[index]`) so it renders independently the moment
 * its `item.result` arrives — progressive, never blocking on the slowest tile.
 *
 * States (product-flow §3): QUEUED / GENERATING show a dimmed product placeholder;
 * DONE renders the result image as the hero (no card chrome) with a small provider
 * meta line; FAILED shows the human-readable cause + last provider + a Retry — except for
 * content-policy / invalid-input causes, which present the §5i "adjust brief /
 * replace image" affordance instead of a bare retry that would deterministically
 * fail the same input.
 */

const RATIO_CSS: Record<AspectRatio, string> = {
  "1:1": "1 / 1",
  "4:5": "4 / 5",
  "9:16": "9 / 16",
};

/** Causes where a plain re-run cannot help — the input itself must change (§5i). */
const INPUT_FATAL_CODES = new Set(["content_policy", "invalid_input"]);

/**
 * Map a raw failure into a clean, user-facing message. When every provider is
 * exhausted/unavailable (e.g. HuggingFace credit spent AND Cloudflare's daily quota
 * hit) the user just needs "try again later" — not the raw provider error dump (that
 * stays in `title` for debugging).
 */
function friendlyCause(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case "content_policy":
      return "Blocked by content moderation — try a different image or brief.";
    case "invalid_input":
      return "This input couldn't be processed — try a different image.";
    case "reference_normalization_failed":
      return "Couldn't read the reference image — try a different one.";
    default:
      // all_providers_exhausted, rate_limit, quota_exhausted, server, timeout, …
      return "Image providers are currently unavailable. Please try again in a moment.";
  }
}

export function ResultTile({ index }: { index: number }) {
  const item = useBatchStore((s) => s.batch.items[index]);
  const aspectRatio = useBatchStore((s) => s.batch.aspectRatio);
  const retry = useBatchStore((s) => s.retry);

  if (!item) return null;

  const isDone = item.status === "done" && item.result;
  const isFailed = item.status === "failed" && item.error;
  const inputFatal = isFailed && INPUT_FATAL_CODES.has(item.error?.code ?? "");

  return (
    <article className="tile">
      <div className="tile__frame" style={{ aspectRatio: RATIO_CSS[aspectRatio] }}>
        {isDone && item.result ? (
          // biome-ignore lint/performance/noImgElement: cross-origin Blob result URL, not a static asset.
          <img className="tile__img" src={item.result.imageUrl} alt="Generated post" />
        ) : item.previewUrl ? (
          // biome-ignore lint/performance/noImgElement: local object-URL placeholder, not a remote asset.
          <img
            className="tile__img tile__img--ghost"
            src={item.previewUrl}
            alt=""
            aria-hidden="true"
          />
        ) : null}

        {!isDone && (
          <div className="tile__overlay">
            <StatusBadge status={item.status} />
          </div>
        )}
      </div>

      <div className="tile__meta">
        {isDone && item.result && (
          <div className="tile__donerow">
            <span className="meta tile__provider">{item.result.providerId.toUpperCase()}</span>
            <DownloadPostButton imageUrl={item.result.imageUrl} index={index} />
          </div>
        )}

        {isFailed && item.error && (
          <div className="tile__error">
            <span className="status status--failed">Failed</span>
            <span className="rejection" title={item.error.message}>
              {friendlyCause(item.error)}
            </span>
            {inputFatal ? (
              <span className="meta tile__hint">
                Adjust the brief or replace this image, then start a new batch.
              </span>
            ) : (
              <button
                type="button"
                className="btn btn--ghost tile__retry"
                onClick={() => {
                  if (item.itemId) void retry(item.itemId);
                }}
                disabled={!item.itemId}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
