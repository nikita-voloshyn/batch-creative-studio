"use client";

import { useState } from "react";
import { downloadSinglePost } from "@/lib/client/export";

/**
 * Single-post download control (component C6, frontend). Shown on a DONE tile;
 * saves that post at full resolution by fetching the cross-origin Blob image and
 * forcing a `<a download>` save (see `lib/client/export.ts`). Local UI state only
 * — the store stays the read-model authority and isn't touched here.
 */
export function DownloadPostButton({ imageUrl, index }: { imageUrl: string; index: number }) {
  const [state, setState] = useState<"idle" | "working" | "error">("idle");

  async function handleClick() {
    if (state === "working") return;
    setState("working");
    try {
      await downloadSinglePost(imageUrl, index);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      className="btn btn--ghost tile__download"
      onClick={() => void handleClick()}
      disabled={state === "working"}
      aria-busy={state === "working"}
    >
      {state === "working" ? "Saving…" : state === "error" ? "Retry download" : "Download"}
    </button>
  );
}
