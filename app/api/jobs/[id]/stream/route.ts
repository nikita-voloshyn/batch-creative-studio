/**
 * SSE stream + orchestrator host — `GET /api/jobs/:id/stream` (component C9, BE).
 *
 * The long-lived stream invocation is what DRIVES generation (architecture §1/§6,
 * product-flow §8): the first opener emits the initial `job.progress{0,0,N}` and
 * starts `runJob` inline, holding the function alive (Vercel Fluid Compute) while
 * Items process and emit to the per-job event bus; this handler forwards those
 * events to the client as `id:`/`event:`/`data:` frames. Concurrent or
 * reconnecting streams MUST NOT start a second run — they just subscribe + replay.
 *
 * ── Context7-verified Next.js (App Router) SSE pattern ──
 *   • Return a `ReadableStream` as the `Response` body with
 *     `Content-Type: text/event-stream`; write frames via the stream controller.
 *   • `export const runtime = "nodejs"` + `export const dynamic = "force-dynamic"`
 *     (never cache) + `export const maxDuration = 300` (raised ceiling to cover an
 *     N≤20 batch; architecture §6.4 / §11). `maxDuration` must be a static literal.
 *   • `request.signal` aborts on client disconnect (Next wires it to the response
 *     lifecycle) AND when `maxDuration` is hit — we listen on it to tear the stream
 *     down and pass it to `runJob` so the orchestrator runs its graceful sweep.
 *   • `Last-Event-ID` request header drives reconnect replay.
 *
 * Exactly-once start is guarded by a START CLAIM + the event bus's monotonic ids
 * (so replay since `Last-Event-ID` loses/duplicates nothing). When Redis is active
 * the claim is a cross-instance `SET bcs:started:{jobId} 1 NX EX 600` — only the
 * instance that wins the `NX` hosts `runJob`; reconnecting/concurrent streams on
 * any instance just subscribe + replay. Without Redis (local/tests) the claim is
 * the original process-global `startedJobs` Set. The event bus stays in-process:
 * the orchestrator and the winning stream run in the same instance, so live
 * delivery is unchanged (cross-instance pub/sub is full-product scope).
 */

import { NextResponse } from "next/server";
import { getJobEventBus, type JobEvent } from "@/lib/orchestrator/event-bus";
import { runJob } from "@/lib/orchestrator/orchestrator";
import { getStateStore } from "@/lib/state";
import { getRedisClient, isRedisConfigured } from "@/lib/state/redis-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Heartbeat keeps the connection warm and detects a dead peer (architecture §6.1). */
const HEARTBEAT_MS = 15_000;

/** Local (non-Redis) guard: a job's orchestration is started by exactly one stream. */
const startedJobs = new Set<string>();

/** TTL on the Redis start claim — comfortably covers a maxDuration run, self-heals. */
const START_CLAIM_TTL_SECONDS = 600;

/**
 * Claim the right to host `runJob` for this job. Returns `true` for exactly one
 * caller. With Redis: an atomic `SET … NX EX` across instances. Without Redis: the
 * in-process `startedJobs` Set (single-instance dev/test).
 */
async function claimJobStart(jobId: string): Promise<boolean> {
  if (isRedisConfigured()) {
    const won = await getRedisClient().set(`bcs:started:${jobId}`, "1", {
      nx: true,
      ex: START_CLAIM_TTL_SECONDS,
    });
    return won === "OK";
  }
  if (startedJobs.has(jobId)) return false;
  startedJobs.add(jobId);
  return true;
}

/** Serialize one bus event into an SSE frame (`id:`/`event:`/`data:`). */
function frame(event: JobEvent): string {
  return `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/** Parse the `Last-Event-ID` reconnect header into a non-negative cursor. */
function parseLastEventId(header: string | null): number {
  if (!header) return 0;
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: jobId } = await params;

  // 404 if the job is unknown (incl. different-instance / recycled — §6.3/§5n).
  // With the shared Redis store this is now resolvable across instances, fixing
  // the "batch no longer available" mismatch between POST and the stream.
  const job = await getStateStore().getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  const total = job.items.length;
  const lastSeenId = parseLastEventId(request.headers.get("last-event-id"));

  // Claim the run-once start BEFORE opening the stream (cross-instance under
  // Redis). The winner hosts runJob inside `start()`; everyone else just streams.
  // Skip the claim for an already-aborted open so it never wins (and strands) the
  // job — `start()` runs synchronously next tick, so its abort check sees the same
  // state, leaving no window between claim and start.
  const startsRun = request.signal.aborted ? false : await claimJobStart(jobId);

  const encoder = new TextEncoder();
  const bus = getJobEventBus(jobId);

  // Hoisted teardown state so both the abort listener and the stream's `cancel`
  // can clean up the same subscription/heartbeat/controller.
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    request.signal.removeEventListener("abort", onAbort);
    try {
      controller?.close();
    } catch {
      // Already closed — nothing to do.
    }
  };

  function onAbort(): void {
    cleanup();
  }

  const write = (chunk: string): void => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // Controller closed under us (client gone mid-write) — stop forwarding.
      cleanup();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;

      if (request.signal.aborted) {
        cleanup();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });

      // Exactly-once orchestration start. The claim winner emits the initial
      // job.progress{0,0,N} (the bit Task 5 left to the stream) and hosts runJob
      // inline; its request.signal drives the orchestrator's graceful sweep on
      // disconnect / maxDuration. Reconnecting/concurrent streams skip this.
      if (startsRun) {
        bus.emit("job.progress", { done: 0, failed: 0, total });
        void runJob(jobId, { signal: request.signal }).catch((error) => {
          console.error(
            JSON.stringify({
              level: "error",
              jobId,
              msg: "runJob crashed",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        });
      }

      // Replay buffered events with id > Last-Event-ID, then subscribe LIVE-ONLY.
      // Both run synchronously (no await between), so no live event can interleave
      // or be lost in the gap (single-threaded JS).
      let terminalReplayed = false;
      for (const event of bus.replaySince(lastSeenId)) {
        write(frame(event));
        if (event.name === "job.done") terminalReplayed = true;
      }
      if (terminalReplayed) {
        cleanup();
        return;
      }

      const liveCursor = bus.lastEventId;
      unsubscribe = bus.subscribe((event) => {
        write(frame(event));
        if (event.name === "job.done") cleanup();
      }, liveCursor);

      heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so frames flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
