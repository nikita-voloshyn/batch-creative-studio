"use client";

import { type DragEvent, useRef, useState } from "react";
import { ALLOWED_CONTENT_TYPES } from "@/lib/client/fileValidation";

const ACCEPT = ALLOWED_CONTENT_TYPES.join(",");

type DropZoneProps = {
  /** ALL-CAPS section label, e.g. "PRODUCT IMAGES". */
  label: string;
  /** Small muted helper line under the label. */
  hint: string;
  multiple: boolean;
  disabled?: boolean;
  /** Prompt shown in place of "Drop images…" while disabled (cap reached vs. run in flight). */
  disabledLabel?: string;
  onFiles: (files: File[]) => void;
};

/**
 * Drag&drop surface + file picker (component C2, frontend). Presentational:
 * it collects `File[]` and hands them to `onFiles`; validation, caps, and
 * upload live in the store. Disabled when the bucket's cap is reached.
 *
 * Rendered as a native `<button>` so it is keyboard- and screen-reader-accessible
 * for free; the drop handlers ride on the same element and a hidden `<input
 * type="file">` is the picker.
 */
export function DropZone({
  label,
  hint,
  multiple,
  disabled = false,
  disabledLabel = "Limit reached",
  onFiles,
}: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);

  const open = () => {
    if (!disabled) inputRef.current?.click();
  };

  const onDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!disabled) setActive(true);
  };

  const onDragLeave = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    // Only clear the highlight when the pointer truly leaves the zone — moving over a
    // child element still fires dragleave on the parent and would otherwise flicker.
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setActive(false);
  };

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setActive(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  return (
    <>
      <button
        type="button"
        className={`dropzone${active ? " dropzone--active" : ""}${
          disabled ? " dropzone--disabled" : ""
        }`}
        disabled={disabled}
        aria-label={label}
        onClick={open}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className="label label--muted">
          {disabled ? disabledLabel : "Drop images or click to browse"}
        </span>
        <span className="dropzone__hint">{hint}</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          // Reset so re-selecting the same file fires onChange again.
          e.target.value = "";
        }}
      />
    </>
  );
}
