/**
 * In-process per-job event bus + replay ring buffer (component C18, backend — BE).
 *
 * The orchestrator emits the SSE payloads from `lib/types.ts` (`item.status`,
 * `item.result`, `item.error`, `job.progress`, `job.done`) here as items
 * progress. Task 6's SSE Route Handler subscribes to the SAME per-job bus
 * (`getJobEventBus(jobId)`), replays buffered events after a `Last-Event-ID`, and
 * pipes live events to the client. Both producer (orchestrator) and consumer
 * (SSE writer) live in the same stream invocation, so the in-process bus is
 * reachable without cross-request sharing (architecture §5.8 / §6).
 *
 * Each event carries a monotonic-per-job `id` (the SSE frame `id:`), so a
 * reconnect can replay precisely from `Last-Event-ID`. The bus is process-global
 * and keyed by jobId via the registry below; full-product swaps it for KV/Redis
 * pub-sub (architecture §13).
 */
import type { SseEventMap, SseEventName } from "@/lib/types";

/**
 * One buffered/published event: the SSE frame `id` + name + typed payload. The
 * union of per-name envelopes keeps `name` and `data` correlated (a consumer can
 * narrow on `name` to get the exact payload type).
 */
export type JobEvent = {
  [Name in SseEventName]: { id: number; name: Name; data: SseEventMap[Name] };
}[SseEventName];

type Subscriber = (event: JobEvent) => void;

/** Default ring-buffer depth: comfortably covers an N≤20 batch's full event log. */
const DEFAULT_BUFFER_LIMIT = 2000;

/** Per-job pub/sub with a bounded replay ring buffer. */
export class JobEventBus {
  private seq = 0;
  private readonly buffer: JobEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    readonly jobId: string,
    private readonly bufferLimit: number = DEFAULT_BUFFER_LIMIT,
  ) {}

  /** Highest event id emitted so far (0 before the first emit). */
  get lastEventId(): number {
    return this.seq;
  }

  /**
   * Publish a typed event. Assigns the next monotonic id, appends to the replay
   * buffer (trimming to `bufferLimit`), and fans it out to live subscribers.
   * Returns the stored envelope (the id is useful to the SSE writer).
   */
  emit<K extends SseEventName>(name: K, data: SseEventMap[K]): JobEvent {
    this.seq += 1;
    const event = { id: this.seq, name, data } as JobEvent;
    this.buffer.push(event);
    if (this.buffer.length > this.bufferLimit) this.buffer.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // A failing subscriber (e.g. a closed SSE writer) must never break the
        // emit loop or other subscribers.
      }
    }
    return event;
  }

  /** Buffered events with id strictly greater than `afterId` (reconnect replay). */
  replaySince(afterId: number): JobEvent[] {
    if (afterId <= 0) return [...this.buffer];
    return this.buffer.filter((event) => event.id > afterId);
  }

  /**
   * Subscribe to live events. If `sinceId` is provided, the handler first
   * receives the buffered backlog (id > sinceId) synchronously, then live
   * events. Returns an unsubscribe function.
   */
  subscribe(handler: Subscriber, sinceId = 0): () => void {
    for (const event of this.replaySince(sinceId)) handler(event);
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** Drop all subscribers (the buffer is retained for late snapshot replay). */
  close(): void {
    this.subscribers.clear();
  }
}

/** Process-global registry of per-job buses (MVP in-memory). */
const buses = new Map<string, JobEventBus>();

/** Get (creating if absent) the bus for a job. Producer + SSE writer share it. */
export function getJobEventBus(jobId: string): JobEventBus {
  let bus = buses.get(jobId);
  if (!bus) {
    bus = new JobEventBus(jobId);
    buses.set(jobId, bus);
  }
  return bus;
}

/** Peek without creating — `undefined` if no bus exists for the job yet. */
export function peekJobEventBus(jobId: string): JobEventBus | undefined {
  return buses.get(jobId);
}

/** Tear down and forget a job's bus (cleanup once the stream is done). */
export function deleteJobEventBus(jobId: string): void {
  buses.get(jobId)?.close();
  buses.delete(jobId);
}
