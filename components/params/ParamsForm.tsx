"use client";

import { useId, useMemo } from "react";
import { selectProducts, useBatchStore } from "@/lib/client/store";
import type { AspectRatio } from "@/lib/types";

const ASPECT_RATIOS: AspectRatio[] = ["1:1", "4:5", "9:16"];

/**
 * Params form (component C3, frontend). Captures the batch params that mirror
 * `Job.params` (architecture §7.1): aspect ratio (`1:1` default), an optional
 * batch brief, and optional per-image caption hints.
 *
 * Per-image hints are rendered here (Task 3 places them in the params form) as a
 * row per product image; each hint is stored on its product entry and resolved
 * into `perImageHints` keyed by the product's `blobUrl` at submit time
 * (product-flow §0 / §2.5, decisions.md 2026-06-26). There is no `Item.captionHint`.
 *
 * `disabled` locks every control while a batch is in flight, so the params can't
 * drift away from what the running batch was launched with.
 */
export function ParamsForm({ disabled = false }: { disabled?: boolean }) {
  const aspectRatio = useBatchStore((s) => s.params.aspectRatio);
  const brief = useBatchStore((s) => s.params.brief);
  const setAspectRatio = useBatchStore((s) => s.setAspectRatio);
  const setBrief = useBatchStore((s) => s.setBrief);
  const setEntryHint = useBatchStore((s) => s.setEntryHint);
  const entries = useBatchStore((s) => s.entries);

  const products = useMemo(() => selectProducts(entries), [entries]);
  const briefId = useId();

  return (
    <section className="section" aria-label="Parameters">
      <div className="section__head">
        <span className="label">Parameters</span>
        {disabled && <span className="meta">Locked for the current run</span>}
      </div>

      <div className="stack">
        {/* Aspect ratio */}
        <fieldset className="segmented-field">
          <legend className="field__label">Format</legend>
          <div className="segmented">
            {ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                className="segmented__option"
                aria-pressed={ratio === aspectRatio}
                onClick={() => setAspectRatio(ratio)}
                disabled={disabled}
              >
                {ratio}
              </button>
            ))}
          </div>
        </fieldset>

        {/* Batch brief */}
        <div className="field">
          <label className="field__label" htmlFor={briefId}>
            Brief <span className="label--muted">(optional)</span>
          </label>
          <textarea
            id={briefId}
            className="textarea"
            placeholder="A short batch-wide brief shared across every post (tone, setting, mood)…"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            disabled={disabled}
          />
        </div>

        {/* Per-image caption hints */}
        {products.length > 0 && (
          <div className="field">
            <span className="field__label">
              Per-image hints <span className="label--muted">(optional)</span>
            </span>
            <p className="meta">A caption hint per product image, applied to that post only.</p>
            <div className="hintlist">
              {products.map((entry) => (
                <div className="hintrow" key={entry.id}>
                  {/* biome-ignore lint/performance/noImgElement: local object-URL preview, not a remote asset. */}
                  <img className="hintrow__thumb" src={entry.previewUrl} alt={entry.file.name} />
                  <input
                    className="input"
                    type="text"
                    placeholder={`Hint for ${entry.file.name}`}
                    aria-label={`Caption hint for ${entry.file.name}`}
                    value={entry.hint}
                    onChange={(e) => setEntryHint(entry.id, e.target.value)}
                    disabled={disabled}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
