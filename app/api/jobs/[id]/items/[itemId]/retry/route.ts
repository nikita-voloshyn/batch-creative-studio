/**
 * Targeted retry endpoint — `POST /api/jobs/:id/items/:itemId/retry` (C11, BE).
 *
 * Atomically moves a `failed` Item back to `queued` (`stateStore.casItemStatus`)
 * and re-drives ONLY that Item via the orchestrator's per-item path
 * (`retryItem`), emitting the same `item.*` / `job.*` events to the per-job bus so
 * any open stream updates live (architecture §5.5/§7.2, product-flow §3/§4/§5d/§5p).
 *
 * Idempotent by contract (architecture §7.2 / product-flow §5p):
 *   • 404 — unknown job or item.
 *   • 200 `{ ok: true }` — for any existing item. A `failed` item is re-driven
 *     (CAS won); a non-`failed` item (succeeded/running/queued, or a lost CAS on
 *     a concurrent double-click) is an idempotent no-op. Retry never returns a
 *     conflict — the only error is 404.
 *
 * The re-drive runs in the background via `after()` so the response returns
 * promptly; on Vercel (Fluid Compute) `after` keeps the function alive until the
 * re-drive finishes. The open SSE stream — not this response — carries progress.
 */

import { after, NextResponse } from "next/server";
import { getJobEventBus } from "@/lib/orchestrator/event-bus";
import { retryItem } from "@/lib/orchestrator/orchestrator";
import { getStateStore } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
): Promise<NextResponse> {
  const { id: jobId, itemId } = await params;
  const store = getStateStore();

  const job = await store.getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  const item = await store.getItem(jobId, itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found." }, { status: 404 });
  }
  // Idempotent no-op for a non-retryable item (succeeded/running/queued):
  // retry only ever acts on a `failed` item; otherwise return 200 with no work.
  if (item.status !== "failed") {
    return NextResponse.json({ ok: true });
  }

  // Atomic CAS dedups concurrent double-clicks: exactly one caller wins. With the
  // Redis store this runs as a server-side Lua flip, so two requests racing on
  // different instances cannot both transition `failed → queued`.
  const won = await store.casItemStatus(jobId, itemId, "failed", "queued");
  if (!won) {
    // A concurrent retry already moved it out of `failed`; idempotent no-op.
    return NextResponse.json({ ok: true });
  }

  // Re-open a terminal job immediately so a snapshot taken right after this
  // response reflects `running` (product-flow §4).
  if (job.status !== "running") await store.setJobStatus(jobId, "running");

  // Tell open streams the tile went back to `queued` (product-flow §3 failed→queued).
  getJobEventBus(jobId).emit("item.status", { itemId, status: "queued" });

  // Re-drive in the background; the open stream forwards the live events.
  after(async () => {
    try {
      await retryItem(jobId, itemId);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          jobId,
          itemId,
          msg: "retryItem crashed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });

  return NextResponse.json({ ok: true });
}
