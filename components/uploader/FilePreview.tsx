"use client";

import type { UploadEntry, UploadStatus } from "@/lib/client/store";

const STATUS_LABEL: Record<UploadStatus, string> = {
  uploading: "Uploading",
  uploaded: "Uploaded",
  error: "Error",
};

type FilePreviewProps = {
  entry: UploadEntry;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** Locks remove/retry while a batch is in flight (its previewUrl is still on a live tile). */
  disabled?: boolean;
};

/**
 * Per-file preview thumbnail with status + remove control (component C2).
 * The image is shown via its object URL; the status uses the muted ALL-CAPS
 * status register. On upload error, an inline reason + per-file retry appears
 * (product-flow §2.4).
 *
 * While a batch is in flight (`disabled`) the remove/retry controls are locked:
 * removing an entry revokes a previewUrl still referenced by its queued/generating
 * tile, which would blank that tile mid-run.
 */
export function FilePreview({ entry, onRemove, onRetry, disabled = false }: FilePreviewProps) {
  return (
    <div className="thumb">
      <div className="thumb__frame">
        {/* Object-URL preview of a user-selected local file; next/image adds no value here. */}
        {/** biome-ignore lint/performance/noImgElement: local object-URL preview, not a remote asset. */}
        <img className="thumb__img" src={entry.previewUrl} alt={entry.file.name} />
        <button
          type="button"
          className="thumb__remove"
          aria-label={`Remove ${entry.file.name}`}
          onClick={() => onRemove(entry.id)}
          disabled={disabled}
        >
          ×
        </button>
      </div>
      <div className="thumb__row">
        <span className="thumb__name" title={entry.file.name}>
          {entry.file.name}
        </span>
        <span className={`status status--${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
      </div>
      {entry.status === "error" && (
        <div className="thumb__row">
          <span className="rejection">{entry.error}</span>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onRetry(entry.id)}
            disabled={disabled}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
