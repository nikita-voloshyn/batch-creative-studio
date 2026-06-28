"use client";

import { DownloadAllButton } from "@/components/export/DownloadAllButton";
import { useBatchStore } from "@/lib/client/store";
import { ResultTile } from "./ResultTile";

/**
 * Batch grid (component C4, frontend). A responsive CSS grid (reflows desktop →
 * tablet → phone, NFR-7 / architecture §2.1) of N tiles. The container subscribes
 * only to the item COUNT and the global progress counters, so streaming results
 * re-render their single tile — not the whole grid. Each `ResultTile` keys on its
 * fixed index (the list is append-only at launch and never reordered).
 *
 * The batch toolbar carries the whole-batch "Download all (zip)" export (Task 11,
 * component C6); it's available progressively (disabled until >=1 item succeeds),
 * and the "New batch" reset joins it once the batch settles.
 */
export function BatchGrid() {
  const count = useBatchStore((s) => s.batch.items.length);
  const total = useBatchStore((s) => s.batch.total);
  const done = useBatchStore((s) => s.batch.done);
  const failed = useBatchStore((s) => s.batch.failed);
  const status = useBatchStore((s) => s.batch.status);
  const resetBatch = useBatchStore((s) => s.resetBatch);

  if (count === 0) return null;

  const settled = status === "done" || status === "gone";

  return (
    <section className="section" aria-label="Results">
      <div className="section__head">
        <span className="label">Batch</span>
        <span className="meta" aria-live="polite">
          {done} of {total} done · {failed} {failed === 1 ? "error" : "errors"}
        </span>
      </div>

      {status === "reconnecting" && (
        <p className="meta batchnote">Reconnecting… already-finished results are safe.</p>
      )}
      {status === "gone" && (
        <p className="rejection batchnote">
          This batch is no longer available — start a new one. Finished images remain visible.
        </p>
      )}

      <div className="grid">
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tiles are a fixed-length, never-reordered list.
          <ResultTile key={i} index={i} />
        ))}
      </div>

      <div className="batchactions">
        <DownloadAllButton />
        {settled && (
          <button type="button" className="btn" onClick={resetBatch}>
            New batch
          </button>
        )}
      </div>
    </section>
  );
}
