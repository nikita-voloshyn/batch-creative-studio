"use client";

import { useMemo, useState } from "react";
import { MAX_PRODUCT_IMAGES, MAX_REFERENCE_IMAGES } from "@/lib/client/fileValidation";
import {
  type Rejection,
  selectProducts,
  selectReferences,
  useBatchStore,
} from "@/lib/client/store";
import type { UploadKind } from "@/lib/client/uploadClient";
import { DropZone } from "./DropZone";
import { FilePreview } from "./FilePreview";

/**
 * Uploader (component C2, frontend). Two clearly separated buckets — product
 * images (N ≤ 20) and style/mood references (1–2) — each with drag&drop + picker,
 * per-file previews/removal, a count badge, and inline client-validation
 * rejection messages. Caps + validation are enforced in the store; this
 * component renders the surface and shows the reasons.
 *
 * `disabled` locks the whole input surface (add + remove + retry) while a batch
 * is in flight, so a mid-run removal can't revoke a previewUrl that a live tile
 * still points at.
 */
export function Uploader({ disabled = false }: { disabled?: boolean }) {
  const entries = useBatchStore((s) => s.entries);
  const addFiles = useBatchStore((s) => s.addFiles);
  const removeEntry = useBatchStore((s) => s.removeEntry);
  const retryUpload = useBatchStore((s) => s.retryUpload);

  const products = useMemo(() => selectProducts(entries), [entries]);
  const references = useMemo(() => selectReferences(entries), [entries]);

  const [productRejections, setProductRejections] = useState<Rejection[]>([]);
  const [referenceRejections, setReferenceRejections] = useState<Rejection[]>([]);

  const handleFiles = async (files: File[], kind: UploadKind) => {
    const setter = kind === "product" ? setProductRejections : setReferenceRejections;
    const { rejected } = await addFiles(files, kind);
    setter(rejected);
  };

  return (
    <section className="section" aria-label="Upload">
      <div className="section__head">
        <span className="label">Upload</span>
        <span className="meta">PNG · JPG · WEBP · ≤ 10 MB</span>
      </div>

      <div className="stack">
        {/* Product images bucket */}
        <div className="field">
          <div className="section__head">
            <span className="label">Product images</span>
            <span className="meta">
              {products.length} / {MAX_PRODUCT_IMAGES}
            </span>
          </div>
          <DropZone
            label="Drop product images"
            hint={`1–${MAX_PRODUCT_IMAGES} images, one post per image`}
            multiple
            disabled={disabled || products.length >= MAX_PRODUCT_IMAGES}
            disabledLabel={disabled ? "Locked while generating" : "Limit reached"}
            onFiles={(files) => void handleFiles(files, "product")}
          />
          {productRejections.length > 0 && (
            <div className="rejections">
              {productRejections.map((r) => (
                <span key={`${r.name}-${r.reason}`} className="rejection">
                  {r.name} — {r.reason}
                </span>
              ))}
            </div>
          )}
          {products.length > 0 && (
            <div className="thumbs">
              {products.map((entry) => (
                <FilePreview
                  key={entry.id}
                  entry={entry}
                  onRemove={removeEntry}
                  onRetry={retryUpload}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </div>

        {/* Reference images bucket — visually distinct, separately tagged */}
        <div className="field">
          <div className="section__head">
            <span className="label">Reference images</span>
            <span className="meta">
              {references.length} / {MAX_REFERENCE_IMAGES} · style / mood
            </span>
          </div>
          <DropZone
            label="Drop reference images"
            hint={`1–${MAX_REFERENCE_IMAGES} images that set the style`}
            multiple
            disabled={disabled || references.length >= MAX_REFERENCE_IMAGES}
            disabledLabel={disabled ? "Locked while generating" : "Limit reached"}
            onFiles={(files) => void handleFiles(files, "reference")}
          />
          {referenceRejections.length > 0 && (
            <div className="rejections">
              {referenceRejections.map((r) => (
                <span key={`${r.name}-${r.reason}`} className="rejection">
                  {r.name} — {r.reason}
                </span>
              ))}
            </div>
          )}
          {references.length > 0 && (
            <div className="thumbs">
              {references.map((entry) => (
                <FilePreview
                  key={entry.id}
                  entry={entry}
                  onRemove={removeEntry}
                  onRetry={retryUpload}
                  disabled={disabled}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
