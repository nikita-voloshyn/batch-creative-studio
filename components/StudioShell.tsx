"use client";

import { useMemo } from "react";
import { BatchGrid } from "@/components/grid/BatchGrid";
import { ParamsForm } from "@/components/params/ParamsForm";
import { Uploader } from "@/components/uploader/Uploader";
import { isReadyToGenerate, useBatchStore } from "@/lib/client/store";

/**
 * Studio shell (component C1/C2/C3/C4 composition root, frontend). Client island
 * that composes the uploader, the params form, the Generate action, and the
 * SSE-driven batch grid under the editorial content column.
 *
 * On Generate, the store uploads were already done eagerly (Generate is gated on
 * every file being uploaded), so the click builds the `CreateJobRequest`, renders
 * N optimistic placeholder tiles, `createJob`s, and opens the SSE stream — all in
 * `useBatchStore.generate`. The button is disabled until the selection is ready
 * (≥1 product, 1–2 references, all uploaded) and while a batch is in flight.
 */
export function StudioShell() {
  const entries = useBatchStore((s) => s.entries);
  const generate = useBatchStore((s) => s.generate);
  const connection = useBatchStore((s) => s.batch.status);
  const launchError = useBatchStore((s) => s.batch.launchError);

  const ready = useMemo(() => isReadyToGenerate(entries), [entries]);
  const busy =
    connection === "connecting" || connection === "open" || connection === "reconnecting";

  return (
    <>
      <Uploader disabled={busy} />
      <hr />
      <ParamsForm disabled={busy} />
      <hr />
      <section className="section" aria-label="Generate">
        <div className="generate">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!ready || busy}
            onClick={() => void generate()}
          >
            {busy ? "Generating…" : "Generate"}
          </button>
          <span className="generate__hint">
            {ready
              ? "Ready — one styled post will be generated per product image."
              : "Add at least one product image and a reference image to begin."}
          </span>
        </div>
        {launchError && <p className="rejection batchnote">{launchError}</p>}
      </section>
      <BatchGrid />
    </>
  );
}
