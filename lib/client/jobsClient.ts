/**
 * Jobs REST client (component C5, frontend).
 *
 * Typed wrappers over the three non-stream job endpoints (architecture §7.2,
 * product-flow §2.7/§5n/§5p). The client consumes the API over HTTP only; it
 * never imports server modules. Errors carry the HTTP status so callers can
 * distinguish 404 ("gone") from a transient failure.
 *
 *   • `createJob`  → POST /api/jobs            → 201 { jobId }   (+ Idempotency-Key)
 *   • `getSnapshot`→ GET  /api/jobs/:id        → 200 Job · 404 gone
 *   • `retryItem`  → POST .../items/:id/retry  → 200 { ok:true } idempotent · 404 gone
 */

import type { Job } from "@/lib/types";
import type { CreateJobRequest } from "./store";

/** Error from a job endpoint, carrying the HTTP status (404 ⇒ gone). */
export class JobApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "JobApiError";
    this.status = status;
  }
}

/** Best-effort extraction of the server's `{ error }` message; falls back to status. */
async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON body — use the fallback.
  }
  return fallback;
}

/**
 * Create a Job. The `Idempotency-Key` (one UUID per Generate click) lets the
 * server collapse a duplicate submit onto the same `{ jobId }` (product-flow §5o).
 * Returns the new `jobId`; throws `JobApiError` on 4xx/5xx (the caller rolls the
 * optimistic placeholders back — product-flow §5j).
 */
export async function createJob(
  body: CreateJobRequest,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<{ jobId: string }> {
  let res: Response;
  try {
    res = await fetch("/api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new JobApiError(0, "Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    throw new JobApiError(
      res.status,
      await readError(res, `Couldn't start the batch (${res.status}).`),
    );
  }
  return (await res.json()) as { jobId: string };
}

/**
 * Fetch a full `Job` snapshot for reconnect recovery / cold open (architecture
 * §6.3). A 404 (unknown / evicted / different-instance — product-flow §5n)
 * surfaces as `JobApiError` with `status: 404` so the SSE client can stop
 * reconnecting and show the "batch no longer available" terminal state.
 */
export async function getSnapshot(jobId: string, signal?: AbortSignal): Promise<Job> {
  const res = await fetch(`/api/jobs/${jobId}`, { signal });
  if (res.status === 404) {
    throw new JobApiError(404, "This batch is no longer available.");
  }
  if (!res.ok) {
    throw new JobApiError(res.status, await readError(res, `Snapshot failed (${res.status}).`));
  }
  return (await res.json()) as Job;
}

/**
 * Targeted retry of one failed Item. The endpoint is idempotent: a `failed` item
 * is re-driven, any other status is a no-op, and BOTH return `200 { ok: true }`
 * (product-flow §5p). The only error is `404` (unknown job/item), surfaced as
 * `JobApiError` with `status: 404`.
 */
export async function retryItem(
  jobId: string,
  itemId: string,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/items/${itemId}/retry`, {
      method: "POST",
      signal,
    });
  } catch {
    throw new JobApiError(0, "Couldn't reach the server. Try again shortly.");
  }
  if (res.status === 404) {
    throw new JobApiError(404, "This item is no longer available.");
  }
  if (!res.ok) {
    throw new JobApiError(res.status, await readError(res, `Retry failed (${res.status}).`));
  }
  // 200 { ok: true } — success (re-driven or idempotent no-op).
}
