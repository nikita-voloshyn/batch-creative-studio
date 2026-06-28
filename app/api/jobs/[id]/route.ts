/**
 * Job snapshot endpoint — `GET /api/jobs/:id` (component C10, backend — BE).
 *
 * Returns a deep-cloned `Job` snapshot (`stateStore.snapshot`) for reconnect
 * recovery and direct open (architecture §6.3, product-flow §5f/§5q). `404` when
 * the job is unknown — including the MVP different-instance / process-recycle case
 * where the in-memory store no longer holds it (product-flow §5n); the client
 * treats that 404 as "batch no longer available" and stops reconnecting.
 */

import { NextResponse } from "next/server";
import { getStateStore } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const snapshot = await getStateStore().snapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
