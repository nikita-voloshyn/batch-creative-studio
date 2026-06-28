/**
 * SSE client + reconnect (component C5, frontend).
 *
 * Drives `GET /api/jobs/:id/stream` and dispatches its named events into the
 * batch store. Implemented as a fetch-stream reader (not native `EventSource`)
 * for one load-bearing reason tied to THIS server's design:
 *
 * ── Why a fetch reader, not `EventSource` ──
 * The stream route replays buffered events since `Last-Event-ID`, and if a
 * REPLAYED frame is the terminal `job.done` it flushes and CLOSES the connection
 * immediately. Native `EventSource` cannot seed `Last-Event-ID` on a *fresh*
 * connection — it only sends it on its own internal auto-reconnect. So a
 * post-terminal reopen (a Retry on an already-`done` job, product-flow §2.12/§5d)
 * with `EventSource` would replay the OLD `job.done`, close at once, and miss the
 * new live events. A fetch reader lets us send `Last-Event-ID: <our cursor>`
 * MANUALLY on every (re)open, so the server replays only events AFTER the cursor
 * — the new run streams live until the re-emitted `job.done`. The trade-off is
 * that we own reconnect/backoff and SSE frame parsing ourselves (below).
 *
 * ── No-lost-results guarantee (architecture §6.3 / product-flow §5f) ──
 * On every (re)connect we first fetch `GET /api/jobs/:id` and MERGE it as the
 * base, then open the stream with our `Last-Event-ID` cursor. The snapshot is
 * authoritative server state, so already-shown results survive a drop; replayed
 * + live deltas are applied idempotently keyed by `itemId`. A 404 snapshot
 * (process recycle / different instance — §5n/§5r) terminates as `gone` instead
 * of looping. We stop on `job.done` but retain the cursor so `reopen()` resumes.
 */

import type { Job, SseEventMap, SseEventName } from "@/lib/types";
import { getSnapshot, JobApiError } from "./jobsClient";

/** Connection lifecycle the UI reflects (product-flow §5f/§5n). */
export type StreamConnectionState = "connecting" | "open" | "reconnecting" | "done" | "gone";

/** Callbacks the store provides; the client is transport-only. */
export type JobStreamHandlers = {
  onSnapshot: (job: Job) => void;
  onEvent: <K extends SseEventName>(name: K, data: SseEventMap[K]) => void;
  onConnection: (state: StreamConnectionState) => void;
};

/** Imperative handle returned to the store to reopen (post-retry) or tear down. */
export type JobStreamController = {
  /** Restart the connect loop after it settled on `done` (post-terminal retry). */
  reopen: () => void;
  /** Stop for good: abort any in-flight request and cancel pending reconnects. */
  close: () => void;
};

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const SSE_EVENT_NAMES: ReadonlySet<string> = new Set<SseEventName>([
  "item.status",
  "item.result",
  "item.error",
  "job.progress",
  "job.done",
]);

type RunOutcome = "done" | "drop" | "gone";

type ParsedFrame = { id?: number; event?: string; data: string };

/** Parse one SSE frame (text between blank lines). Returns null for comments/heartbeats. */
function parseFrame(raw: string): ParsedFrame | null {
  let id: number | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "id") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) id = n;
    } else if (field === "event") {
      event = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (event === undefined && dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

function isSseEventName(name: string | undefined): name is SseEventName {
  return name !== undefined && SSE_EVENT_NAMES.has(name);
}

/**
 * Open the job stream and keep it reconciled. Returns immediately; the connect
 * loop runs in the background and pushes state through `handlers`.
 */
export function openJobStream(jobId: string, handlers: JobStreamHandlers): JobStreamController {
  let lastEventId = 0;
  let stopped = false;
  let settled = false; // reached `done`/`gone`; loop idle but reopenable from `done`
  let attempt = 0;
  let abort: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const dispatch = (eventName: string | undefined, data: string): boolean => {
    if (!isSseEventName(eventName)) return false;
    let payload: SseEventMap[SseEventName];
    try {
      payload = JSON.parse(data) as SseEventMap[SseEventName];
    } catch {
      return false;
    }
    // The event-name ↔ payload pairing is guaranteed by the server contract
    // (lib/types.ts SseEventMap); narrow via a single typed hand-off.
    handlers.onEvent(eventName, payload as never);
    return eventName === "job.done";
  };

  /** One full attempt: snapshot-merge, then read the stream until done or drop. */
  async function runOnce(): Promise<RunOutcome> {
    abort = new AbortController();

    // 1. Snapshot first — the authoritative base so no shown result is lost.
    let job: Job;
    try {
      job = await getSnapshot(jobId, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return "done"; // closed under us
      if (err instanceof JobApiError && err.status === 404) return "gone";
      return "drop";
    }
    handlers.onSnapshot(job);

    // 2. Open the stream with our manual Last-Event-ID cursor.
    let res: Response;
    try {
      res = await fetch(`/api/jobs/${jobId}/stream`, {
        headers: lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {},
        signal: abort.signal,
        cache: "no-store",
      });
    } catch {
      return abort.signal.aborted ? "done" : "drop";
    }
    if (res.status === 404) return "gone";
    if (!res.ok || !res.body) return "drop";

    handlers.onConnection("open");

    // 3. Read + parse frames; track the cursor on each `id:`.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseFrame(raw);
          if (parsed) {
            if (parsed.id !== undefined) lastEventId = parsed.id;
            if (dispatch(parsed.event, parsed.data)) sawDone = true;
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      if (abort.signal.aborted) return "done"; // intentional close
      return "drop";
    }

    return sawDone ? "done" : "drop";
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      reconnectTimer = setTimeout(resolve, ms);
    });
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      handlers.onConnection(attempt === 0 ? "connecting" : "reconnecting");
      const outcome = await runOnce();
      if (stopped) return;

      if (outcome === "gone") {
        settled = true;
        handlers.onConnection("gone");
        return;
      }
      if (outcome === "done") {
        settled = true;
        attempt = 0;
        handlers.onConnection("done");
        return;
      }

      // Dropped (network / process blip): exponential backoff + jitter, then retry.
      attempt += 1;
      const backoff =
        Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1)) +
        Math.random() * RECONNECT_BASE_MS;
      await delay(backoff);
    }
  }

  void loop();

  return {
    reopen() {
      // Only meaningful after the loop settled on `done` (a post-terminal retry).
      // `gone` is irrecoverable in MVP; an active loop ignores reopen.
      if (stopped || !settled) return;
      settled = false;
      attempt = 0;
      void loop();
    },
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      abort?.abort();
    },
  };
}
