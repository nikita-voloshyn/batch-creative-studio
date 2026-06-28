"use client";

import { useState } from "react";
import { useBatchStore } from "@/lib/client/store";
import { downloadBatchZip, type ExportPost } from "@/lib/client/zip";

/**
 * Whole-batch "Download all (zip)" control (component C6, frontend). Lives in the
 * batch toolbar. It gathers every SUCCEEDED tile from the store, packs them
 * client-side into a zip with a `MANIFEST.txt` (see `lib/client/zip.ts`), and is
 * DISABLED until at least one item has succeeded — the label shows the live
 * count ("Download all · N posts") so the user knows what they'll get. Available
 * progressively (no need to wait for the whole batch to settle).
 */
export function DownloadAllButton() {
  const items = useBatchStore((s) => s.batch.items);
  const jobId = useBatchStore((s) => s.batch.jobId);
  const [state, setState] = useState<"idle" | "working" | "error">("idle");

  const succeeded: ExportPost[] = [];
  items.forEach((item, index) => {
    if (item.status === "done" && item.result?.imageUrl) {
      succeeded.push({
        index,
        imageUrl: item.result.imageUrl,
        providerId: item.result.providerId,
        usedImageReference: item.result.usedImageReference,
      });
    }
  });

  const count = succeeded.length;
  const disabled = count === 0 || state === "working";

  async function handleClick() {
    if (disabled) return;
    setState("working");
    try {
      await downloadBatchZip(succeeded, jobId, items.length);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  const label =
    state === "working"
      ? "Zipping…"
      : state === "error"
        ? "Zip failed — retry"
        : `Download all · ${count} ${count === 1 ? "post" : "posts"}`;

  return (
    <button
      type="button"
      className="btn"
      onClick={() => void handleClick()}
      disabled={disabled}
      aria-busy={state === "working"}
    >
      {label}
    </button>
  );
}
