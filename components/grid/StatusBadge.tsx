"use client";

import type { TileStatus } from "@/lib/client/store";

/**
 * Tile status label (component C4, frontend). Renders the item state as an
 * ALL-CAPS label in the muted/functional status register (product-flow §3,
 * visual language). `.status--*` colors live in `app/globals.css`; the
 * `.status` class applies the uppercase transform.
 */

const STATUS_LABEL: Record<TileStatus, string> = {
  queued: "Queued",
  generating: "Generating",
  done: "Done",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: TileStatus }) {
  return <span className={`status status--${status}`}>{STATUS_LABEL[status]}</span>;
}
