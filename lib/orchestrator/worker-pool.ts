/**
 * Bounded-concurrency worker pool (component C13, backend — BE).
 *
 * Drains a queue of items with at most `concurrency` (`POOL_SIZE`) running at
 * once. A slot frees the instant a worker resolves and immediately pulls the next
 * queued item, so one slow/failing item never blocks its siblings (FR-3.3,
 * architecture §5.2, product-flow §6). The pool is generic and side-effect-free;
 * the orchestrator supplies a `worker` that processes one Item end-to-end and
 * never throws (it terminalizes its own failures). The pool still isolates any
 * unexpected throw so a stray rejection cannot abort the whole drain.
 */

export type WorkerPoolOptions = {
  /** Stop pulling NEW items once this fires (in-flight items run to completion). */
  signal?: AbortSignal;
  /** Reported when a worker throws unexpectedly (the orchestrator should not). */
  onUnexpectedError?: (item: unknown, error: unknown) => void;
};

/**
 * Run `worker` over `items` with bounded concurrency. Resolves when every item
 * has been processed (or no further items are started after an abort). Never
 * rejects: worker rejections are isolated and surfaced via `onUnexpectedError`.
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  options: WorkerPoolOptions = {},
): Promise<void> {
  const total = items.length;
  if (total === 0) return;
  const width = Math.max(1, Math.min(concurrency, total));

  let nextIndex = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = nextIndex++;
      if (index >= total) return;
      const item = items[index];
      try {
        await worker(item, index);
      } catch (error) {
        // The orchestrator's worker catches its own errors; this is a safety net
        // so a single unexpected throw never starves the remaining items.
        options.onUnexpectedError?.(item, error);
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => runner()));
}
